import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskProfileDto, UpdateTaskProfileDto } from './dto/task-profile.dto';

const INCLUDE = {
  requiredCompetencies: { select: { competency: { select: { id: true, name: true, description: true } } } },
} as const;

@Injectable()
export class TaskProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.taskProfile.findMany({ include: INCLUDE, orderBy: [{ category: 'asc' }, { type: 'asc' }] });
  }

  async findOne(id: string) {
    const profile = await this.prisma.taskProfile.findUnique({ where: { id }, include: INCLUDE });
    if (!profile) throw new NotFoundException('Профиль задачи не найден');
    return profile;
  }

  create(dto: CreateTaskProfileDto) {
    return this.prisma.taskProfile.create({
      data: {
        category: dto.category,
        type: dto.type,
        description: dto.description,
        requiredCompetencies: dto.requiredCompetencyIds
          ? { create: dto.requiredCompetencyIds.map((competencyId) => ({ competencyId })) }
          : undefined,
      },
      include: INCLUDE,
    });
  }

  async update(id: string, dto: UpdateTaskProfileDto) {
    await this.findOne(id);

    if (dto.requiredCompetencyIds) {
      await this.prisma.taskProfileCompetency.deleteMany({ where: { taskProfileId: id } });
    }

    return this.prisma.taskProfile.update({
      where: { id },
      data: {
        category: dto.category,
        type: dto.type,
        description: dto.description,
        requiredCompetencies: dto.requiredCompetencyIds
          ? { create: dto.requiredCompetencyIds.map((competencyId) => ({ competencyId })) }
          : undefined,
      },
      include: INCLUDE,
    });
  }
}
