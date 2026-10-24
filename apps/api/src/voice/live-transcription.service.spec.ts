import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LiveTranscriptionService } from './live-transcription.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('LiveTranscriptionService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('выдаёт секрет сессии только расшифровки, ключ OpenAI наружу не отдаёт', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ value: 'ek_test', expires_at: 123 }) });
    global.fetch = fetchMock;
    const service = new LiveTranscriptionService(config({ OPENAI_API_KEY: 'sk-secret' }));

    const result = await service.createSecret();

    expect(result).toEqual({ clientSecret: 'ek_test', expiresAt: 123, model: 'gpt-live-transcribe' });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.session.type).toBe('transcription');
    expect(body.session.audio.input.turn_detection).toBeNull();
  });

  it('без ключа или с выключателем — 503, клиент пишет без предпросмотра', async () => {
    await expect(new LiveTranscriptionService(config({})).createSecret()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      new LiveTranscriptionService(config({ OPENAI_API_KEY: 'sk', LIVE_TRANSCRIPTION_ENABLED: 'false' })).createSecret(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ошибка OpenAI — 502, а не сырой ответ провайдера', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    await expect(new LiveTranscriptionService(config({ OPENAI_API_KEY: 'sk' })).createSecret()).rejects.toBeInstanceOf(BadGatewayException);
  });
});
