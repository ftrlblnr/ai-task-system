import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDirectionDto } from './dto/direction.dto';

@Injectable()
export class DirectionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.direction.findMany({ orderBy: { title: 'asc' } });
  }

  create(dto: CreateDirectionDto) {
    return this.prisma.direction.create({ data: dto });
  }
}
