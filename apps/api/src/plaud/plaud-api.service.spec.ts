import { PlaudApiService } from './plaud-api.service';

// Stage 2, Phase M (внешний аудит 21.09.2026) — форма fixture ниже
// воспроизводит РЕАЛЬНУЮ структуру ответа GET /files/:id, подтверждённую
// живым вызовом на подключённом боевом Plaud-аккаунте 21.09.2026
// (содержимое сегментов заменено на нейтральное — сама структура/имена
// полей/типы data_type — точная копия реального payload). Транскрипт
// лежит в source_list, НЕ в note_list — прежняя (Phase K) догадка была
// неверной, см. комментарий у findTranscriptNote.
function realShapedDetail(overrides: Partial<{ transactionContent: string; polishContent: string }> = {}) {
  return {
    id: 'of_abc123',
    name: 'Встреча',
    created_at: '2026-09-21T04:40:40Z',
    note_list: [
      { data_id: 'oo_su_abc123', data_type: 'auto_sum_note', data_title: 'Summary', data_content: '## Итоги\n...' },
    ],
    source_list: [
      {
        data_id: 'oo_tr_abc123',
        data_type: 'transaction',
        data_title: '',
        data_content:
          overrides.transactionContent ??
          '[{"content":"Привет","end_time":9810,"start_time":8790,"speaker":"Speaker 1","original_speaker":"Speaker 1","embeddingKey":null}]',
      },
      {
        data_id: 'oo_sc_source_transaction_polish:abc123',
        data_type: 'transaction_polish',
        data_title: '',
        data_content: overrides.polishContent ?? '',
      },
      { data_id: 'oo_ol_abc123', data_type: 'outline', data_title: '', data_content: '...' },
    ],
  };
}

describe('PlaudApiService.findTranscriptNote (Stage 2, Phase M — подтверждено реальным payload 21.09.2026)', () => {
  const service = new PlaudApiService({} as any);

  it('transaction_polish пустой — берёт сырой transaction из source_list', () => {
    const detail = realShapedDetail();

    const note = service.findTranscriptNote(detail);

    expect(note?.data_type).toBe('transaction');
    expect(note?.data_content).toContain('Привет');
  });

  it('transaction_polish непустой — предпочитает его над сырым transaction', () => {
    const detail = realShapedDetail({ polishContent: '[{"content":"Причёсанный текст","start_time":0,"end_time":1000,"speaker":"Speaker 1"}]' });

    const note = service.findTranscriptNote(detail);

    expect(note?.data_type).toBe('transaction_polish');
    expect(note?.data_content).toContain('Причёсанный текст');
  });

  it('source_list отсутствует вовсе — фолбэк на legacy-догадки в note_list (Phase K, на случай другого формата записи)', () => {
    const detail = {
      id: 'p1',
      name: 'Встреча',
      created_at: '2026-09-01T10:00:00Z',
      note_list: [{ data_type: 'auto_sum_note', data_content: 'саммари' }, { data_type: 'origin_text_note', data_content: 'транскрипт' }],
    };

    const note = service.findTranscriptNote(detail);

    expect(note?.data_content).toBe('транскрипт');
  });

  it('ничего подходящего не найдено ни в source_list, ни в note_list — undefined, не бросает', () => {
    const detail = { id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z', note_list: [{ data_type: 'auto_sum_note', data_content: 'саммари' }] };

    expect(service.findTranscriptNote(detail)).toBeUndefined();
  });
});
