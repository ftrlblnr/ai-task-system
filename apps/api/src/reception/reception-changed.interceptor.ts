import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { RealtimeService } from '../realtime/realtime.service';

// Любое успешное изменение в приёмной → сигнал открытым экранам (очередь
// руководителя, «Мои обращения» сотрудника). Расшифровка голоса ничего не
// меняет — её пропускаем.
@Injectable()
export class ReceptionChangedInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const mutates = req.method !== 'GET' && !req.path.endsWith('/transcribe');
    return next.handle().pipe(
      tap(() => {
        if (mutates) this.realtime.publish('reception');
      }),
    );
  }
}
