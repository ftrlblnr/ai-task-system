import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Conversation, FileArtifact, Message, MessagePart, MessageRole, MessageStatus, MessagePartType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from '../files/files.service';
import { AssistantReplyService, type ReplyHistoryItem, type AssistantReplyResult } from './assistant-reply.service';
import { buildAssistantParts, toolActivityLabel, type MessagePartInput } from './assistant-render';
import { SendMessageDto } from './dto/send-message.dto';
import type { MarkdownPartData, TaskCardData, EventCardData, FilePartData } from './dto/message-part-data.dto';

// Сколько предыдущих сообщений разговора отдавать модели как историю — тот
// же порядок величины, что VOICE_HISTORY_LIMIT в voice.service.ts, здесь не
// делится по времени (в отличие от voice): один Conversation — один
// логически непрерывный диалог, а не заметки, между которыми могло пройти
// много часов.
const HISTORY_LIMIT = 20;

export type MessageWithParts = Message & { parts: MessagePart[] };

// Внутренний (Prisma-представление) событийный контракт стриминга —
// AssistantChatController переводит его в публичный StreamEvent
// (dto/stream-event.dto.ts) на границе, тем же приёмом, что
// toResponseMessage для non-streaming ответа (assistant-response.mapper.ts)
// — сервис не должен знать формат HTTP-ответа. userMessage на
// message.started (Phase F.2, аудит 17.09.2026) — авторитетное
// user-сообщение с сервера: до этого фронтенд ничем не заменял свой
// optimistic-бабл до самого следующего getMessages()/refresh.
export type InternalStreamEvent =
  | { event: 'message.started'; messageId: string; userMessage: MessageWithParts }
  | { event: 'part.started'; messageId: string; partId: string }
  | { event: 'part.delta'; messageId: string; partId: string; delta: string }
  | { event: 'part.completed'; messageId: string; partId: string; part: MessagePart }
  | { event: 'tool.started'; messageId: string; tool: string }
  | { event: 'tool.completed'; messageId: string; tool: string; label: string }
  | { event: 'message.completed'; messageId: string; message: MessageWithParts }
  | { event: 'message.failed'; messageId: string; error: string };

const ASSISTANT_TEXT_PART_ID = 'assistant-text';
const GENERIC_FAILURE_MESSAGE = 'Не удалось получить ответ ассистента. Попробуйте ещё раз.';
const ATTACHMENT_UNAVAILABLE_MESSAGE = 'Один из прикреплённых файлов больше недоступен. Прикрепите файл заново.';

// Phase F.2 (аудит 17.09.2026, P1.8) — два одновременных запроса с одним
// clientRequestId оба проходят findExistingPair → "не найдено", затем оба
// пытаются prisma.message.create() — ровно один упадёт на unique
// constraint (conversationId_clientRequestId для user-сообщения,
// replyToMessageId для assistant-сообщения после P1.7). Без recovery это
// была бы 500-ошибка для "проигравшего" запроса вместо идемпотентного
// ответа.
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Phase F.1 (стабилизация, аудит 16.09.2026) — раньше история для модели
// собиралась только из MARKDOWN-частей: карточки задач/событий/файлы,
// показанные пользователю, физически не попадали в следующий контекст —
// "расскажи подробнее про первую [задачу из карточек]" модель не могла
// связать ни с чем. Компактное текстовое представление, не сырой JSON
// MessagePart.data целиком — модель получает id/title/статус, не весь
// внутренний объект. tool_activity/error намеренно пропускаются — статус
// "проверяю задачи" или текст ошибки не несут содержательного контекста
// для следующего вопроса пользователя.
export function serializeMessageForModelContext(parts: MessagePart[]): string {
  return parts
    .map((p) => {
      switch (p.type) {
        case MessagePartType.MARKDOWN:
          return (p.data as unknown as MarkdownPartData).content;
        case MessagePartType.TASK_CARD: {
          const d = p.data as unknown as TaskCardData;
          return `[shown_task]\nid=${d.taskId}\ntitle=${d.title}\nstatus=${d.status}`;
        }
        case MessagePartType.EVENT_CARD: {
          const d = p.data as unknown as EventCardData;
          return `[shown_event]\nid=${d.eventId}\ntitle=${d.title}\nstartAt=${d.startAt}`;
        }
        case MessagePartType.FILE: {
          const d = p.data as unknown as FilePartData;
          return `[file]\nid=${d.fileId}\nname=${d.name}\nmimeType=${d.mimeType}`;
        }
        default:
          return null;
      }
    })
    .filter((s): s is string => Boolean(s))
    .join('\n');
}

// Phase F.2 (аудит 17.09.2026, P0.1) — раньше текущее сообщение уходило
// модели как dto.text без единого упоминания только что прикреплённых
// файлов: "посмотри этот документ" + report.pdf модель видела буквально
// как "посмотри этот документ", без имени/типа файла. Отдельный тег
// [attached_file] (не [file] из истории, см. serializeMessageForModelContext
// выше) — чтобы не путать "показано в истории" с "прикреплено только что
// в этом же сообщении". Только метаданные — содержимое файла не читается
// и не передаётся, это осознанно вне рамок этого шага.
//
// Stage 2, Phase Q hardening (24.09.2026) — liveContext: недавний голосовой
// разговор GPT-Live ("Мы обсуждали IDAT" / ответ Live), который нигде больше
// не сохраняется (в ленту попадает только делегированная команда). Уходит
// ТОЛЬКО модели, отдельным блоком [live_context], тем же приёмом, что
// [attached_file]: сохранённый текст сообщения остаётся чистой командой, а
// "из этого/ему/там" модель раскрывает по блоку. Приходит только из
// внутреннего кода (LiveService), не из HTTP DTO.
export function serializeCurrentUserTurn(text: string, attachments: FilePartData[], liveContext?: string): string {
  const blocks = attachments.map((a) => `[attached_file]\nid=${a.fileId}\nname=${a.name}\nmimeType=${a.mimeType}\nsize=${a.size}`);
  const context = liveContext?.trim() ? [`[live_context]\n${liveContext.trim()}\n[/live_context]`] : [];
  return [...context, text, ...blocks].join('\n\n');
}

function attachmentPartsOf(parts: MessagePart[]): FilePartData[] {
  return parts.filter((p) => p.type === MessagePartType.FILE).map((p) => p.data as unknown as FilePartData);
}

// Stage 2. Phase B — персист + один обычный (без tool use) ответ. Phase C
// — tool-calling (get_tasks/get_events, см. assistant-tools.service.ts).
// Phase E — то же самое, но с прогрессом по мере готовности (streamMessage),
// поверх ОДНОГО и того же AssistantReplyService.runReply — никакой
// отдельной бизнес-логики для стриминга, только другой способ её показать.
// Phase F.1 — стабилизация (см. комментарии у replyToMessageId/loadHistory/
// serializeMessageForModelContext ниже). Phase F.2 — current-turn
// attachments, идемпотентность под гонкой, provider-neutral storage (см.
// files/), явные ошибки на недоступные вложения. Существующий voice-путь
// (VoiceService, /voice/parse) не переиспользует эти таблицы и не
// изменяется этим сервисом.
@Injectable()
export class AssistantChatService {
  private readonly logger = new Logger(AssistantChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reply: AssistantReplyService,
    private readonly files: FilesService,
  ) {}

  // MVP (Stage 2 §4.1): у каждого сотрудника должен быть хотя бы один
  // диалог — при первом обращении список пуст, создаём диалог лениво прямо
  // здесь, а не отдельным onboarding-шагом или отдельным эндпоинтом.
  // Полноценный список из нескольких чатов уже возможен архитектурно
  // (createConversation ниже), просто фронтенду пока некуда показывать
  // больше одного.
  async listConversations(user: AuthenticatedUser): Promise<Conversation[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { employeeId: user.id },
      orderBy: { updatedAt: 'desc' },
    });
    if (conversations.length > 0) return conversations;
    return [await this.createConversation(user)];
  }

  async createConversation(user: AuthenticatedUser, title?: string): Promise<Conversation> {
    return this.prisma.conversation.create({
      data: { employeeId: user.id, title: title || null },
    });
  }

  // Stage 2, Phase H — точка входа для голоса (VoiceService): в отличие от
  // listConversations (список для UI, лениво заводит первый диалог), здесь
  // нужен ровно один разговор без списка — "тот самый", в который дальше
  // пишутся голосовые реплики. findFirst по updatedAt: если у сотрудника
  // когда-нибудь появится больше одного диалога, голос продолжит писать в
  // последний активный, а не в случайный.
  async getOrCreatePrimaryConversation(user: AuthenticatedUser): Promise<Conversation> {
    const existing = await this.prisma.conversation.findFirst({
      where: { employeeId: user.id },
      orderBy: { updatedAt: 'desc' },
    });
    return existing ?? this.createConversation(user);
  }

  private async findOwnedConversation(user: AuthenticatedUser, conversationId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    // 404, не 403 — чужому сотруднику не подтверждаем даже факт
    // существования чужого разговора (тот же принцип, что validateTarget
    // в voice.service.ts для чужих/неизвестных id).
    if (!conversation || conversation.employeeId !== user.id) {
      throw new NotFoundException('Диалог не найден');
    }
    return conversation;
  }

  // Публичный тонкий алиас — AssistantChatController зовёт его ДО открытия
  // SSE-потока (Phase E), чтобы 404 на чужой разговор пришёл обычным
  // JSON-ответом, а не потерялся бы внутри уже открытого text/event-stream.
  async assertOwnedConversation(user: AuthenticatedUser, conversationId: string): Promise<void> {
    await this.findOwnedConversation(user, conversationId);
  }

  // Публичный тонкий алиас — тот же приём, что assertOwnedConversation:
  // AssistantChatController зовёт его ДО открытия SSE-потока (Phase F.2,
  // аудит 17.09.2026, P2.11), чтобы ошибка на недоступное вложение пришла
  // обычным JSON-ответом, а не потерялась бы внутри уже открытого потока.
  // resolveAttachments всё равно вызывается второй раз внутри streamMessage
  // (узкое TOCTOU-окно между этой проверкой и самой отправкой не устраняется
  // полностью — тот же уровень гарантий, что уже есть у owner-проверки).
  async assertAttachmentsAvailable(user: AuthenticatedUser, attachmentIds: string[] | undefined): Promise<void> {
    await this.resolveAttachments(user, attachmentIds);
  }

  // Stage 2, Phase Q hardening — недавняя переписка для session.input GPT-Live.
  // Только завершённые сообщения и только MARKDOWN-части: карточки, статусы
  // инструментов, файлы и ошибки (то есть "внутренности" tool-вызовов) в Live
  // не уходят. Владение разговором проверяется как везде.
  async getRecentMessages(
    user: AuthenticatedUser,
    conversationId: string,
    limit: number,
  ): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
    await this.findOwnedConversation(user, conversationId);
    const rows = await this.prisma.message.findMany({
      where: { conversationId, status: MessageStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { parts: { where: { type: MessagePartType.MARKDOWN }, orderBy: { order: 'asc' } } },
    });
    return rows
      .reverse()
      .map((m) => ({
        role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
        text: m.parts
          .map((p) => (p.data as unknown as MarkdownPartData).content)
          .filter((c): c is string => typeof c === 'string')
          .join(' ')
          .trim(),
      }))
      .filter((m) => m.text);
  }

  async getMessages(user: AuthenticatedUser, conversationId: string): Promise<MessageWithParts[]> {
    await this.findOwnedConversation(user, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
  }

  // Идемпотентность (Stage 2 §29) — тот же clientRequestId в этом же
  // разговоре означает "это тот же самый запрос отправки". Общий для
  // sendMessage/streamMessage. ВАЖНО: короткое замыкание срабатывает,
  // только если вызывающий код сам проверит assistantMessage?.status ===
  // COMPLETED — эта функция лишь ищет пару, решение "повторять или нет"
  // принимает вызывающий (см. комментарий у sendMessage ниже про
  // FAILED-ответы).
  //
  // Phase F.1 (аудит 16.09.2026) — пара ищется через явный
  // replyToMessageId, не через "первое assistant-сообщение с createdAt
  // позже user-сообщения": на двух устройствах, отправляющих сообщения
  // почти одновременно, время не гарантирует правильное сопоставление —
  // ответ B физически мог прийти раньше ответа на A.
  private async findExistingPair(
    conversationId: string,
    clientRequestId: string | undefined,
  ): Promise<{ userMessage: MessageWithParts; assistantMessage: MessageWithParts | null } | null> {
    if (!clientRequestId) return null;
    const userMessage = await this.prisma.message.findUnique({
      where: { conversationId_clientRequestId: { conversationId, clientRequestId } },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    if (!userMessage) return null;
    const assistantMessage = await this.prisma.message.findFirst({
      where: { replyToMessageId: userMessage.id },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return { userMessage, assistantMessage };
  }

  // excludeMessageId — Phase F.1 (аудит 16.09.2026): раньше history
  // грузилась ПОСЛЕ того, как user-сообщение уже было в БД (в т.ч. при
  // retry — то же сообщение, что мы сейчас же и обрабатываем), поэтому
  // текущий вопрос попадал в historyForModel, а затем runReply ещё раз
  // добавлял dto.text отдельным элементом — модель получала вопрос
  // дважды. Явное исключение убирает дубль, не завязываясь на то, вызван
  // ли loadHistory до или после создания строки.
  private async loadHistory(conversationId: string, excludeMessageId: string): Promise<ReplyHistoryItem[]> {
    const history = await this.prisma.message.findMany({
      where: { conversationId, id: { not: excludeMessageId } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return history
      .reverse()
      .map((m) => ({
        role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
        text: serializeMessageForModelContext(m.parts),
      }))
      .filter((h) => h.text);
  }

  // Phase F — вложения. Phase F.2 (аудит 17.09.2026, P2.11) — раньше
  // невалидный/чужой id молча пропускался (тот же fail-safe принцип, что
  // невалидный assigneeId в voice.service.ts) — пользователь никак не
  // узнавал, что вложение не попало в сообщение. Явная ошибка теперь,
  // один и тот же безопасный текст для "не существует"/"чужой"/"удалён"
  // (не раскрываем, какой из случаев — спека §30, тот же принцип, что
  // 404 без подтверждения существования чужого ресурса).
  private async resolveAttachments(user: AuthenticatedUser, attachmentIds: string[] | undefined): Promise<FileArtifact[]> {
    if (!attachmentIds?.length) return [];
    const resolved: FileArtifact[] = [];
    for (const id of attachmentIds) {
      try {
        resolved.push(await this.files.assertOwnedFile(user, id));
      } catch {
        throw new BadRequestException(ATTACHMENT_UNAVAILABLE_MESSAGE);
      }
    }
    return resolved;
  }

  private buildUserMessagePartsInput(text: string, attachments: FileArtifact[]): MessagePartInput[] {
    const parts: MessagePartInput[] = [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: text } }];
    attachments.forEach((f, i) => {
      parts.push({
        type: MessagePartType.FILE,
        order: i + 1,
        data: { fileId: f.id, name: f.name, mimeType: f.mimeType, size: f.size },
      });
    });
    return parts;
  }


  // Phase F.2 (аудит 17.09.2026, P1.8) — общий путь создания user-сообщения
  // для sendMessage/streamMessage (раньше был продублирован в обоих).
  // Recovery на P2002: если два одновременных запроса с одним
  // clientRequestId оба прошли findExistingPair → null, ровно один упадёт
  // на unique(conversationId, clientRequestId) — "проигравший" не получает
  // 500, а переиспользует строку победителя (тот же результат, что и
  // обычный idempotent-повтор).
  //
  // Phase H.1 (внешний аудит 20.09.2026, P1) — create()+linkAttachments()
  // раньше были двумя отдельными вызовами БД: сбой процесса между ними
  // оставлял FILE-часть, ссылающуюся на FileArtifact с messageId: null —
  // FilesCleanupCron реаплет такой файл как orphan через 24 часа, оставляя
  // в истории постоянно нерабочую ссылку. `$transaction` с callback (не
  // array-форма — updateMany нужен id только что созданного сообщения,
  // недоступный до его создания) делает обе операции атомарными.
  private async createUserMessageIdempotent(conversationId: string, dto: SendMessageDto, attachments: FileArtifact[]): Promise<MessageWithParts> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            role: MessageRole.USER,
            status: MessageStatus.COMPLETED,
            clientRequestId: dto.clientRequestId || null,
            parts: { create: this.buildUserMessagePartsInput(dto.text, attachments) },
          },
          include: { parts: { orderBy: { order: 'asc' } } },
        });
        if (attachments.length > 0) {
          await tx.fileArtifact.updateMany({
            where: { id: { in: attachments.map((f) => f.id) } },
            data: { conversationId, messageId: created.id },
          });
        }
        return created;
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && dto.clientRequestId) {
        const winner = await this.prisma.message.findUnique({
          where: { conversationId_clientRequestId: { conversationId, clientRequestId: dto.clientRequestId } },
          include: { parts: { orderBy: { order: 'asc' } } },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async resolveOrCreateUserMessage(user: AuthenticatedUser, conversationId: string, dto: SendMessageDto, existingUserMessage: MessageWithParts | undefined): Promise<MessageWithParts> {
    if (existingUserMessage) return existingUserMessage;
    const attachments = await this.resolveAttachments(user, dto.attachmentIds);
    return this.createUserMessageIdempotent(conversationId, dto, attachments);
  }

  // Тот же приём, что createUserMessageIdempotent — после P1.7
  // (replyToMessageId стал @unique) два одновременных запроса могут оба
  // пройти "assistant-сообщения ещё нет" и оба попытаться его создать;
  // "проигравший" переиспользует строку победителя вместо 500.
  // generatedFileIds (Phase H.1, внешний аудит 20.09.2026, P1) — та же
  // атомарность create+link, что теперь у createUserMessageIdempotent
  // (см. её комментарий): сбой между созданием ASSISTANT-сообщения и
  // привязкой FileArtifact оставлял бы FILE-часть с "осиротевшей" ссылкой.
  private async createAssistantMessageIdempotent(
    userMessageId: string,
    data: Prisma.MessageUncheckedCreateInput,
    generatedFileIds: string[] = [],
  ): Promise<MessageWithParts> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({ data, include: { parts: { orderBy: { order: 'asc' } } } });
        if (generatedFileIds.length > 0) {
          await tx.fileArtifact.updateMany({
            where: { id: { in: generatedFileIds } },
            data: { conversationId: data.conversationId, messageId: created.id },
          });
        }
        return created;
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const winner = await this.prisma.message.findFirst({
          where: { replyToMessageId: userMessageId },
          include: { parts: { orderBy: { order: 'asc' } } },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // Тот же приём для ветки "сообщение уже существует, обновляем на месте"
  // (retry после FAILED) — update()+linkAttachments() атомарно, не двумя
  // отдельными вызовами.
  private async updateAssistantMessageWithAttachments(
    id: string,
    data: Prisma.MessageUncheckedUpdateInput,
    conversationId: string,
    generatedFileIds: string[],
  ): Promise<MessageWithParts> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.message.update({ where: { id }, data, include: { parts: { orderBy: { order: 'asc' } } } });
      if (generatedFileIds.length > 0) {
        await tx.fileArtifact.updateMany({
          where: { id: { in: generatedFileIds } },
          data: { conversationId, messageId: updated.id },
        });
      }
      return updated;
    });
  }

  // Stage 2, Phase G — export_tasks_xlsx создаёт FileArtifact ещё внутри
  // tool loop (AssistantReplyService), до того как готов сам финальный
  // ответ. Если reply()/streamReply() упадёт уже после этого — файл
  // останется с messageId: null и будет удалён существующим
  // FilesCleanupCron (Phase F.1) как обычный orphan upload, тем же путём,
  // ничего отдельно на этот случай не пишем.
  private generatedFileIdsFrom(toolCalls: AssistantReplyResult['toolCalls']): string[] {
    const ids: string[] = [];
    for (const c of toolCalls) {
      if (!('error' in c.result) && c.result.tool === 'export_tasks_xlsx') {
        ids.push(c.result.file.fileId);
      }
    }
    return ids;
  }

  private sumToolExecutionMs(toolCalls: { durationMs: number }[]): number {
    return toolCalls.reduce((sum, c) => sum + c.durationMs, 0);
  }

  // P0 (внешний аудит 20.09.2026) — идемпотентность выше (unique
  // constraint + P2002-recovery) защищает СТРОКИ в БД от дублей, но не
  // мешает двум конкурентным запросам с одним clientRequestId ОБА пройти
  // findExistingPair до того, как первый успеет записать assistant-строку,
  // и оба реально вызвать this.reply.reply()/streamReply() — сегодня это
  // лишний вызов Anthropic + дубль сгенерированного файла
  // (export_tasks_xlsx), после появления мутирующих write-tools
  // (create_task/send_email и т.п.) — дублирующееся реальное действие.
  //
  // In-memory Map, а не БД compare-and-set/распределённая блокировка —
  // API работает одним процессом (тот же принцип, что уже принят для
  // cron-задач, см. комментарий в FilesCleanupCron/других крон-сервисах:
  // "на одном инстансе это не проблема"). Ключ — userMessage.id, не
  // clientRequestId/conversationId: к моменту вызова claimOrJoin оба
  // конкурентных запроса УЖЕ сошлись на одном и том же id через
  // resolveOrCreateUserMessage (unique constraint ниже по стеку),
  // единственный надёжный ключ дедупликации, включая ретрай уже
  // существующего FAILED-сообщения (клиент шлёт тот же clientRequestId —
  // тот же userMessage.id).
  //
  // Корректность в один процесс: между чтением карты (`.get`) и записью в
  // неё (`.set`) ниже нет ни одного `await` — Node не может прервать
  // синхронный участок кода на середине ради другого таска, поэтому даже
  // два "по-настоящему одновременных" вызова (их await'ы выше по стеку
  // могут разрешиться в любом порядке) обязательно обрабатываются друг за
  // другом, не вперемешку: чей бы continuation ни исполнился первым, он
  // успеет полностью пройти чтение+запись карты до того, как второй начнёт
  // свой. Если API когда-нибудь станет многопроцессным — этот механизм
  // перестанет координировать между процессами и потребуется настоящая
  // распределённая блокировка (Postgres advisory lock и т.п.).
  private readonly inFlightAssistantReplies = new Map<string, Promise<MessageWithParts>>();

  private claimOrJoin(
    userMessage: MessageWithParts,
    run: () => Promise<MessageWithParts>,
  ): { result: Promise<MessageWithParts>; claimed: boolean } {
    const existing = this.inFlightAssistantReplies.get(userMessage.id);
    if (existing) return { result: existing, claimed: false };

    const promise = run().finally(() => {
      // Снимаем только свою запись — если под тем же id уже успела
      // появиться чья-то ещё (в норме невозможно, но не полагаемся на это
      // без страховки), не затираем её.
      if (this.inFlightAssistantReplies.get(userMessage.id) === promise) {
        this.inFlightAssistantReplies.delete(userMessage.id);
      }
    });
    this.inFlightAssistantReplies.set(userMessage.id, promise);
    return { result: promise, claimed: true };
  }

  async sendMessage(
    user: AuthenticatedUser,
    conversationId: string,
    dto: SendMessageDto,
    options?: { liveContext?: string },
  ): Promise<{ userMessage: MessageWithParts; assistantMessage: MessageWithParts }> {
    await this.findOwnedConversation(user, conversationId);

    // Короткое замыкание — только на настоящий успех. Раньше (Phase B/C)
    // оно срабатывало на любой статус, включая FAILED — то есть повторная
    // отправка после реального сбоя ассистента никогда не повторяла
    // попытку, просто отдавала тот же FAILED результат снова. Теперь
    // FAILED считается "настоящего ответа ещё не было" — ниже идём на
    // новую попытку, обновляя ту же строку (не дублируя её).
    const existing = await this.findExistingPair(conversationId, dto.clientRequestId);
    if (existing?.assistantMessage?.status === MessageStatus.COMPLETED) {
      return { userMessage: existing.userMessage, assistantMessage: existing.assistantMessage };
    }

    const userMessage = await this.resolveOrCreateUserMessage(user, conversationId, dto, existing?.userMessage);

    // claimOrJoin (см. комментарий там) — если конкурентный запрос с тем
    // же clientRequestId уже выполняет реальный вызов ассистента для этого
    // же userMessage, присоединяемся к его результату вместо повторного
    // вызова Anthropic/tools.
    const { result } = this.claimOrJoin(userMessage, () =>
      this.runNonStreamingReply(user, conversationId, userMessage, existing?.assistantMessage ?? undefined, dto, options?.liveContext),
    );
    const assistantMessage = await result;

    return { userMessage, assistantMessage };
  }

  // Тело реального вызова ассистента — выполняется не более одного раза на
  // userMessage одновременно, см. claimOrJoin. Извлечено из sendMessage
  // (Phase F.3, P0) без изменения самой логики создания/обновления строки.
  private async runNonStreamingReply(
    user: AuthenticatedUser,
    conversationId: string,
    userMessage: MessageWithParts,
    existingAssistantMessage: MessageWithParts | undefined,
    dto: SendMessageDto,
    liveContext?: string,
  ): Promise<MessageWithParts> {
    const requestId = randomUUID();
    const t0 = Date.now();

    const history = await this.loadHistory(conversationId, userMessage.id);
    const currentTurnText = serializeCurrentUserTurn(dto.text, attachmentPartsOf(userMessage.parts), liveContext);

    let assistantMessage: MessageWithParts;
    let toolNames: string[] = [];
    let toolExecutionMs = 0;
    try {
      const result = await this.reply.reply(currentTurnText, history, user, conversationId, userMessage.id);
      toolNames = result.toolCalls.map((c) => c.name);
      toolExecutionMs = this.sumToolExecutionMs(result.toolCalls);
      const partsInput = buildAssistantParts(result);
      const generatedFileIds = this.generatedFileIdsFrom(result.toolCalls);
      assistantMessage = existingAssistantMessage
        ? await this.updateAssistantMessageWithAttachments(
            existingAssistantMessage.id,
            { status: MessageStatus.COMPLETED, requestId, replyToMessageId: userMessage.id, parts: { deleteMany: {}, create: partsInput } },
            conversationId,
            generatedFileIds,
          )
        : await this.createAssistantMessageIdempotent(
            userMessage.id,
            {
              conversationId,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.COMPLETED,
              requestId,
              replyToMessageId: userMessage.id,
              parts: { create: partsInput },
            },
            generatedFileIds,
          );
    } catch (err) {
      // Техническая ошибка — только в логи (Stage 2 §5.6/§32); пользователю
      // уходит безопасный текст через ErrorPart.
      this.logger.error(`assistant reply reqId=${requestId} failed: ${err instanceof Error ? err.message : err}`);
      const errorPart = [{ type: MessagePartType.ERROR, order: 0, data: { message: GENERIC_FAILURE_MESSAGE } }];
      assistantMessage = existingAssistantMessage
        ? await this.prisma.message.update({
            where: { id: existingAssistantMessage.id },
            data: { status: MessageStatus.FAILED, requestId, replyToMessageId: userMessage.id, parts: { deleteMany: {}, create: errorPart } },
            include: { parts: { orderBy: { order: 'asc' } } },
          })
        : await this.createAssistantMessageIdempotent(userMessage.id, {
            conversationId,
            role: MessageRole.ASSISTANT,
            status: MessageStatus.FAILED,
            requestId,
            replyToMessageId: userMessage.id,
            parts: { create: errorPart },
          });
    }

    await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });

    this.logger.log(
      `assistant chat reqId=${requestId} conversationId=${conversationId} status=${assistantMessage.status} ` +
        `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} toolExecutionMs=${toolExecutionMs} ` +
        `chatRequestMs=${Date.now() - t0}`,
    );

    return assistantMessage;
  }

  // Phase E — тот же поток, что sendMessage, но прогресс отдаётся через
  // emit() по мере готовности вместо одного блокирующего ответа. abortSignal
  // — обрыв соединения с клиентом (AssistantChatController слушает
  // res.on('close')) прерывает реальный HTTP-запрос к Anthropic.
  //
  // P0 (внешний аудит 20.09.2026, см. комментарий у claimOrJoin) — раньше
  // recovery через createAssistantMessageIdempotent корректно находил
  // чужую STREAMING-строку, но код это никак не использовал: короткое
  // замыкание проверяло только status === COMPLETED, поэтому "проигравший"
  // запрос всё равно шёл в this.reply.streamReply() второй раз. Теперь
  // claimOrJoin решает, кто реально стримит, ДО создания строки.
  async streamMessage(
    user: AuthenticatedUser,
    conversationId: string,
    dto: SendMessageDto,
    emit: (event: InternalStreamEvent) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await this.findOwnedConversation(user, conversationId);

    const existing = await this.findExistingPair(conversationId, dto.clientRequestId);
    if (existing?.assistantMessage?.status === MessageStatus.COMPLETED) {
      emit({ event: 'message.started', messageId: existing.assistantMessage.id, userMessage: existing.userMessage });
      emit({ event: 'message.completed', messageId: existing.assistantMessage.id, message: existing.assistantMessage });
      return;
    }

    // Phase F.2 (аудит 17.09.2026, P2.10) — раньше здесь хранился только
    // userMessageId (строка): стриминговым событиям хватало id, полный
    // объект был не нужен. Теперь message.started несёт полное
    // авторитетное user-сообщение (нужно и для этого, и для
    // serializeCurrentUserTurn ниже) — тот же общий путь создания, что и
    // sendMessage (resolveOrCreateUserMessage).
    const userMessage = await this.resolveOrCreateUserMessage(user, conversationId, dto, existing?.userMessage);

    const { result, claimed } = this.claimOrJoin(userMessage, () =>
      this.runStreamingReply(user, conversationId, userMessage, existing?.assistantMessage ?? undefined, dto, emit, abortSignal),
    );

    if (claimed) {
      // Победитель — runStreamingReply сам эмитит все события по мере
      // готовности, здесь просто дожидаемся его завершения (ошибку он уже
      // обработал и отэмитил сам, см. её catch).
      await result.catch(() => undefined);
      return;
    }

    // Проигравший гонку (Phase F.3, P0) — конкурентный запрос с тем же
    // clientRequestId уже реально стримит у Anthropic. Не открываем второй
    // параллельный вызов на ту же пару: подхватываем результат победителя
    // без live-дельт (их некуда было бы врезать в уже пройденную историю
    // этого запроса) — клиент всё равно получает корректный финальный
    // ответ вместо дубля исполнения.
    emit({ event: 'message.started', messageId: userMessage.id, userMessage });
    try {
      const finalMessage = await result;
      if (finalMessage.status === MessageStatus.FAILED) {
        emit({ event: 'message.failed', messageId: finalMessage.id, error: GENERIC_FAILURE_MESSAGE });
      } else {
        emit({ event: 'message.completed', messageId: finalMessage.id, message: finalMessage });
      }
    } catch {
      // runStreamingReply бросает только в вырожденном случае, когда не
      // удалось даже создать assistant-строку (см. её комментарий) — тогда
      // делиться победителю нечем.
      emit({ event: 'message.failed', messageId: userMessage.id, error: GENERIC_FAILURE_MESSAGE });
    }
  }

  // Тело реального стрима — выполняется не более одного раза на
  // userMessage одновременно, см. claimOrJoin. Извлечено из streamMessage
  // (Phase F.3, P0) без изменения самой логики создания/обновления строки
  // и порядка emit()-событий для победителя.
  private async runStreamingReply(
    user: AuthenticatedUser,
    conversationId: string,
    userMessage: MessageWithParts,
    existingAssistantMessage: MessageWithParts | undefined,
    dto: SendMessageDto,
    emit: (event: InternalStreamEvent) => void,
    abortSignal: AbortSignal,
  ): Promise<MessageWithParts> {
    const requestId = randomUUID();
    const t0 = Date.now();

    const history = await this.loadHistory(conversationId, userMessage.id);
    const currentTurnText = serializeCurrentUserTurn(dto.text, attachmentPartsOf(userMessage.parts));

    let assistantMessage: MessageWithParts;
    try {
      assistantMessage =
        existingAssistantMessage ??
        (await this.createAssistantMessageIdempotent(userMessage.id, {
          conversationId,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.STREAMING,
          requestId,
          replyToMessageId: userMessage.id,
          parts: { create: [] },
        }));
    } catch (err) {
      // isUniqueConstraintError-путь внутри createAssistantMessageIdempotent
      // уже пытался восстановиться — если дошло сюда, восстановиться не
      // удалось (или ошибка не про гонку). claimOrJoin уже гарантирует, что
      // это единственный вызов на userMessage в этом процессе — P2002 сюда
      // в норме не долетит, оставлено как страховка. Делиться с
      // "проигравшими" нечем (строка не создана вовсе) — пробрасываем, их
      // catch в streamMessage отэмитит свой message.failed.
      this.logger.error(`assistant reply reqId=${requestId} failed to create assistant message: ${err instanceof Error ? err.message : err}`);
      emit({ event: 'message.started', messageId: userMessage.id, userMessage });
      emit({ event: 'message.failed', messageId: userMessage.id, error: GENERIC_FAILURE_MESSAGE });
      throw err;
    }

    // Узкий вырожденный случай (Phase F.2, P1.8) — recovery нашёл чужую
    // (уже существующую) assistant-строку не в статусе STREAMING/этого же
    // запроса: это значит, что параллельный запрос с тем же
    // clientRequestId уже её создал/обновил в прошлый раз (например,
    // COMPLETED из давно завершённой отдельной попытки, найденной уже
    // после того, как findExistingPair в streamMessage её почему-то не
    // поймал). claimOrJoin уже не даёт сюда попасть двум одновременным
    // вызовам — эта проверка осталась как страховка на случай, если
    // recovery когда-нибудь всё же сработает.
    if (assistantMessage.status === MessageStatus.COMPLETED) {
      emit({ event: 'message.started', messageId: assistantMessage.id, userMessage });
      emit({ event: 'message.completed', messageId: assistantMessage.id, message: assistantMessage });
      return assistantMessage;
    }

    emit({ event: 'message.started', messageId: assistantMessage.id, userMessage });
    emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });

    const toolNames: string[] = [];
    let firstTokenAt: number | null = null;
    try {
      const result = await this.reply.streamReply(
        currentTurnText,
        history,
        user,
        conversationId,
        userMessage.id,
        (e) => {
          if (e.type === 'text-reset') {
            emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });
          } else if (e.type === 'text-delta') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            emit({ event: 'part.delta', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID, delta: e.delta });
          } else if (e.type === 'tool-started') {
            emit({ event: 'tool.started', messageId: assistantMessage.id, tool: e.name });
          } else if (e.type === 'tool-completed') {
            toolNames.push(e.name);
            emit({ event: 'tool.completed', messageId: assistantMessage.id, tool: e.name, label: toolActivityLabel(e.result).label });
          }
        },
        abortSignal,
      );

      const toolExecutionMs = this.sumToolExecutionMs(result.toolCalls);
      const partsInput = buildAssistantParts(result);
      const updated = await this.updateAssistantMessageWithAttachments(
        assistantMessage.id,
        { status: MessageStatus.COMPLETED, requestId, parts: { deleteMany: {}, create: partsInput } },
        conversationId,
        this.generatedFileIdsFrom(result.toolCalls),
      );
      for (const part of updated.parts) {
        emit({ event: 'part.completed', messageId: assistantMessage.id, partId: part.id, part });
      }
      emit({ event: 'message.completed', messageId: assistantMessage.id, message: updated });

      await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      this.logger.log(
        `assistant chat reqId=${requestId} conversationId=${conversationId} status=COMPLETED ` +
          `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} toolExecutionMs=${toolExecutionMs} ` +
          `timeToFirstTokenMs=${firstTokenAt !== null ? firstTokenAt - t0 : 'n/a'} chatRequestMs=${Date.now() - t0}`,
      );
      return updated;
    } catch (err) {
      this.logger.error(`assistant reply reqId=${requestId} failed (streaming): ${err instanceof Error ? err.message : err}`);
      const failed = await this.prisma.message.update({
        where: { id: assistantMessage.id },
        data: {
          status: MessageStatus.FAILED,
          requestId,
          parts: { deleteMany: {}, create: [{ type: MessagePartType.ERROR, order: 0, data: { message: GENERIC_FAILURE_MESSAGE } }] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
      emit({ event: 'message.failed', messageId: assistantMessage.id, error: GENERIC_FAILURE_MESSAGE });
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      this.logger.log(
        `assistant chat reqId=${requestId} conversationId=${conversationId} status=FAILED streaming=true chatRequestMs=${Date.now() - t0}`,
      );
      return failed;
    }
  }
}
