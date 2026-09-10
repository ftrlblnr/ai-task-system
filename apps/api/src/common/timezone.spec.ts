import { formatLocalDateTime, localDateString, withLocalOffset } from './timezone';

describe('timezone (аудит 10.09.2026, п. 5.1 — тест на время: тот же класс бага, что уже был найден 01.09.2026 и 10.09.2026)', () => {
  describe('localDateString', () => {
    it('переводит время в местный день, а не в UTC-день сервера (п. 2.7 — regression guard)', () => {
      // "Завтра 02:00 по Алматы" = "сегодня 21:00 UTC" — toDateString() в
      // UTC засчитал бы это "сегодняшним" днём, localDateString — нет.
      const almatyTomorrow2am = new Date('2026-09-11T02:00:00+05:00');
      expect(localDateString(almatyTomorrow2am)).toBe('2026-09-11');
    });

    it('момент прямо на границе UTC-суток остаётся в правильном местном дне', () => {
      // 2026-09-10T21:00:00Z = 2026-09-11T02:00:00+05:00
      const utcMoment = new Date('2026-09-10T21:00:00Z');
      expect(localDateString(utcMoment)).toBe('2026-09-11');
    });
  });

  describe('formatLocalDateTime', () => {
    it('добавляет смещение +05:00, а не Z', () => {
      const d = new Date('2026-09-02T08:00:00Z'); // 13:00 по Алматы
      expect(formatLocalDateTime(d)).toBe('2026-09-02T13:00:00.000+05:00');
    });
  });

  describe('withLocalOffset', () => {
    it('null остаётся null', () => {
      expect(withLocalOffset(null)).toBeNull();
    });

    it('добавляет +05:00 к значению без смещения', () => {
      expect(withLocalOffset('2026-09-02T13:00:00')).toBe('2026-09-02T13:00:00+05:00');
    });

    it('заменяет уже присутствующий суффикс Z своим смещением, не задваивает', () => {
      // Защита от 01.09.2026 бага: Claude иногда сама дописывала Z, что
      // раньше трактовалось как UTC и уводило время на 5 часов.
      expect(withLocalOffset('2026-09-02T13:00:00Z')).toBe('2026-09-02T13:00:00+05:00');
    });

    it('заменяет уже присутствующее смещение, не задваивает', () => {
      expect(withLocalOffset('2026-09-02T13:00:00+03:00')).toBe('2026-09-02T13:00:00+05:00');
    });
  });
});
