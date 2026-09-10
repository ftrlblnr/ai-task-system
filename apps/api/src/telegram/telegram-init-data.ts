import { createHmac, timingSafeEqual } from 'crypto';

// Проверка initData Telegram Mini App по документированному алгоритму:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// secret_key = HMAC_SHA256("WebAppData", bot_token)
// hash       = HMAC_SHA256(data_check_string, secret_key)
// Подделать initData без знания bot_token невозможно — это и есть источник
// доверия для /auth/telegram, отдельный секрет бота здесь не нужен.

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface VerifiedTelegramInitData {
  user: TelegramInitDataUser;
  startParam?: string;
  authDate: number;
}

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

export class InvalidTelegramInitDataError extends Error {}

export function verifyTelegramInitData(rawInitData: string, botToken: string): VerifiedTelegramInitData {
  const params = new URLSearchParams(rawInitData);
  const providedHash = params.get('hash');
  if (!providedHash) throw new InvalidTelegramInitDataError('Отсутствует hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(providedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidTelegramInitDataError('Подпись не совпадает');
  }

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    throw new InvalidTelegramInitDataError('initData устарела — откройте Mini App заново');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new InvalidTelegramInitDataError('Отсутствуют данные пользователя');

  let user: TelegramInitDataUser;
  try {
    // JSON.parse — any по определению; поле user приходит из initData,
    // чья подпись уже проверена выше (это не даёт гарантии формы объекта,
    // только подлинность источника — то же допущение, что было и раньше).
    user = JSON.parse(userRaw) as TelegramInitDataUser;
  } catch {
    throw new InvalidTelegramInitDataError('Не удалось разобрать данные пользователя');
  }

  return { user, startParam: params.get('start_param') ?? undefined, authDate };
}
