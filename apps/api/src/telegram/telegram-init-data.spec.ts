import { createHmac } from 'crypto';
import { InvalidTelegramInitDataError, verifyTelegramInitData } from './telegram-init-data';

const BOT_TOKEN = 'test-bot-token-123456789';

// Строит валидно подписанную initData тем же алгоритмом, что и сама
// проверяемая функция — единственный способ протестировать успешный путь
// без реального Telegram-клиента.
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

describe('verifyTelegramInitData (аудит 10.09.2026, п. 5.1)', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const validFields = {
    auth_date: String(nowSec),
    user: JSON.stringify({ id: 12345, first_name: 'Иван', username: 'ivan' }),
  };

  it('принимает валидно подписанную initData и возвращает разобранные поля', () => {
    const raw = signInitData(validFields);
    const result = verifyTelegramInitData(raw, BOT_TOKEN);
    expect(result.user.id).toBe(12345);
    expect(result.user.username).toBe('ivan');
    expect(result.authDate).toBe(nowSec);
  });

  it('отклоняет подпись, посчитанную с другим bot_token (подделка)', () => {
    const raw = signInitData(validFields, 'wrong-token');
    expect(() => verifyTelegramInitData(raw, BOT_TOKEN)).toThrow(InvalidTelegramInitDataError);
  });

  it('отклоняет данные, изменённые ПОСЛЕ подписи (canonical tamper — подмена user.id)', () => {
    const raw = signInitData(validFields);
    const params = new URLSearchParams(raw);
    params.set('user', JSON.stringify({ id: 99999, first_name: 'Подмена' }));
    expect(() => verifyTelegramInitData(params.toString(), BOT_TOKEN)).toThrow(InvalidTelegramInitDataError);
  });

  it('отклоняет отсутствие hash', () => {
    const params = new URLSearchParams(validFields);
    expect(() => verifyTelegramInitData(params.toString(), BOT_TOKEN)).toThrow(InvalidTelegramInitDataError);
  });

  it('отклоняет устаревшую initData (auth_date старше 24 часов)', () => {
    const stale = { ...validFields, auth_date: String(nowSec - 25 * 60 * 60) };
    const raw = signInitData(stale);
    expect(() => verifyTelegramInitData(raw, BOT_TOKEN)).toThrow(InvalidTelegramInitDataError);
  });

  it('отклоняет нечитаемый JSON в поле user', () => {
    const raw = signInitData({ ...validFields, user: '{not json' });
    expect(() => verifyTelegramInitData(raw, BOT_TOKEN)).toThrow(InvalidTelegramInitDataError);
  });
});
