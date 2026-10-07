import { ConflictException, NotFoundException } from '@nestjs/common';
import { CancelEventExecutor, CreateEventExecutor, UpdateEventExecutor } from './calendar-basic-executors';

// Идемпотентность сама по себе уже покрыта common/idempotency.service.spec.ts
// — здесь просто передаём вызов дальше, без претензии на дедупликацию
// между отдельными вызовами execute() в одном тесте.
const passthroughIdempotency = {
  run: jest.fn(async (_actorId: string, _key: string, _action: string, _body: unknown, handler: () => Promise<unknown>) => ({
    statusCode: 200,
    body: await handler(),
  })),
};

const ctx = { ownerId: 'owner-1' };

describe('CreateEventExecutor (ТЗ разд. 6/18.2)', () => {
  it('успешное создание — SUCCEEDED с eventId', async () => {
    const events = { create: jest.fn().mockResolvedValue({ id: 'e1' }) };
    const executor = new CreateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: null, beforeVersion: null, parameters: { title: 'X' } }, ctx);
    expect(result).toEqual({ outcome: 'SUCCEEDED', providerResult: { eventId: 'e1' } });
    expect(events.create).toHaveBeenCalledWith({ title: 'X' }, 'owner-1');
  });

  it('ошибка EventsService — FAILED', async () => {
    const events = { create: jest.fn().mockRejectedValue(new Error('Google недоступен')) };
    const executor = new CreateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: null, beforeVersion: null, parameters: {} }, ctx);
    expect(result.outcome).toBe('FAILED');
    expect(result.errorCode).toBe('EVENTS_SERVICE_ERROR');
  });
});

describe('UpdateEventExecutor (ТЗ разд. 6/17)', () => {
  it('без targetEventId — FAILED MISSING_TARGET_EVENT', async () => {
    const events = { update: jest.fn() };
    const executor = new UpdateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: null, beforeVersion: null, parameters: {} }, ctx);
    expect(result).toEqual({ outcome: 'FAILED', errorCode: 'MISSING_TARGET_EVENT' });
    expect(events.update).not.toHaveBeenCalled();
  });

  it('успешная правка передаёт beforeVersion как ожидаемую версию', async () => {
    const events = { update: jest.fn().mockResolvedValue({ id: 'e1' }) };
    const executor = new UpdateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: 'e1', beforeVersion: 3, parameters: { title: 'Новое' } }, ctx);
    expect(result).toEqual({ outcome: 'SUCCEEDED', providerResult: { eventId: 'e1' } });
    expect(events.update).toHaveBeenCalledWith('e1', { title: 'Новое', version: 3 }, 'owner-1');
  });

  it('EVENT_VERSION_CONFLICT (раздел 14/17 ТЗ) — SKIPPED_CHANGED, не FAILED', async () => {
    const events = { update: jest.fn().mockRejectedValue(new ConflictException()) };
    const executor = new UpdateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: 'e1', beforeVersion: 1, parameters: {} }, ctx);
    expect(result).toEqual({ outcome: 'SKIPPED_CHANGED', errorCode: 'EVENT_VERSION_CONFLICT' });
  });

  it('событие удалено/недоступно (404) — SKIPPED_CHANGED', async () => {
    const events = { update: jest.fn().mockRejectedValue(new NotFoundException()) };
    const executor = new UpdateEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: 'e1', beforeVersion: 1, parameters: {} }, ctx);
    expect(result).toEqual({ outcome: 'SKIPPED_CHANGED', errorCode: 'EVENT_NOT_FOUND' });
  });
});

describe('CancelEventExecutor (ТЗ разд. 6/13)', () => {
  it('без targetEventId — FAILED MISSING_TARGET_EVENT', async () => {
    const events = { remove: jest.fn() };
    const executor = new CancelEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: null, beforeVersion: null, parameters: {} }, ctx);
    expect(result).toEqual({ outcome: 'FAILED', errorCode: 'MISSING_TARGET_EVENT' });
  });

  it('успешная отмена — SUCCEEDED', async () => {
    const events = { remove: jest.fn().mockResolvedValue(undefined) };
    const executor = new CancelEventExecutor(events as never, passthroughIdempotency as never);
    const result = await executor.execute({ id: 'action-1', targetEventId: 'e1', beforeVersion: null, parameters: {} }, ctx);
    expect(result).toEqual({ outcome: 'SUCCEEDED' });
    expect(events.remove).toHaveBeenCalledWith('e1', 'owner-1');
  });
});
