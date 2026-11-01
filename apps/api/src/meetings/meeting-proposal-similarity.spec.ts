import { findSimilarTask, jaccard, sameTask, titleWords } from './meeting-proposal-similarity';

describe('titleWords / jaccard', () => {
  it('падежи сводятся к одной основе, служебные слова не считаются', () => {
    expect(titleWords('Подготовить смету по объекту')).toEqual(titleWords('подготовить сметы по объекту.'));
    expect(titleWords('Отправить отчёт к пятнице')).toEqual(new Set(['отпра', 'отче', 'пятни']));
  });

  it('совпадение по словам', () => {
    expect(jaccard(titleWords('Подготовить смету'), titleWords('Подготовить смету'))).toBe(1);
    expect(jaccard(titleWords('Подготовить смету'), titleWords('Согласовать договор'))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('sameTask', () => {
  it('тот же исполнитель и близкое название — одно поручение', () => {
    expect(sameTask('Подготовить смету', 'Жандос', 'Согласовать смету', 'жандос')).toBe(false);
    expect(sameTask('Подготовить смету по объекту', 'Жандос', 'Подготовить смету объекта', 'жандос')).toBe(true);
    expect(sameTask('Подготовить смету', 'Жандос', 'Подготовить смету', 'Арман')).toBe(false);
  });
});

describe('findSimilarTask', () => {
  const tasks = [
    { id: 't-other', title: 'Подготовить смету по объекту', assigneeId: 'e2', sourceMeetingId: null },
    { id: 't-same', title: 'Подготовить смету объекта', assigneeId: 'e1', sourceMeetingId: null },
    { id: 't-meeting', title: 'Согласовать договор поставки', assigneeId: 'e3', sourceMeetingId: 'm1' },
  ];

  it('похожая задача того же исполнителя', () => {
    expect(findSimilarTask({ title: 'Подготовить смету по объекту', assigneeId: 'e1' }, 'm1', tasks)).toBe('t-same');
  });

  it('задача этой встречи — у любого исполнителя', () => {
    expect(findSimilarTask({ title: 'Согласовать договор поставки', assigneeId: null }, 'm1', tasks)).toBe('t-meeting');
  });

  it('чужая задача с похожим названием не в счёт', () => {
    expect(findSimilarTask({ title: 'Подготовить смету по объекту', assigneeId: 'e9' }, 'm1', tasks)).toBeNull();
  });
});
