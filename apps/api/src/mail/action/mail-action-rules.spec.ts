import {
  computeMailActionPayloadHash,
  computeSnapshotHash,
  GROUP_BY_ACTION_TYPE,
  MailActionCandidateItem,
  topoSortMailActionItems,
  validateMailActionConflicts,
} from './mail-action-rules';

const item = (over: Partial<MailActionCandidateItem> & { localId: string; type: MailActionCandidateItem['type'] }): MailActionCandidateItem => ({
  stableObjectIds: [],
  dependsOnItemIds: [],
  ...over,
});

describe('GROUP_BY_ACTION_TYPE (ТЗ разд. 7)', () => {
  it('корзина — своя отдельная группа, не "порядок в почте"', () => {
    expect(GROUP_BY_ACTION_TYPE.TRASH).toBe('TRASH');
    expect(GROUP_BY_ACTION_TYPE.ARCHIVE).toBe('MAILBOX_ORDER');
  });

  it('внутреннее событие — рабочий объект, а приглашение — внешняя отправка', () => {
    expect(GROUP_BY_ACTION_TYPE.CREATE_EVENT).toBe('WORK_OBJECTS');
    expect(GROUP_BY_ACTION_TYPE.PROPOSE_MEETING).toBe('EXTERNAL_SEND');
  });

  it('у каждого из 18 типов действия есть ровно одна группа', () => {
    expect(Object.keys(GROUP_BY_ACTION_TYPE)).toHaveLength(18);
  });
});

describe('validateMailActionConflicts (ТЗ разд. 8)', () => {
  it('архив и перемещение одного письма в одном плане — конфликт TERMINAL_MOVE', () => {
    const conflicts = validateMailActionConflicts([
      item({ localId: 'a', type: 'ARCHIVE', stableObjectIds: ['msg-1'] }),
      item({ localId: 'b', type: 'MOVE', stableObjectIds: ['msg-1'] }),
    ]);
    expect(conflicts).toEqual([{ code: 'TERMINAL_MOVE', itemLocalIds: ['a', 'b'], stableObjectId: 'msg-1' }]);
  });

  it('архив разных писем — без конфликта', () => {
    expect(
      validateMailActionConflicts([
        item({ localId: 'a', type: 'ARCHIVE', stableObjectIds: ['msg-1'] }),
        item({ localId: 'b', type: 'MOVE', stableObjectIds: ['msg-2'] }),
      ]),
    ).toEqual([]);
  });

  it('SET_READ и SET_UNREAD на одно письмо — конфликт FLAG_STATE', () => {
    const conflicts = validateMailActionConflicts([
      item({ localId: 'a', type: 'SET_READ', stableObjectIds: ['msg-1'] }),
      item({ localId: 'b', type: 'SET_UNREAD', stableObjectIds: ['msg-1'] }),
    ]);
    expect(conflicts).toEqual([{ code: 'FLAG_STATE', itemLocalIds: ['a', 'b'], stableObjectId: 'msg-1' }]);
  });

  it('FLAG и UNFLAG на одно письмо — конфликт FLAG_STATE', () => {
    const conflicts = validateMailActionConflicts([
      item({ localId: 'a', type: 'FLAG', stableObjectIds: ['msg-1'] }),
      item({ localId: 'b', type: 'UNFLAG', stableObjectIds: ['msg-1'] }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].code).toBe('FLAG_STATE');
  });

  it('MOVE зависит от несуществующего пункта плана — MISSING_DEPENDENCY', () => {
    const conflicts = validateMailActionConflicts([item({ localId: 'a', type: 'MOVE', dependsOnItemIds: ['ghost'] })]);
    expect(conflicts).toEqual([{ code: 'MISSING_DEPENDENCY', itemLocalIds: ['a'] }]);
  });

  it('CREATE_FOLDER → MOVE — обычная зависимость, не конфликт', () => {
    expect(
      validateMailActionConflicts([
        item({ localId: 'folder', type: 'CREATE_FOLDER' }),
        item({ localId: 'move', type: 'MOVE', dependsOnItemIds: ['folder'] }),
      ]),
    ).toEqual([]);
  });

  it('цикл зависимостей — DEPENDENCY_CYCLE', () => {
    const conflicts = validateMailActionConflicts([
      item({ localId: 'a', type: 'MOVE', dependsOnItemIds: ['b'] }),
      item({ localId: 'b', type: 'MOVE', dependsOnItemIds: ['a'] }),
    ]);
    expect(conflicts.some((c) => c.code === 'DEPENDENCY_CYCLE')).toBe(true);
  });
});

describe('computeMailActionPayloadHash / computeSnapshotHash (ТЗ разд. 14)', () => {
  it('одинаковые параметры дают одинаковый хэш', () => {
    expect(computeMailActionPayloadHash('ARCHIVE', { folder: 'Archive' })).toBe(computeMailActionPayloadHash('ARCHIVE', { folder: 'Archive' }));
  });

  it('другие параметры дают другой хэш', () => {
    expect(computeMailActionPayloadHash('MOVE', { folder: 'A' })).not.toBe(computeMailActionPayloadHash('MOVE', { folder: 'B' }));
  });

  it('снимок согласия хэшируется целиком, не по одному действию', () => {
    expect(computeSnapshotHash([{ id: '1' }])).not.toBe(computeSnapshotHash([{ id: '2' }]));
  });
});

describe('topoSortMailActionItems (ТЗ разд. 8)', () => {
  it('зависимость идёт раньше зависящего от неё пункта', () => {
    const sorted = topoSortMailActionItems([
      { localId: 'move', dependsOnItemIds: ['folder'] },
      { localId: 'folder', dependsOnItemIds: [] },
    ]);
    expect(sorted.map((i) => i.localId)).toEqual(['folder', 'move']);
  });

  it('независимые пункты сохраняют исходный относительный порядок', () => {
    const sorted = topoSortMailActionItems([
      { localId: 'a', dependsOnItemIds: [] },
      { localId: 'b', dependsOnItemIds: [] },
    ]);
    expect(sorted.map((i) => i.localId)).toEqual(['a', 'b']);
  });
});
