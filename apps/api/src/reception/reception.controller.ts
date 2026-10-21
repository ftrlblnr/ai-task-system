import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Logger,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Patch,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReceptionRequestStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActiveEmployeeGuard } from './guards/active-employee.guard';
import { ReceptionService } from './reception.service';
import { IdempotencyService } from '../common/idempotency.service';
import { CompanyVocabularyService } from '../employees/company-vocabulary.service';
import { CreateReceptionRequestDto } from './dto/create-reception-request.dto';
import { EditReceptionRequestDto, VersionOnlyDto } from './dto/edit-reception-request.dto';
import { RejectReceptionRequestDto } from './dto/reject.dto';
import { CompleteReceptionRequestDto } from './dto/complete.dto';
import { AnswerReceptionRequestDto, DelegateReceptionRequestDto } from './dto/answer.dto';
import { WhisperService } from '../voice/whisper.service';
import { AnswerStructuringService } from './answer-structuring.service';
import { isWhisperArtifact } from './whisper-artifacts';
import { ReorderReceptionRequestDto } from './dto/reorder.dto';
import { CreateAnswerTemplateDto } from './dto/template.dto';

// Тот же набор форматов, что у голосового ввода (VoiceController).
const AUDIO_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'];

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parsePaging(rawLimit?: string, rawOffset?: string): { limit: number; offset: number } {
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

// Раздел 4 ТЗ «Приёмная» — ActiveEmployeeGuard СРАЗУ после JwtAuthGuard и ДО
// RolesGuard: перечитывает сотрудника из БД, перезаписывает request.user
// живой ролью (JWT мог быть выдан до увольнения/смены роли), RolesGuard
// ниже уже видит актуальное значение. @Roles(OWNER) на конкретных методах
// (не на классе) — POST /requests доступен любому активному сотруднику.
@UseGuards(JwtAuthGuard, ActiveEmployeeGuard, RolesGuard)
@Controller('reception')
export class ReceptionController {
  private readonly logger = new Logger(ReceptionController.name);

  constructor(
    private readonly reception: ReceptionService,
    private readonly idempotency: IdempotencyService,
    private readonly whisper: WhisperService,
    private readonly structuring: AnswerStructuringService,
    private readonly vocabulary: CompanyVocabularyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  @Post('requests')
  async create(@Body() dto: CreateReceptionRequestDto, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.create', dto, () => this.reception.create(user, dto));
    return body;
  }

  @Get('requests/mine')
  getMine(
    @Query('scope') scope: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    return this.reception.getMine(user, scope === 'history' ? 'history' : 'active', l, o);
  }

  @Get('queue')
  @Roles(...MANAGER_ROLES)
  getQueue(
    @Query('search') search: string | undefined,
    @Query('authorId') authorId: string | undefined,
    @Query('expiredOnly') expiredOnly: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    return this.reception.getQueueView({ search: search || undefined, authorId: authorId || undefined, expiredOnly: expiredOnly === 'true' }, l, o);
  }

  @Get('board')
  @Roles(...MANAGER_ROLES)
  getBoard() {
    return this.reception.getBoard();
  }

  // Голосовой ответ: запись → Whisper → структурированный текст (владелец
  // 20.10.2026), который руководитель проверяет и отправляет через POST
  // /requests/:id/answer. requestId — вопрос как контекст для редактуры.
  // Ничего не меняет, поэтому без Idempotency-Key.
  @Post('transcribe')
  @Roles(...MANAGER_ROLES)
  @UseInterceptors(
    FileInterceptor('audio', {
      limits: { fileSize: 25 * 1024 * 1024 }, // лимит Whisper API
      fileFilter: (_req, file, cb) => cb(null, AUDIO_MIME_TYPES.includes(file.mimetype)),
    }),
  )
  async transcribe(
    @UploadedFile() audio: Express.Multer.File | undefined,
    @Body('requestId') requestId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!audio) throw new BadRequestException('Нужна аудиозапись (webm, ogg, mp4, mp3, wav)');
    let raw: string;
    try {
      const vocabulary = await this.vocabulary.getPrompt().catch(() => '');
      raw = (await this.whisper.transcribe(audio.buffer, audio.mimetype, audio.originalname, vocabulary)).text.trim();
    } catch {
      throw new BadGatewayException('Не удалось распознать запись — попробуйте ещё раз или напишите текстом');
    }
    // Пустой text — клиент просит повторить запись (речь не расслышана).
    if (isWhisperArtifact(raw)) {
      this.logger.log(`transcribe: whisper artifact dropped (${raw.length} chars)`);
      return { text: '' };
    }
    const question = requestId ? await this.reception.getOne(user, requestId).catch(() => null) : null;
    return { text: await this.structuring.structure(raw, question ?? undefined) };
  }

  @Get('templates')
  @Roles(...MANAGER_ROLES)
  listTemplates() {
    return this.reception.listTemplates();
  }

  @Post('templates')
  @Roles(...MANAGER_ROLES)
  createTemplate(@Body() dto: CreateAnswerTemplateDto) {
    return this.reception.createTemplate(dto.text);
  }

  @Delete('templates/:id')
  @Roles(...MANAGER_ROLES)
  deleteTemplate(@Param('id') id: string) {
    return this.reception.deleteTemplate(id);
  }

  @Get('history')
  @Roles(...MANAGER_ROLES)
  getHistory(
    @Query('authorId') authorId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    const terminalStatuses: string[] = ['COMPLETED', 'ANSWERED', 'DELEGATED', 'REJECTED', 'WITHDRAWN'];
    const parsedStatus = status && terminalStatuses.includes(status) ? (status as ReceptionRequestStatus) : undefined;
    const parsedFrom = dateFrom ? new Date(dateFrom) : undefined;
    const parsedTo = dateTo ? new Date(dateTo) : undefined;
    return this.reception.getHistory(
      {
        authorId: authorId || undefined,
        status: parsedStatus,
        closedFrom: parsedFrom && !Number.isNaN(parsedFrom.getTime()) ? parsedFrom : undefined,
        closedTo: parsedTo && !Number.isNaN(parsedTo.getTime()) ? parsedTo : undefined,
      },
      l,
      o,
    );
  }

  @Get('requests/:id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reception.getOne(user, id);
  }

  @Get('requests/:id/events')
  getEvents(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reception.getEvents(user, id);
  }

  @Patch('requests/:id')
  async edit(
    @Param('id') id: string,
    @Body() dto: EditReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.edit', { id, dto }, () => this.reception.edit(user, id, dto));
    return body;
  }

  @Post('requests/:id/withdraw')
  async withdraw(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.withdraw', { id, dto }, () =>
      this.reception.withdraw(user, id, dto.version),
    );
    return body;
  }

  @Post('requests/:id/move-to-end')
  @Roles(...MANAGER_ROLES)
  async moveToEnd(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.move-to-end', { id, dto }, () =>
      this.reception.moveToEnd(user, id, dto.version),
    );
    return body;
  }

  @Post('requests/:id/reorder')
  @Roles(...MANAGER_ROLES)
  async reorder(
    @Param('id') id: string,
    @Body() dto: ReorderReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.reorder', { id, dto }, () =>
      this.reception.reorder(user, id, dto.version, dto.beforeId),
    );
    return body;
  }

  @Post('requests/:id/call')
  @Roles(...MANAGER_ROLES)
  async call(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.call', { id, dto }, () => this.reception.call(user, id, dto.version));
    return body;
  }

  @Post('requests/:id/reject')
  @Roles(...MANAGER_ROLES)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.reject', { id, dto }, () => this.reception.reject(user, id, dto));
    return body;
  }

  @Post('requests/:id/complete')
  @Roles(...MANAGER_ROLES)
  async complete(
    @Param('id') id: string,
    @Body() dto: CompleteReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.complete', { id, dto }, () =>
      this.reception.complete(user, id, dto),
    );
    return body;
  }

  @Post('requests/:id/answer')
  @Roles(...MANAGER_ROLES)
  async answer(
    @Param('id') id: string,
    @Body() dto: AnswerReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.answer', { id, dto }, () => this.reception.answer(user, id, dto));
    return body;
  }

  @Post('requests/:id/delegate')
  @Roles(...MANAGER_ROLES)
  async delegate(
    @Param('id') id: string,
    @Body() dto: DelegateReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.delegate', { id, dto }, () =>
      this.reception.delegate(user, id, dto),
    );
    return body;
  }

  @Post('requests/:id/return-to-queue')
  @Roles(...MANAGER_ROLES)
  async returnToQueue(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.return-to-queue', { id, dto }, () =>
      this.reception.returnToQueue(user, id, dto.version),
    );
    return body;
  }

  @Post('notifications/:id/retry')
  @Roles(...MANAGER_ROLES)
  async retryNotification(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    await this.idempotency.run(user.id, key, 'reception.notifications.retry', { id }, async () => {
      await this.reception.retryNotification(id);
      return { ok: true };
    });
    return { ok: true };
  }
}
