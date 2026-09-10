import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { EmployeesModule } from './employees/employees.module';
import { CompetenciesModule } from './competencies/competencies.module';
import { PositionsModule } from './positions/positions.module';
import { MeetingsModule } from './meetings/meetings.module';
import { TaskProfilesModule } from './task-profiles/task-profiles.module';
import { TasksModule } from './tasks/tasks.module';
import { TelegramModule } from './telegram/telegram.module';
import { CalendarModule } from './calendar/calendar.module';
import { PlaudModule } from './plaud/plaud.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    AuditModule,
    AuthModule,
    EmployeesModule,
    CompetenciesModule,
    PositionsModule,
    MeetingsModule,
    TaskProfilesModule,
    TasksModule,
    TelegramModule,
    CalendarModule,
    PlaudModule,
    VoiceModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
