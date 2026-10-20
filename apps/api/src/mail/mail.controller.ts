import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { assertOwnIntegration, CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../auth/data-owner';
import { MANAGER_ROLES } from '../auth/roles';
import { contentDisposition } from '../common/http/content-disposition';
import { FilesService } from '../files/files.service';
import { MailActionSessionFactory } from './action/mail-action-session-factory';
import { CreateMailFolderDto } from './dto/create-mail-folder.dto';
import { MailConnectionService } from './mail-connection.service';
import { PROVIDER_LABELS } from './mail-digest.cron';
import { MailQueryService, parseEmailFilters } from './mail-query.service';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';

export class ConnectMailboxDto {
  @IsEmail()
  @MaxLength(254)
  emailAddress!: string;

  // Пароль ПРИЛОЖЕНИЯ Mail.ru — не логируется, не возвращается, хранится зашифрованным.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  appPassword!: string;

  @IsOptional()
  @IsInt()
  @IsIn([30, 90, 180])
  initialDays?: number;
}

// Как Plaud/календарь — личная интеграция (решение владельца 25.09.2026). Каждый
// запрос работает только с ящиком владельца данных (Mailbox.employeeId), чужие
// письма недоступны по id (404). С 20.10.2026 ящик есть и у администратора, а
// в режиме X-Act-As: leader он работает с ящиком руководителя (DataOwnerGuard).
@UseGuards(JwtAuthGuard, RolesGuard, DataOwnerGuard)
@Roles(...MANAGER_ROLES)
@Controller('mail')
export class MailController {
  constructor(
    private readonly connection: MailConnectionService,
    private readonly sync: MailSyncService,
    private readonly store: MailStore,
    private readonly query: MailQueryService,
    private readonly files: FilesService,
    private readonly sessions: MailActionSessionFactory,
  ) {}

  @Get('status')
  status(@CurrentDataOwner() owner: DataOwner) {
    return this.connection.status(owner.id);
  }

  @Post('connect')
  connect(@Body() dto: ConnectMailboxDto, @CurrentDataOwner() owner: DataOwner) {
    assertOwnIntegration(owner);
    return this.connection.connect(owner.id, dto);
  }

  @Delete('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentDataOwner() owner: DataOwner) {
    assertOwnIntegration(owner);
    return this.connection.disconnect(owner.id);
  }

  // Ручное обновление — синк идёт в фоне (минуты на большой ящик), UI опрашивает статус.
  @Post('sync')
  async syncNow(@CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    void this.sync.syncMailbox(mailbox.id).catch(() => undefined);
    return { started: true };
  }

  @Get('messages')
  async list(@Query() raw: Record<string, string | undefined>, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    return this.query.search(mailbox.id, parseEmailFilters(raw), {
      limit: raw.limit ? Number(raw.limit) : undefined,
      offset: raw.offset ? Number(raw.offset) : undefined,
    });
  }

  @Get('messages/:id')
  async getOne(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    return this.query.getMessage(mailbox.id, id);
  }

  // Release 2 — скачивание вложения. Владение проверяется дважды: сначала
  // вложение принадлежит ящику владельца данных (getAttachmentForDownload,
  // 404 если нет) — этого достаточно: личное владение файлом не сверяется,
  // потому что администратор в режиме руководителя скачивает вложение из
  // её ящика (FileArtifact.employeeId — руководитель, не он).
  @Get('attachments/:id/download')
  async downloadAttachment(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner): Promise<StreamableFile> {
    const mailbox = await this.requireMailbox(owner);
    const { fileArtifactId } = await this.query.getAttachmentForDownload(mailbox.id, id);
    const { stream, file } = await this.files.getStreamForProcessing(fileArtifactId);
    return new StreamableFile(stream, { type: file.mimeType, disposition: contentDisposition(file.name) });
  }

  // Вкладка «Дайджест» (владелец 29.09.2026) — сохранённые ежедневные сводки
  // (пишутся mail-digest.cron.ts каждое утро), список + деталь по образцу
  // messages/messages/:id выше. source строится тут же, не хранится в
  // EmailDigest — провайдер/адрес читаются из самого ящика (актуальны на
  // момент открытия, не на момент генерации сводки, что и правильно: тот же
  // ящик, просто более свежие метаданные).
  @Get('digests')
  async listDigests(@Query('limit') rawLimit: string | undefined, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    const limit = Number(rawLimit);
    const digests = await this.query.listDigests(mailbox.id, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 90) : 30);
    return { source: this.digestSource(mailbox), digests };
  }

  // Раздел 9/17 ТЗ — живой список папок ящика (не из синка — владельцу
  // нужно видеть ровно то, что есть на сервере прямо сейчас, в том числе
  // папку, которую он только что создал сам через Mail.ru веб-интерфейс),
  // для выбора папки-архива, когда \Archive не нашлась автоматически
  // (ARCHIVE_FOLDER_MISSING у пункта плана).
  @Get('folders')
  async listFolders(@CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    const session = await this.sessions.openSession(mailbox.id);
    try {
      return await session.listAllFolders();
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  // Создаёт папку живьём на сервере (раздел 9 ТЗ: created=false, если такая
  // уже была — не плодит дубликат) и сразу заносит её в уже синкнутый
  // список (store.upsertFolder), чтобы анализ плана (listFolders из БД)
  // увидел её без ожидания следующего синка.
  @Post('folders')
  async createFolder(@Body() dto: CreateMailFolderDto, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    const session = await this.sessions.openSession(mailbox.id);
    try {
      const folder = await session.createFolder(dto.parentPath ?? null, dto.name);
      await this.store.upsertFolder(mailbox.id, folder.path, folder.role);
      return folder;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  @Get('digests/:id')
  async getDigest(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    const digest = await this.query.getDigest(mailbox.id, id);
    return { source: this.digestSource(mailbox), ...digest };
  }

  private digestSource(mailbox: { provider: string; emailAddress: string }): string {
    return `${PROVIDER_LABELS[mailbox.provider as keyof typeof PROVIDER_LABELS] ?? mailbox.provider}, ${mailbox.emailAddress}`;
  }

  private async requireMailbox(owner: DataOwner) {
    const mailbox = await this.store.getMailboxStatusByEmployee(owner.id);
    if (!mailbox) throw new NotFoundException('Почта не подключена');
    return mailbox;
  }
}
