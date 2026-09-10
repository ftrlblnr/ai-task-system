import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CompetencyDto } from './dto/competency.dto';

@Injectable()
export class CompetenciesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.competency.findMany({ orderBy: { name: 'asc' } });
  }

  create(dto: CompetencyDto) {
    return this.prisma.competency.create({ data: dto });
  }

  async update(id: string, dto: Partial<CompetencyDto>) {
    await this.ensureExists(id);
    return this.prisma.competency.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.prisma.competency.delete({ where: { id } });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.competency.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Компетенция не найдена');
  }
}
