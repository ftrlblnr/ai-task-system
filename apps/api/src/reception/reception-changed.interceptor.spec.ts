import { lastValueFrom, of, throwError } from 'rxjs';
import { ReceptionChangedInterceptor } from './reception-changed.interceptor';

function run(method: string, path: string, result$ = of({ ok: true })) {
  const realtime = { publish: jest.fn() };
  const interceptor = new ReceptionChangedInterceptor(realtime as any);
  const context = { switchToHttp: () => ({ getRequest: () => ({ method, path }) }) } as any;
  return { realtime, done: lastValueFrom(interceptor.intercept(context, { handle: () => result$ })) };
}

describe('ReceptionChangedInterceptor', () => {
  it('успешное изменение — сигнал «reception»', async () => {
    const { realtime, done } = run('POST', '/reception/requests/r1/call');
    await done;
    expect(realtime.publish).toHaveBeenCalledWith('reception');
  });

  it('чтение и расшифровка голоса — без сигнала', async () => {
    for (const [method, path] of [
      ['GET', '/reception/board'],
      ['POST', '/reception/transcribe'],
    ]) {
      const { realtime, done } = run(method, path);
      await done;
      expect(realtime.publish).not.toHaveBeenCalled();
    }
  });

  it('ошибка обработчика — без сигнала', async () => {
    const { realtime, done } = run('POST', '/reception/requests', throwError(() => new Error('VERSION_CONFLICT')));
    await expect(done).rejects.toThrow('VERSION_CONFLICT');
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});
