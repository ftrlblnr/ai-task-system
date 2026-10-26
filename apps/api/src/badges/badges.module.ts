import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ReceptionModule } from '../reception/reception.module';
import { RecommendationsModule } from '../recommendations/recommendations.module';
import { MailModule } from '../mail/mail.module';
import { BadgesController } from './badges.controller';
import { BadgesService } from './badges.service';

@Module({
  imports: [TasksModule, ReceptionModule, RecommendationsModule, MailModule],
  controllers: [BadgesController],
  providers: [BadgesService],
})
export class BadgesModule {}
