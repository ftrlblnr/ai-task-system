import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../auth/data-owner';
import { MAILBOX_HEADER } from '../mail/mail-servers';
import { BadgesService } from './badges.service';

// GET /me/badges — счётчики для меню (W5). Любому сотруднику: что ему не
// положено, приходит null. X-Act-As/X-Mailbox-Id — как у /mail.
@UseGuards(JwtAuthGuard, DataOwnerGuard)
@Controller('me')
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Get('badges')
  get(@CurrentUser() user: AuthenticatedUser, @CurrentDataOwner() owner: DataOwner, @Headers(MAILBOX_HEADER) mailboxId: string | undefined) {
    return this.badges.forUser(user, owner, mailboxId);
  }
}
