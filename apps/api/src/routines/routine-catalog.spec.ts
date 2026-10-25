import type Anthropic from '@anthropic-ai/sdk';
import { buildRoutineBlock, capNoticeDue, capReached, noticesToMarkdown, NOTIFY_TOOL_NAME, parseNotify, routineTools, runSummary, usageTokens } from './routine-catalog';

const tool = (name: string) => ({ name, input_schema: { type: 'object' as const, properties: {} } }) as Anthropic.Tool;

describe('регламент: правила прогона', () => {
  it('инструменты — только чтение, без исключённых, notify_owner в пассивном', () => {
    const all = ['get_tasks', 'search_emails', 'remember', 'export_tasks_xlsx', 'legal_ask', 'propose_routine'].map(tool);
    const isWrite = (n: string) => n === 'remember' || n === 'propose_routine';
    expect(routineTools(all, isWrite, null, false).map((t) => t.name)).toEqual(['get_tasks', 'search_emails']);
    expect(routineTools(all, isWrite, ['search_emails', 'remember'], true).map((t) => t.name)).toEqual(['search_emails', NOTIFY_TOOL_NAME]);
  });

  it('блок регламента говорит, что делать в пассивном режиме', () => {
    const passive = buildRoutineBlock({ title: 'Письма', instructions: '  Проверь письма  ', passive: true });
    expect(passive).toContain('[routine «Письма»]\nПроверь письма');
    expect(passive).toContain(NOTIFY_TOOL_NAME);
    expect(buildRoutineBlock({ title: 'Сводка', instructions: 'x', passive: false })).not.toContain(NOTIFY_TOOL_NAME);
  });

  it('notify_owner: пустое отбрасывается, неизвестная важность — info', () => {
    expect(parseNotify({ text: '  ', severity: 'urgent' })).toBeNull();
    expect(parseNotify({ text: 'Письмо без ответа', severity: 'страшно' })).toEqual({ text: 'Письмо без ответа', severity: 'info' });
    expect(noticesToMarkdown([{ text: 'А', severity: 'urgent' }, { text: 'Б', severity: 'info' }])).toBe('🔴 А\n\nБ');
  });

  it('токены, лимит и сводка', () => {
    expect(usageTokens({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } as Anthropic.Usage)).toEqual({ tokensIn: 1110, tokensOut: 50 });
    expect(capReached(5000, 5000)).toBe(true);
    expect(capReached(4999, 5000)).toBe(false);
    expect(capReached(1e9, null)).toBe(false);
    const now = new Date('2026-10-25T10:00:00Z');
    expect(capNoticeDue(null, now)).toBe(true);
    expect(capNoticeDue(new Date('2026-10-20T10:00:00Z'), now)).toBe(false);
    expect(capNoticeDue(new Date('2026-10-18T10:00:00Z'), now)).toBe(true);
    expect(runSummary('**Итог:** всё   хорошо')).toBe('Итог: всё хорошо');
    expect(runSummary('а'.repeat(400))).toHaveLength(280);
  });
});
