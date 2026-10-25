import type Anthropic from '@anthropic-ai/sdk';
import { RoutineChannel, RoutineMode, RoutineRunStatus, RoutineState, type RoutineRun } from '@prisma/client';
import { RoutineRunExecutionService } from './routine-run-execution.service';

// Прогон регламента без БД и без ключа: prisma, инструменты, модель и
// Telegram — подставные.

function message(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;

function setup(opts: { mode?: RoutineMode; channel?: RoutineChannel; cap?: number | null; usedTokens?: number; capNotifiedAt?: Date | null; telegramId?: string | null; replies: Anthropic.Message[] }) {
  const routine = {
    id: 'r1',
    title: 'Письма без ответа',
    ownerId: 'u1',
    prompt: 'Проверь письма без ответа больше двух дней',
    skill: null,
    mode: opts.mode ?? RoutineMode.PASSIVE,
    channel: opts.channel ?? RoutineChannel.TELEGRAM,
    weeklyTokenCap: opts.cap ?? null,
    capNotifiedAt: opts.capNotifiedAt ?? null,
    state: RoutineState.ACTIVE,
    owner: { id: 'u1', email: 'o@x', role: 'OWNER', status: 'ACTIVE', telegramId: opts.telegramId === undefined ? 'tg1' : opts.telegramId },
  };
  const runUpdates: { status?: RoutineRunStatus; summary?: string; tokensIn?: number }[] = [];
  const routineUpdates: Record<string, unknown>[] = [];
  const conversations: string[] = [];
  const messagesCreated: unknown[] = [];
  const tx = {
    conversation: { create: (a: { data: { title: string } }) => (conversations.push(a.data.title), Promise.resolve({ id: 'c1' })) },
    message: { create: (a: unknown) => (messagesCreated.push(a), Promise.resolve({ id: `msg${messagesCreated.length}` })) },
  };
  const prisma = {
    routine: {
      findUnique: () => Promise.resolve(routine),
      update: (a: { data: Record<string, unknown> }) => (routineUpdates.push(a.data), Promise.resolve({})),
    },
    routineRun: {
      update: (a: { data: { status?: RoutineRunStatus } }) => (runUpdates.push(a.data), Promise.resolve({})),
      aggregate: () => Promise.resolve({ _sum: { tokensIn: opts.usedTokens ?? 0, tokensOut: 0 } }),
    },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const executed: string[] = [];
  const tools = {
    buildTools: () => Promise.resolve([{ name: 'search_emails' }, { name: 'remember' }, { name: 'export_tasks_xlsx' }]),
    execute: (name: string) => (executed.push(name), Promise.resolve({ tool: 'search_emails', items: [], totalCount: 0 })),
  };
  const sent: string[] = [];
  const telegram = { sendMessage: (_id: string | null, t: string) => (sent.push(t), Promise.resolve()) };
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const replies = [...opts.replies];
  const client = {
    messages: {
      create: (p: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(JSON.parse(JSON.stringify(p)) as Anthropic.MessageCreateParamsNonStreaming);
        return Promise.resolve(replies.shift());
      },
    },
  };
  const service = new RoutineRunExecutionService(
    prisma as never,
    { getOrThrow: () => 'k' } as never,
    tools as never,
    undefined,
    undefined,
    undefined,
    telegram as never,
  );
  (service as unknown as { client: unknown }).client = client;
  const run = { id: 'run1', routineId: 'r1', attempts: 1 } as RoutineRun;
  return { service, run, runUpdates, routineUpdates, conversations, messagesCreated, executed, sent, requests };
}

describe('прогон регламента', () => {
  it('пассивный без находок — SILENT, никому ничего', async () => {
    const t = setup({ replies: [message([toolUse('t1', 'search_emails', {})]), message([text('Тихо')])] });
    await t.service.process(t.run);
    expect(t.runUpdates.at(-1)?.status).toBe(RoutineRunStatus.SILENT);
    expect(t.sent).toHaveLength(0);
    expect(t.conversations).toHaveLength(0);
    expect(t.executed).toEqual(['search_emails']);
    // Инструменты прогона: только чтение, без выгрузки, + notify_owner.
    expect(t.requests[0].tools?.map((x) => x.name)).toEqual(['search_emails', 'notify_owner']);
    expect(t.runUpdates.at(-1)?.tokensIn).toBe(200);
  });

  it('пассивный с находкой — одно сообщение в Telegram', async () => {
    const t = setup({
      replies: [message([toolUse('t1', 'notify_owner', { text: 'Асель ждёт ответа 3 дня', severity: 'important' })]), message([text('Готово')])],
    });
    await t.service.process(t.run);
    expect(t.runUpdates.at(-1)?.status).toBe(RoutineRunStatus.DONE);
    expect(t.sent).toEqual(['Письма без ответа\n\n❗ Асель ждёт ответа 3 дня']);
    expect(t.conversations).toHaveLength(0);
  });

  it('инструмент вне списка не исполняется', async () => {
    const t = setup({ mode: RoutineMode.ACTIVE, replies: [message([toolUse('t1', 'remember', { text: 'x' })]), message([text('Итог')])] });
    await t.service.process(t.run);
    expect(t.executed).toEqual([]);
    const last = t.requests[1].messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    expect(last[0].is_error).toBe(true);
  });

  it('активный в ленту — разговор с ответом', async () => {
    const t = setup({ mode: RoutineMode.ACTIVE, channel: RoutineChannel.FEED, replies: [message([text('**Итог недели**: всё в срок')])] });
    await t.service.process(t.run);
    expect(t.conversations[0]).toMatch(/^Письма без ответа · /);
    expect(t.messagesCreated).toHaveLength(2);
    expect(t.sent).toHaveLength(0);
    expect(t.runUpdates.at(-1)?.summary).toBe('Итог недели: всё в срок');
  });

  it('Telegram не привязан — результат всё равно в ленте', async () => {
    const t = setup({ mode: RoutineMode.ACTIVE, telegramId: null, replies: [message([text('Итог')])] });
    await t.service.process(t.run);
    expect(t.conversations).toHaveLength(1);
  });

  it('лимит исчерпан — SKIPPED_CAP без вызова модели, уведомление раз в неделю', async () => {
    const t = setup({ cap: 5000, usedTokens: 6000, replies: [] });
    await t.service.process(t.run);
    expect(t.runUpdates.at(-1)?.status).toBe(RoutineRunStatus.SKIPPED_CAP);
    expect(t.requests).toHaveLength(0);
    expect(t.sent[0]).toContain('упёрся в недельный лимит');
    expect(t.routineUpdates[0].capNotifiedAt).toBeInstanceOf(Date);

    const again = setup({ cap: 5000, usedTokens: 6000, capNotifiedAt: new Date(), replies: [] });
    await again.service.process(again.run);
    expect(again.sent).toHaveLength(0);
  });
});
