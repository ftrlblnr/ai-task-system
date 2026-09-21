import { PlaudApiService } from './plaud-api.service';

describe('PlaudApiService.findTranscriptNote (best-effort, см. предупреждение в самом сервисе)', () => {
  const service = new PlaudApiService({} as any);

  it('находит note по одному из предполагаемых data_type', () => {
    const detail = {
      id: 'p1',
      name: 'Встреча',
      created_at: '2026-09-01T10:00:00Z',
      note_list: [{ data_type: 'auto_sum_note', data_content: 'саммари' }, { data_type: 'origin_text_note', data_content: 'транскрипт' }],
    };

    const note = service.findTranscriptNote(detail);

    expect(note?.data_content).toBe('транскрипт');
  });

  it('ничего подходящего не найдено — undefined, не бросает', () => {
    const detail = { id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z', note_list: [{ data_type: 'auto_sum_note', data_content: 'саммари' }] };

    expect(service.findTranscriptNote(detail)).toBeUndefined();
  });
});
