import { NotFoundException } from '@nestjs/common';
import { TripRightsService, type TripActor } from './trip-rights.service';

function prismaMock(overrides: { trip?: unknown; tripMember?: unknown } = {}) {
  return {
    trip: { findUnique: jest.fn().mockResolvedValue(overrides.trip ?? null) },
    tripMember: { findUnique: jest.fn().mockResolvedValue(overrides.tripMember ?? null) },
  };
}

const EMPLOYEE: TripActor = { id: 'e1', role: 'EMPLOYEE' };

describe('TripRightsService.assertPermission', () => {
  it('нет членства в поездке — NotFoundException (404, не 403)', async () => {
    const prisma = prismaMock({ tripMember: null });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', EMPLOYEE, 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('VIEWER не может materials.add — NotFoundException', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'VIEWER' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', EMPLOYEE, 'materials.add')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('EDITOR может materials.add и edit, но не manage_access', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'EDITOR' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', EMPLOYEE, 'materials.add')).resolves.toBe('EDITOR');
    await expect(service.assertPermission('t1', EMPLOYEE, 'edit')).resolves.toBe('EDITOR');
    await expect(service.assertPermission('t1', EMPLOYEE, 'manage_access')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ORGANIZER может всё', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'ORGANIZER' } });
    const service = new TripRightsService(prisma as never);
    for (const permission of ['view', 'materials.add', 'edit', 'approve', 'manage_access', 'archive'] as const) {
      await expect(service.assertPermission('t1', EMPLOYEE, permission)).resolves.toBe('ORGANIZER');
    }
  });

  it('APPROVER может view/approve, но не edit', async () => {
    const prisma = prismaMock({ tripMember: { accessRole: 'APPROVER' } });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', EMPLOYEE, 'approve')).resolves.toBe('APPROVER');
    await expect(service.assertPermission('t1', EMPLOYEE, 'edit')).rejects.toBeInstanceOf(NotFoundException);
  });

  // Ролевая модель 20.10.2026: руководитель и администратор ведут все поездки.
  it.each(['OWNER', 'ADMIN'] as const)('%s без членства — права ORGANIZER на существующую поездку', async (role) => {
    const prisma = prismaMock({ trip: { id: 't1' }, tripMember: null });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', { id: 'm1', role }, 'manage_access')).resolves.toBe('ORGANIZER');
    expect(prisma.tripMember.findUnique).not.toHaveBeenCalled();
  });

  it('администратор и несуществующая поездка — NotFoundException', async () => {
    const prisma = prismaMock({ trip: null });
    const service = new TripRightsService(prisma as never);
    await expect(service.assertPermission('t1', { id: 'm1', role: 'ADMIN' }, 'view')).rejects.toBeInstanceOf(NotFoundException);
  });
});
