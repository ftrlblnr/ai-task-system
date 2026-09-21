import { CompanyVocabularyService } from './company-vocabulary.service';

function makePrisma(employees: { fullName: string }[] = [], aliases: { alias: string }[] = []) {
  return {
    employee: { findMany: jest.fn().mockResolvedValue(employees) },
    employeeAlias: { findMany: jest.fn().mockResolvedValue(aliases) },
  };
}

describe('CompanyVocabularyService.getPrompt', () => {
  it('включает имена активных сотрудников, алиасы и статические термины компании', async () => {
    const prisma = makePrisma([{ fullName: 'Амир Жаксылыков' }], [{ alias: 'Амир' }]);
    const service = new CompanyVocabularyService(prisma as any);

    const prompt = await service.getPrompt();

    expect(prompt).toContain('Амир Жаксылыков');
    expect(prompt).toContain('Амир');
    expect(prompt).toContain('GLB');
    expect(prompt).toContain('Plaud');
  });

  it('запрашивает только ACTIVE сотрудников', async () => {
    const prisma = makePrisma();
    const service = new CompanyVocabularyService(prisma as any);

    await service.getPrompt();

    expect(prisma.employee.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'ACTIVE' } }));
  });

  it('кэширует результат — второй вызов не бьёт в БД снова', async () => {
    const prisma = makePrisma([{ fullName: 'Амир Жаксылыков' }]);
    const service = new CompanyVocabularyService(prisma as any);

    const first = await service.getPrompt();
    const second = await service.getPrompt();

    expect(first).toBe(second);
    expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
  });

  it('не превышает ограничение длины (Whisper prompt лимит) — обрезает список терминов, не текст', async () => {
    const manyEmployees = Array.from({ length: 100 }, (_, i) => ({ fullName: `Сотрудник Номер ${i} Длинная Фамилия` }));
    const prisma = makePrisma(manyEmployees);
    const service = new CompanyVocabularyService(prisma as any);

    const prompt = await service.getPrompt();

    expect(prompt.length).toBeLessThanOrEqual(400);
    // Обрезка по границе термина — не обрывает слово посередине.
    expect(prompt.endsWith(',')).toBe(false);
  });
});
