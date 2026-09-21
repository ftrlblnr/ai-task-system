import { IsString } from 'class-validator';

// Stage 2, Phase H.4 (внешний аудит 21.09.2026, "trusted server-side
// undo") — раньше клиент присылал структурированный, но всё же
// authoritative rollback-payload (kind/action/id/previous/addedParticipantIds/
// removedParticipantIds), из которого VoiceService.undo и восстанавливал
// состояние. Формально это уже не conversation-history poisoning (текст
// подтверждения решал сервер, см. история этого DTO ниже), но откат
// целиком опирался на то, что прислал клиент — устаревший/подделанный
// payload мог откатить задачу/событие в состояние, которого никогда не
// было. Теперь клиент присылает только непрозрачный `undoToken`
// (id записи `UndoRecord`, которую сервер сам создал и сохранил сразу
// после мутации, см. VoiceService.executeTaskAction/executeEventAction) —
// сам откат выполняется по хранимым на сервере данным.
export class VoiceUndoDto {
  @IsString()
  undoToken!: string;
}
