import { BadRequestException, Controller, Get, Headers, Param, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { IdempotencyService } from '../common/idempotency.service';
import { fixMultipartFileName } from '../common/http/multipart-filename';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_FILE_SIZE } from '../files/dto/upload-file.dto';
import { TripsService, MAX_MATERIALS_PER_RUN } from './trips.service';

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
    private readonly idempotency: IdempotencyService,
  ) {}

  // Раздел 3 ТЗ — "Собрать из материалов". Idempotency-Key защищает от
  // двойного тапа/ретрая одного и того же HTTP-запроса; дедупликация по
  // содержимому самого пакета (повторная отправка тех же файлов позже,
  // новым запросом) — отдельно, внутри TripsService.createRun.
  @Post('runs')
  @UseInterceptors(FilesInterceptor('files', MAX_MATERIALS_PER_RUN, { limits: { fileSize: MAX_UPLOAD_FILE_SIZE } }))
  async createRun(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    if (!files || files.length === 0) throw new BadRequestException('Нужен хотя бы один материал');
    const rejected = files.filter((f) => !ALLOWED_UPLOAD_MIME_TYPES.includes(f.mimetype));
    if (rejected.length > 0) throw new BadRequestException(`Недопустимый тип файла: ${rejected.map((f) => f.originalname).join(', ')}`);

    const materials = files.map((f) => ({ buffer: f.buffer, originalName: fixMultipartFileName(f.originalname), mimeType: f.mimetype }));
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

  @Get(':id')
  getTrip(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trips.getTrip(user, id);
  }
}
