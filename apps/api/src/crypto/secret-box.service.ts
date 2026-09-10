import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

// Раздел 15 ТЗ: "Шифрование в состоянии покоя — AES-256". Первый секрет в
// системе, который нужно не только проверить (как пароль/токен-хэш), а
// реально расшифровать и использовать повторно — Google refresh-токен для
// синхронизации календаря руководителя (см. GoogleCalendarConnection).
//
// Формат хранения: base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext).
@Injectable()
export class SecretBoxService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.getOrThrow<string>('ENCRYPTION_KEY');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY должен быть base64 ровно 32 байт (256 бит) — сгенерировать: openssl rand -base64 32');
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Повреждённый формат зашифрованного секрета');
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
