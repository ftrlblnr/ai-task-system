import { IdempotencyService } from '../../../common/idempotency.service';
import { EventsService } from '../../events.service';
import { CalendarActionExecutorRegistry } from '../calendar-action-executor';
import { CancelEventExecutor, CreateEventExecutor, UpdateEventExecutor } from './calendar-basic-executors';

export function registerCalendarActionExecutors(registry: CalendarActionExecutorRegistry, events: EventsService, idempotency: IdempotencyService): void {
  registry.register('CREATE_EVENT', new CreateEventExecutor(events, idempotency));
  const update = new UpdateEventExecutor(events, idempotency);
  registry.register('UPDATE_EVENT', update);
  // RESCHEDULE_EVENT механически = UPDATE_EVENT (раздел 6 ТЗ: отдельный
  // код для ясности в UI/журнале, не для другого исполнения).
  registry.register('RESCHEDULE_EVENT', update);
  registry.register('CANCEL_EVENT', new CancelEventExecutor(events, idempotency));
}
