import { computeCalendarActionPayloadHash, computeCalendarSnapshotHash, topoSortCalendarActions } from './calendar-action-rules';

describe('computeCalendarActionPayloadHash / computeCalendarSnapshotHash', () => {
  it('одинаковые параметры дают одинаковый хэш', () => {
    expect(computeCalendarActionPayloadHash('CREATE_EVENT', { title: 'X' })).toBe(computeCalendarActionPayloadHash('CREATE_EVENT', { title: 'X' }));
  });

  it('другие параметры дают другой хэш', () => {
    expect(computeCalendarActionPayloadHash('CREATE_EVENT', { title: 'A' })).not.toBe(computeCalendarActionPayloadHash('CREATE_EVENT', { title: 'B' }));
  });

  it('снимок хэшируется целиком', () => {
    expect(computeCalendarSnapshotHash([{ id: '1' }])).not.toBe(computeCalendarSnapshotHash([{ id: '2' }]));
  });
});

describe('topoSortCalendarActions', () => {
  it('зависимость идёт раньше зависящего от неё действия', () => {
    const sorted = topoSortCalendarActions([
      { localId: 'invite', dependsOnActionIds: ['create'] },
      { localId: 'create', dependsOnActionIds: [] },
    ]);
    expect(sorted.map((a) => a.localId)).toEqual(['create', 'invite']);
  });

  it('независимые действия сохраняют исходный порядок', () => {
    const sorted = topoSortCalendarActions([
      { localId: 'a', dependsOnActionIds: [] },
      { localId: 'b', dependsOnActionIds: [] },
    ]);
    expect(sorted.map((a) => a.localId)).toEqual(['a', 'b']);
  });
});
