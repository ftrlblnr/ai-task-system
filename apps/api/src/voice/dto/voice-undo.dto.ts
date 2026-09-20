import { IsArray, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

// Stage 2, Phase H.1 (внешний аудит 20.09.2026) — заменяет прежний
// POST /voice/messages: раньше клиент мог записать в общую ленту
// ПРОИЗВОЛЬНЫЙ текст с ролью ASSISTANT (conversation-history poisoning —
// особенно опасно после Phase H, когда эта лента стала общим AI-контекстом
// для голоса и текста разом). Теперь отмена — не "клиент сам откатывает
// через обычные PATCH/DELETE и потом просит сервер записать придуманный
// текст", а единый серверный эндпоинт: VoiceService.undo сам выполняет
// откат (теми же TasksService/EventsService, что и обычные REST-пути — та
// же RBAC-проверка, не задвоена) И сам решает, какой текст подтверждения
// записать — клиент не может продиктовать этот текст.
//
// previous — намеренно не глубоко валидируется как вложенный DTO (нет
// @ValidateNested + @Type): VoiceService.undo читает из него поля
// поштучно (тот же приём, что уже в executeTaskAction/executeEventAction),
// а не спреды "как есть" — лишние/чужие поля просто не читаются, поэтому
// не требуют отдельной схемы для отклонения на границе контроллера.
export class VoiceUndoDto {
  @IsIn(['task', 'event'])
  kind!: 'task' | 'event';

  @IsIn(['create', 'update'])
  action!: 'create' | 'update';

  @IsString()
  id!: string;

  @IsOptional()
  @IsObject()
  previous?: Record<string, unknown>;

  // Только для kind='event'/action='update' — id участников, добавленных/
  // снятых исходным голосовым действием; undo инвертирует (добавленных —
  // снять, снятых — вернуть), см. VoiceService.undo.
  @IsOptional()
  @IsArray()
  addedParticipantIds?: string[];

  @IsOptional()
  @IsArray()
  removedParticipantIds?: string[];
}
