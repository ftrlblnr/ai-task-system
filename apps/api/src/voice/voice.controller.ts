import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { VoiceService } from './voice.service';
import { ParseVoiceDto } from './dto/parse-voice.dto';
import { VoiceUndoDto } from './dto/voice-undo.dto';

// Без @Roles(...) — как TasksController: голосом можно надиктовать задачу
// себе или коллеге, а это открыто любому сотруднику (раздел 5 ТЗ,
// скорректировано 28.08.2026). Черновик-событие для не-OWNER'а
// перехватывается на уровне VoiceService.enforceEventRbac, не здесь.
const ALLOWED_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-m4a',
];

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('parse')
  @UseInterceptors(
    FileInterceptor('audio', {
      // 25MB — собственный жёсткий лимит Whisper API, не произвольное число.
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype));
      },
    }),
  )
  parse(
    @UploadedFile() audio: Express.Multer.File | undefined,
    @Body() dto: ParseVoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // audio может быть undefined (fileFilter отклонил формат) — проверка и
    // BadRequestException живут в VoiceService.parse, не дублируем здесь.
    return this.voice.parse(audio, user, dto.meetingId, dto.clientRequestId, dto.conversationId);
  }

  // Stage 2, Phase H.1 (аудит 20.09.2026, P0/P1) — заменяет прежний
  // POST /voice/messages, который принимал от клиента произвольный текст
  // и записывал его в общую ленту с ролью ASSISTANT (conversation-history
  // poisoning, см. комментарий у VoiceUndoDto). Теперь клиент присылает
  // только структурированное описание того, что откатить — сам откат и
  // текст подтверждения решает сервер, см. VoiceService.undo.
  @Post('undo')
  undo(@Body() dto: VoiceUndoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.voice.undo(dto, user);
  }
}
