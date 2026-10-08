import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { IdempotencyService } from '../common/idempotency.service';
import { fixMultipartFileName } from '../common/http/multipart-filename';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_FILE_SIZE } from '../files/dto/upload-file.dto';
import { TripsService, MAX_MATERIALS_PER_RUN, type MaterialUpload } from './trips.service';
import { TripChangesService } from './trip-changes.service';
import { TripEditService } from './trip-edit.service';
import { TripMembersService } from './trip-members.service';
import { TripIntegrationsService } from './trip-integrations.service';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripLegDto } from './dto/update-trip-leg.dto';
import { UpdateTripEventDto } from './dto/update-trip-event.dto';
import { UpdateTripStayDto } from './dto/update-trip-stay.dto';
import { UpdateTripContactDto } from './dto/update-trip-contact.dto';
import { AddTripMemberDto } from './dto/add-trip-member.dto';
import { ProposeTripTaskDto } from './dto/propose-trip-task.dto';
import { CreateTripDto } from './dto/create-trip.dto';
import { CreateTripLegDto } from './dto/create-trip-leg.dto';
import { CreateTripEventDto } from './dto/create-trip-event.dto';
import { CreateTripStayDto } from './dto/create-trip-stay.dto';
import { CreateTripContactDto } from './dto/create-trip-contact.dto';
import { CreateExtractedFactDto } from './dto/create-extracted-fact.dto';
import { UpdateExtractedFactDto } from './dto/update-extracted-fact.dto';

function toMaterials(files: Express.Multer.File[] | undefined): MaterialUpload[] {
  if (!files || files.length === 0) throw new BadRequestException('Нужен хотя бы один материал');
  const rejected = files.filter((f) => !ALLOWED_UPLOAD_MIME_TYPES.includes(f.mimetype));
  if (rejected.length > 0) throw new BadRequestException(`Недопустимый тип файла: ${rejected.map((f) => f.originalname).join(', ')}`);
  return files.map((f) => ({ buffer: f.buffer, originalName: fixMultipartFileName(f.originalname), mimeType: f.mimetype }));
}

// Агент поездок (ТЗ 08.10.2026) — без @Roles(OWNER): trips.create
// проверяется флагом canCreateTrips (не все руководители), остальной
// доступ — через TripMember конкретной поездки (раздел 9: создатель и
// путешествующий руководитель могут быть разными людьми, участник не
// обязан быть OWNER).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly changes: TripChangesService,
    private readonly edit: TripEditService,
    private readonly members: TripMembersService,
    private readonly integrations: TripIntegrationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // Раздел 3 ТЗ — "Собрать из материалов". Idempotency-Key защищает от
  // двойного тапа/ретрая одного и того же HTTP-запроса; дедупликация по
  // содержимому самого пакета (повторная отправка тех же файлов позже,
  // новым запросом) — отдельно, внутри TripsService.createRun.
  @Post('runs')
  @UseInterceptors(FilesInterceptor('files', MAX_MATERIALS_PER_RUN, { limits: { fileSize: MAX_UPLOAD_FILE_SIZE } }))
  async createRun(@UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    const materials = toMaterials(files);
    const idemBody = { files: materials.map((m) => ({ name: m.originalName, size: m.buffer.length, mimeType: m.mimeType })) };
    const { body } = await this.idempotency.run(user.id, idemKey, 'trips.runs.create', idemBody, () => this.trips.createRun(user, materials));
    return body;
  }

  @Get('runs')
  listRuns(@CurrentUser() user: AuthenticatedUser) {
    return this.trips.listMyRuns(user);
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trips.getRun(user, id);
  }

  @Get()
  listTrips(@CurrentUser() user: AuthenticatedUser) {
    return this.trips.listTrips(user);
  }

  // Полный CRUD — создание карточки напрямую, без материалов.
  @Post()
  createManual(@Body() dto: CreateTripDto, @CurrentUser() user: AuthenticatedUser) {
    return this.trips.createManual(user, dto);
  }

  @Delete(':id')
  async deleteTrip(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.trips.deleteTrip(user, id);
    return { ok: true };
  }

  // Приоритет 2 ТЗ — "Добавить информацию" всегда адресовано ВЫБРАННОЙ
  // поездке (:id в пути), никогда не создаёт тихо новую.
  @Post(':id/materials')
  @UseInterceptors(FilesInterceptor('files', MAX_MATERIALS_PER_RUN, { limits: { fileSize: MAX_UPLOAD_FILE_SIZE } }))
  async addMaterials(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    const materials = toMaterials(files);
    const idemBody = { tripId: id, files: materials.map((m) => ({ name: m.originalName, size: m.buffer.length, mimeType: m.mimeType })) };
    const { body } = await this.idempotency.run(user.id, idemKey, 'trips.materials.add', idemBody, () => this.trips.addMaterialsToTrip(user, id, materials));
    return body;
  }

  @Get(':id/changes')
  listChanges(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.changes.listChanges(user, id);
  }

  @Post(':id/changes/approve-all')
  approveAllChanges(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.changes.approveAll(user, id);
  }

  @Post(':id/changes/:changeId/approve')
  async approveChange(@Param('id') id: string, @Param('changeId') changeId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.changes.approve(user, id, changeId);
    return { ok: true };
  }

  @Post(':id/changes/:changeId/reject')
  async rejectChange(@Param('id') id: string, @Param('changeId') changeId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.changes.reject(user, id, changeId);
    return { ok: true };
  }

  @Get(':id/revisions')
  listRevisions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.changes.listRevisions(user, id);
  }

  @Get(':id/members')
  listMembers(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.members.listMembers(user, id);
  }

  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddTripMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.addOrUpdateMember(user, id, dto);
  }

  @Delete(':id/members/:employeeId')
  async removeMember(@Param('id') id: string, @Param('employeeId') employeeId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.members.removeMember(user, id, employeeId);
    return { ok: true };
  }

  @Post(':id/events/:eventId/add-to-calendar')
  addEventToCalendar(@Param('id') id: string, @Param('eventId') eventId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.integrations.addEventToCalendar(user, id, eventId);
  }

  @Post(':id/tasks')
  proposeTask(@Param('id') id: string, @Body() dto: ProposeTripTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.integrations.proposeTask(user, id, dto);
  }

  @Patch(':id')
  updateTrip(@Param('id') id: string, @Body() dto: UpdateTripDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateTrip(user, id, dto);
  }

  @Post(':id/legs')
  createLeg(@Param('id') id: string, @Body() dto: CreateTripLegDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.createLeg(user, id, dto);
  }

  @Patch(':id/legs/:legId')
  updateLeg(@Param('id') id: string, @Param('legId') legId: string, @Body() dto: UpdateTripLegDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateLeg(user, id, legId, dto);
  }

  @Delete(':id/legs/:legId')
  async deleteLeg(@Param('id') id: string, @Param('legId') legId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.edit.deleteLeg(user, id, legId);
    return { ok: true };
  }

  @Post(':id/events')
  createEvent(@Param('id') id: string, @Body() dto: CreateTripEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.createEvent(user, id, dto);
  }

  @Patch(':id/events/:eventId')
  updateEvent(@Param('id') id: string, @Param('eventId') eventId: string, @Body() dto: UpdateTripEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateEvent(user, id, eventId, dto);
  }

  @Delete(':id/events/:eventId')
  async deleteEvent(@Param('id') id: string, @Param('eventId') eventId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.edit.deleteEvent(user, id, eventId);
    return { ok: true };
  }

  @Post(':id/stays')
  createStay(@Param('id') id: string, @Body() dto: CreateTripStayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.createStay(user, id, dto);
  }

  @Patch(':id/stays/:stayId')
  updateStay(@Param('id') id: string, @Param('stayId') stayId: string, @Body() dto: UpdateTripStayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateStay(user, id, stayId, dto);
  }

  @Delete(':id/stays/:stayId')
  async deleteStay(@Param('id') id: string, @Param('stayId') stayId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.edit.deleteStay(user, id, stayId);
    return { ok: true };
  }

  @Post(':id/contacts')
  createContact(@Param('id') id: string, @Body() dto: CreateTripContactDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.createContact(user, id, dto);
  }

  @Patch(':id/contacts/:contactId')
  updateContact(@Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: UpdateTripContactDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateContact(user, id, contactId, dto);
  }

  @Delete(':id/contacts/:contactId')
  async deleteContact(@Param('id') id: string, @Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.edit.deleteContact(user, id, contactId);
    return { ok: true };
  }

  @Post(':id/facts')
  createFact(@Param('id') id: string, @Body() dto: CreateExtractedFactDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.createFact(user, id, dto);
  }

  @Patch(':id/facts/:factId')
  updateFact(@Param('id') id: string, @Param('factId') factId: string, @Body() dto: UpdateExtractedFactDto, @CurrentUser() user: AuthenticatedUser) {
    return this.edit.updateFact(user, id, factId, dto);
  }

  @Delete(':id/facts/:factId')
  async deleteFact(@Param('id') id: string, @Param('factId') factId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.edit.deleteFact(user, id, factId);
    return { ok: true };
  }

  @Get(':id')
  getTrip(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trips.getTrip(user, id);
  }
}
