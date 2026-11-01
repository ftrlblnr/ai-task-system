import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { IdempotencyService } from '../common/idempotency.service';
import { MeetingsService } from './meetings.service';
import { MeetingAnalysisService } from './meeting-analysis.service';
import { MeetingProposalsService } from './meeting-proposals.service';
import { ApproveProposalsDto, RejectProposalsDto } from './dto/meeting-proposals.dto';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingSpeakersDto } from './dto/update-meeting-speakers.dto';
import { CreateTasksFromMeetingDto } from './dto/create-tasks-from-meeting.dto';

// Встречи целиком видит только руководитель (раздел 5 ТЗ) — протокол
// может содержать переговоры, кадровые и финансовые темы, не только
// содержимое задач, которые из него извлечены. Подчинённый получает
// только краткий sourceContext на самой задаче (см. TasksService),
// не доступ к этому контроллеру.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('meetings')
@Roles(...MANAGER_ROLES)
export class MeetingsController {
  constructor(
    private readonly meetingsService: MeetingsService,
    private readonly analysis: MeetingAnalysisService,
    private readonly proposals: MeetingProposalsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  @Get()
  findAll() {
    return this.meetingsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.findOne(id, user.id);
  }

  @Post()
  create(@Body() dto: CreateMeetingDto, @CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.create(dto, user.id);
  }

  @Patch(':id/speakers')
  updateSpeakers(@Param('id') id: string, @Body() dto: UpdateMeetingSpeakersDto) {
    return this.meetingsService.updateSpeakers(id, dto.speakerNames);
  }

  @Post(':id/extract-tasks')
  async extractTasks(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { drafts: await this.meetingsService.extractTasks(id, user.id) };
  }

  // Поручения из встреч (AGENT_AND_MEETINGS.md, B.2): разбор только по
  // кнопке. Ответ сразу — сам разбор идёт в воркере, страница опрашивает
  // GET :id/analysis. Idempotency-Key — двойное нажатие не ставит два
  // платных разбора.
  @Post(':id/analysis')
  async startAnalysis(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'meetings.analysis.start', { id }, () => this.analysis.start(id, user.id));
    return body;
  }

  @Get(':id/analysis')
  async analysisState(@Param('id') id: string) {
    return { run: await this.analysis.latest(id) };
  }

  // Предложения последнего разбора + состояние запуска (панель «Поручения»).
  @Get(':id/proposals')
  listProposals(@Param('id') id: string) {
    return this.proposals.list(id);
  }

  @Post(':id/proposals/approve')
  async approveProposals(
    @Param('id') id: string,
    @Body() dto: ApproveProposalsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'meetings.proposals.approve', { id, dto }, () =>
      this.proposals.approve(id, dto.items, user),
    );
    return body;
  }

  @Post(':id/proposals/reject')
  async rejectProposals(
    @Param('id') id: string,
    @Body() dto: RejectProposalsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'meetings.proposals.reject', { id, dto }, () =>
      this.proposals.reject(id, dto.ids, user),
    );
    return body;
  }

  @Post(':id/tasks')
  createTasksFromMeeting(
    @Param('id') id: string,
    @Body() dto: CreateTasksFromMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.createTasksFromMeeting(id, dto.tasks, user);
  }
}
