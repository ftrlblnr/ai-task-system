import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePositionDto } from './dto/position.dto';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.position.findMany({ orderBy: { title: 'asc' } });
  }

  create(dto: CreatePositionDto) {
    return this.prisma.position.create({ data: dto });
  }
}
