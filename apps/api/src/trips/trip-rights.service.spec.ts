import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TripRightsService } from './trip-rights.service';

function prismaMock(overrides: { employee?: unknown; tripMember?: unknown } = {}) {
  return {
    employee: { findUnique: jest.fn().mockResolvedValue(overrides.employee ?? null) },
    tripMember: { findUnique: jest.fn().mockResolvedValue(overrides.tripMember ?? null) },
  };
}

describe('TripRightsService.assertCanCreateTrips', () => {
  it('canCreateTrips=true — проходит без исключения', async () => {
    const prisma = prismaMock({ employee: { canCreateTrips: true } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertCanCreateTrips('e1')).resolves.toBeUndefined();
  });

  it('canCreateTrips=false — ForbiddenException', async () => {
    const prisma = prismaMock({ employee: { canCreateTrips: false } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertCanCreateTrips('e1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('сотрудник не найден — ForbiddenException (не бросает на null)', async () => {
    const prisma = prismaMock({ employee: null });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertCanCreateTrips('e1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TripRightsService.assertPermission', () => {
  it('нет членства в поездке — NotFoundException (404, не 403)', async () => {
    const prisma = prismaMock({ tripMember: null });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', 'e1', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('VIEWER не может materials.add — NotFoundException', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'VIEWER' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', 'e1', 'materials.add')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('EDITOR может materials.add и edit, но не manage_access', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'EDITOR' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', 'e1', 'materials.add')).resolves.toBe('EDITOR');
    await expect(service.assertPermission('t1', 'e1', 'edit')).resolves.toBe('EDITOR');
    await expect(service.assertPermission('t1', 'e1', 'manage_access')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ORGANIZER может всё', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'ORGANIZER' } });
    const service = new TripRightsService(prisma as never);
    for (const permission of ['view', 'materials.add', 'edit', 'approve', 'manage_access', 'archive'] as const) {
      await expect(service.assertPermission('t1', 'e1', permission)).resolves.toBe('ORGANIZER');
    }
  });

  it('APPROVER может view/approve, но не edit', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'APPROVER' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', 'e1', 'approve')).resolves.toBe('APPROVER');
    await expect(service.assertPermission('t1', 'e1', 'edit')).rejects.toBeInstanceOf(NotFoundException);
  });
});
