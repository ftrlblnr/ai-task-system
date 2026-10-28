import { DEFAULT_CALL, type AssistantReplyResult, type ReplyCallConfig } from '../assistant/assistant-reply.service';

// Голос на едином агенте (A4, docs/AGENT_AND_MEETINGS.md): транскрипт идёт в
// тот же AssistantReplyService, что и текст, — те же инструменты, права,
// отмена и защита от повторов. Здесь — чистые правила (тестируются без ключа).

// VOICE_ENGINE=agent включает новый путь; ARMS-правило «новое — сначала
// руководству»: create_task в чате только у руководства, сотрудник на агенте
// потерял бы голосовую постановку задач — у него остаётся прежний разбор.
export function voiceEngineFor(flag: string | undefined, isManagerRole: boolean): 'agent' | 'legacy' {
  return flag === 'agent' && isManagerRole ? 'agent' : 'legacy';
}

// Тот же быстрый Haiku, что у чата, но отдельной строкой в «Расходе ИИ».
export const VOICE_AGENT_CALL: ReplyCallConfig = { ...DEFAULT_CALL, feature: 'voice.agent' };

// Повтор на Opus — только когда быстрая модель явно промахнулась: команда,
// а не вопрос, и ни одного инструмента. Прежний разбор эскалировал так же
// (LOW/уточнение → Opus), эта эвристика его заменяет.
export const VOICE_ESCALATION_CALL: ReplyCallConfig = {
  model: 'claude-opus-5-5',
  effort: 'low',
  maxTokens: 16000,
  maxToolRounds: DEFAULT_CALL.maxToolRounds,
  feature: 'voice.agent.escalation',
};

// Глагол-команда в начале слова. \b в JS не работает с кириллицей — граница
// слова через «не буква».
const ACTION_VERB = /(?:^|[^а-яёa-z])(постав|созда|перенес|перенос|удали|назнач|поруч|запиш|напомн|добав|отмен|передай|передать|смени|измени|закрой|закрыть|сдвин)/i;

export function looksLikeCommand(transcript: string): boolean {
  return ACTION_VERB.test(transcript);
}

export function needsEscalation(transcript: string, reply: Pick<AssistantReplyResult, 'text' | 'toolCalls'>): boolean {
  if (reply.toolCalls.length > 0) return false;
  // Вопрос пользователю («Кому поставить?») — нормальный ответ на неполную
  // команду, не промах.
  if (reply.text.includes('?')) return false;
  return looksLikeCommand(transcript);
}

// Файлы, которые инструменты сгенерировали в этом ходе (выгрузка задач) —
// привязываются к сообщению ассистента, иначе FilesCleanupCron удалит их
// через сутки как брошенные.
export function generatedFileIds(reply: Pick<AssistantReplyResult, 'toolCalls'>): string[] {
  return reply.toolCalls.flatMap((c) => (c.result.tool === 'export_tasks_xlsx' && 'file' in c.result ? [c.result.file.fileId] : []));
}
