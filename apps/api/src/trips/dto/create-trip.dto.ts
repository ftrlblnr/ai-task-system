import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { TripPeriodPrecision } from '@prisma/client';

// Полный CRUD — создание карточки поездки напрямую, без материалов
// (раздел 3 ТЗ допускает это как частный случай "создания не требует
// полноты материалов" — здесь материалов вообще нет). Основной путь
// остаётся POST /trips/runs (TripsController.createRun).
export class CreateTripDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  purposeSummary?: string;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @IsOptional()
  @IsEnum(TripPeriodPrecision)
  periodPrecision?: TripPeriodPrecision;
}
