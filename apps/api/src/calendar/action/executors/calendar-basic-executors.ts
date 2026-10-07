import { ConflictException, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../../../common/idempotency.service';
import type { CreateEventDto } from '../../dto/create-event.dto';
import type { UpdateEventDto } from '../../dto/update-event.dto';
import { EventsService } from '../../events.service';
import type { CalendarActionExecutor, CalendarActionExecutorResult } from '../calendar-action-executor';

// Раздел 18.2 ТЗ — "Idempotency-Key обязателен для... запуска, повтора" —
// здесь переиспользуем ОБЩИЙ IdempotencyService (тот же, что reception/
// mail-action), ключ = action.id (устойчив, уникален на действие): повтор
// ТОГО ЖЕ действия (сетевой сбой движка, ручной retry) получает СОХРАНЁННЫЙ
// результат первой попытки, не создаёт второе событие в Google. Это проще
// и переиспользует уже проверенный механизм вместо отдельной схемы
// детерминированных Google event ID (раздел 18.2 ТЗ, альтернативный путь).
const IDEMPOTENCY_ACTION = 'calendar.action.execute';

function toExecutorResult(err: unknown): CalendarActionExecutorResult {
  if (err instanceof ConflictException) {
    // EVENT_VERSION_CONFLICT — raздел 14/17 ТЗ: кто-то успел изменить
    // событие с момента согласования. Это не "ошибка исполнителя" в
    // обычном смысле — состояние объекта реально сдвинулось.
    return { outcome: 'SKIPPED_CHANGED', errorCode: 'EVENT_VERSION_CONFLICT' };
  }
  if (err instanceof NotFoundException) {
    return { outcome: 'SKIPPED_CHANGED', errorCode: 'EVENT_NOT_FOUND' };
  }
  return { outcome: 'FAILED', errorCode: 'EVENTS_SERVICE_ERROR', providerResult: { message: err instanceof Error ? err.message : String(err) } };
}

export class CreateEventExecutor implements CalendarActionExecutor {
  constructor(
    private readonly events: EventsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  execute: CalendarActionExecutor['execute'] = async (action, ctx) => {
    try {
      const { body } = await this.idempotency.run(ctx.ownerId, action.id, IDEMPOTENCY_ACTION, action.parameters, () =>
        this.events.create(action.parameters as CreateEventDto, ctx.ownerId),
      );
      return { outcome: 'SUCCEEDED', providerResult: { eventId: (body as { id: string }).id } };
    } catch (err) {
      return toExecutorResult(err);
    }
  };
}

// UPDATE_EVENT и RESCHEDULE_EVENT механически одинаковы (правка полей
// события через EventsService.update, которая уже сама атомарно
// проверяет beforeVersion — раздел 17 ТЗ) — раздел 6 ТЗ называет их
// отдельными кодами для ясности в UI/журнале, не потому что исполнение
// отличается.
export class UpdateEventExecutor implements CalendarActionExecutor {
  constructor(
    private readonly events: EventsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  execute: CalendarActionExecutor['execute'] = async (action, ctx) => {
    if (!action.targetEventId) return { outcome: 'FAILED', errorCode: 'MISSING_TARGET_EVENT' };
    try {
      const dto = { ...(action.parameters as UpdateEventDto), version: action.beforeVersion ?? undefined };
      const { body } = await this.idempotency.run(ctx.ownerId, action.id, IDEMPOTENCY_ACTION, dto, () => this.events.update(action.targetEventId!, dto, ctx.ownerId));
      return { outcome: 'SUCCEEDED', providerResult: { eventId: (body as { id: string }).id } };
    } catch (err) {
      return toExecutorResult(err);
    }
  };
}

// Раздел 13/17 ТЗ — "удаление локального события... требует контролируемой
// операции с сохранением истории": EventsService.remove пока делает
// безусловное удаление строки (известный остающийся разрыв, отмечен в
// коммите реальности C40/раздел 13) — исполнитель здесь честно использует
// то, что есть, не изобретает архивацию в обход EventsService.
export class CancelEventExecutor implements CalendarActionExecutor {
  constructor(
    private readonly events: EventsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  execute: CalendarActionExecutor['execute'] = async (action, ctx) => {
    if (!action.targetEventId) return { outcome: 'FAILED', errorCode: 'MISSING_TARGET_EVENT' };
    try {
      await this.idempotency.run(ctx.ownerId, action.id, IDEMPOTENCY_ACTION, {}, () => this.events.remove(action.targetEventId!, ctx.ownerId));
      return { outcome: 'SUCCEEDED' };
    } catch (err) {
      return toExecutorResult(err);
    }
  };
}
