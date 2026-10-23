import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '@nestjs/config';
import { AnswerStructuringService } from '../reception/answer-structuring.service';
import { isWhisperArtifact } from '../reception/whisper-artifacts';
import { DraftExtractionService } from '../voice/draft-extraction.service';
import { WhisperService } from '../voice/whisper.service';
import { AssistantReplyService, buildDateContext } from '../assistant/assistant-reply.service';
import { AssistantToolsService } from '../assistant/assistant-tools.service';

// Проверочный набор ИИ (владелец 21.10.2026): реальные случаи, на которых
// ИИ уже ошибался или которые легко сломать сменой модели/промпта. Прогон
// ходит в настоящие API (Anthropic + OpenAI) и стоит денег — запускать
// вручную перед сменой модели или промпта, не в CI:
//   docker exec -w /repo/apps/api docker-api-1 node dist/src/ai-eval/run-eval.js
// Ничего не пишет в БД. Код выхода 1 — есть проваленные случаи.

interface Case {
  group: string;
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const EMPLOYEES = [
  { id: 'e1', fullName: 'Сергеев Азамат' },
  { id: 'e2', fullName: 'Иванова Ирина Петровна' },
  { id: 'e3', fullName: 'Ким Арман' },
];
const VOCABULARY = 'Сергеев Азамат, Иванова Ирина Петровна, Ким Арман, Ньюлайн, вентшахта';
const QUESTION = { title: 'Согласование отпуска', description: 'Прошу согласовать отпуск с 1 по 14 ноября' };

const config = new ConfigService(process.env);
const structuring = new AnswerStructuringService(config);
const drafts = new DraftExtractionService(config);
const whisper = new WhisperService(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function check(ok: boolean, detail: string) {
  return { ok, detail };
}

function structureCase(name: string, raw: string, test: (out: string) => boolean): Case {
  return {
    group: 'приёмная',
    name,
    run: async () => {
      const out = await structuring.structure(raw, QUESTION);
      return check(test(out), out);
    },
  };
}

function artifactCase(text: string, expected: boolean): Case {
  return {
    group: 'приёмная',
    name: `фильтр тишины: «${text}»`,
    run: () => Promise.resolve(check(isWhisperArtifact(text) === expected, String(isWhisperArtifact(text)))),
  };
}

function draftCase(
  name: string,
  transcript: string,
  test: (d: { type: string; action?: string; assigneeId?: string | null; dueDate?: string | null }[]) => boolean,
): Case {
  return {
    group: 'голосовые команды',
    name,
    run: async () => {
      const out = await drafts.extract(transcript, EMPLOYEES, 'OWNER', [], [], null, [], 'eval');
      const list = out.drafts as unknown as { type: string; action?: string; assigneeId?: string | null; dueDate?: string | null }[];
      const detail = list.map((d) => `${d.type}/${d.action ?? ''} ${d.assigneeId ?? ''} ${d.dueDate ?? ''}`.trim()).join(' | ');
      return check(test(list), `${detail}${out.escalatedToStrongModel ? ' (эскалация)' : ''}`);
    },
  };
}

let toolsCache: Anthropic.Tool[] | null = null;
async function assistantTools(): Promise<Anthropic.Tool[]> {
  if (!toolsCache) {
    const svc = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
    Object.assign(svc, {
      prisma: { competency: { findMany: () => Promise.resolve([]) } },
      mailStore: { listMailboxesByEmployee: () => Promise.resolve([]) },
    });
    toolsCache = await svc.buildTools({ id: 'eval', role: 'OWNER' } as never);
  }
  return toolsCache;
}

function assistantCase(text: string, expectedTool: string | null): Case {
  return {
    group: 'ассистент',
    name: `«${text}» → ${expectedTool ?? 'ответ без инструмента'}`,
    run: async () => {
      const reply = new AssistantReplyService(config, {} as never) as unknown as {
        streamOnce: (m: Anthropic.MessageParam[], t: Anthropic.Tool[], e: undefined, s: undefined) => Promise<Anthropic.Message>;
      };
      const message = await reply.streamOnce(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildDateContext() },
              { type: 'text', text },
            ],
          },
        ],
        await assistantTools(),
        undefined,
        undefined,
      );
      const used = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use').map((b) => b.name);
      const ok = expectedTool === null ? used.length === 0 : used.includes(expectedTool);
      return check(ok, used.join(', ') || 'без инструмента');
    },
  };
}

function wav(samples: number[], rate = 16000): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

async function speech(text: string): Promise<Buffer> {
  const r = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'wav' });
  return Buffer.from(await r.arrayBuffer());
}

function sttCase(name: string, audio: () => Promise<Buffer>, test: (text: string) => boolean): Case {
  return {
    group: 'распознавание речи',
    name,
    run: async () => {
      const { text } = await whisper.transcribe(await audio(), 'audio/wav', 'eval.wav', VOCABULARY);
      return check(test(text), JSON.stringify(text));
    },
  };
}

const CASES: Case[] = [
  structureCase('проверочная фраза не выбрасывается', 'Проверка, это тестовый ответ голосом.', (o) => /провер/i.test(o)),
  structureCase('«да» остаётся ответом', 'да', (o) => o === 'Да.'),
  structureCase(
    'слова-паразиты убраны, решение и срок на месте',
    'ну короче э-э согласовано отпуск оформляйте только дела передайте Азамату до пятницы',
    (o) => /согласовано/i.test(o) && /пятниц/i.test(o) && !/короче/i.test(o),
  ),
  structureCase(
    'оговорка «то есть нет» исправлена, ничего не дописано',
    'значит так первое отпуск согласую второе до отпуска закройте отчёт по объекту третье замещать будет Ирина то есть нет Азамат',
    (o) => /азамат/i.test(o) && !/ирин/i.test(o) && /1\./.test(o) && /3\./.test(o),
  ),
  artifactCase('Продолжение следует...', true),
  artifactCase('Субтитры сделал DimaTorzok', true),
  artifactCase('Подготовьте субтитры к видео для презентации заказчику до пятницы', false),
  draftCase(
    'задача сотруднику со сроком',
    'поставь задачу Азамату подготовить отчёт по объекту до пятницы',
    (d) => d.some((x) => x.type === 'task_action' && x.action === 'create' && x.assigneeId === 'e1' && !!x.dueDate),
  ),
  draftCase(
    'напоминание себе на время',
    'напомни мне завтра в десять позвонить в банк',
    (d) => d.some((x) => x.type === 'task_action' && x.action === 'create' && /T10:00/.test(x.dueDate ?? '')),
  ),
  draftCase('вопрос — не действие', 'какие задачи сейчас просрочены', (d) => d.every((x) => x.type === 'chat')),
  draftCase(
    'исполнитель по имени в косвенном падеже',
    'Ирине нужно согласовать договор поставки, срок в понедельник',
    (d) => d.some((x) => x.type === 'task_action' && x.assigneeId === 'e2'),
  ),
  assistantCase('какие у меня просроченные задачи?', 'get_tasks'),
  assistantCase('что у меня завтра в календаре?', 'get_events'),
  assistantCase('найди встречу, где обсуждали бюджет', 'search_meetings'),
  assistantCase('выгрузи мои задачи в excel', 'export_tasks_xlsx'),
  assistantCase('привет', null),
  sttCase('тишина → пусто', () => Promise.resolve(wav(new Array<number>(64000).fill(0))), (t) => isWhisperArtifact(t)),
  sttCase(
    'тихий шум → пусто',
    () => Promise.resolve(wav(Array.from({ length: 64000 }, () => Math.round((Math.random() - 0.5) * 300)))),
    (t) => isWhisperArtifact(t),
  ),
  sttCase(
    'термины компании из словаря',
    () => speech('Поручить сводку по вентшахтам на объекте Ньюлайн, срок завтра.'),
    (t) => /ньюлайн/i.test(t) && /вентшахт/i.test(t),
  ),
];

async function main() {
  let failed = 0;
  for (const c of CASES) {
    const started = Date.now();
    let result: { ok: boolean; detail: string };
    try {
      result = await c.run();
    } catch (err) {
      result = { ok: false, detail: `ошибка: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!result.ok) failed++;
    const ms = String(Date.now() - started).padStart(5);
    console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${ms} мс  [${c.group}] ${c.name}\n               → ${result.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} пройдено`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
