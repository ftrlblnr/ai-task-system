import { EmployeeResolverService, normalizeAliasText } from './employee-resolver.service';

function makePrisma(aliasRows: { employeeId: string }[] = []) {
  return { employeeAlias: { findMany: jest.fn().mockResolvedValue(aliasRows) } };
}

const CANDIDATES = [
  { id: 'e1', fullName: 'Амир Жаксылыков' },
  { id: 'e2', fullName: 'Жанна Жаксылыкова' },
  { id: 'e3', fullName: 'Алексей Иванов' },
  { id: 'e4', fullName: 'Алексей Петров' },
];

describe('normalizeAliasText', () => {
  it('lowercase, trim, схлопывает пробелы, убирает пунктуацию', () => {
    expect(normalizeAliasText('  Амиру, ')).toBe('амиру');
    expect(normalizeAliasText('«Жанна   Жаксылыкова»')).toBe('жанна жаксылыкова');
  });
});

describe('EmployeeResolverService.resolve', () => {
  it('пустой rawText — NOT_FOUND, не обращается к БД', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('', CANDIDATES);

    expect(result).toEqual({ status: 'NOT_FOUND', employeeId: null });
    expect(prisma.employeeAlias.findMany).not.toHaveBeenCalled();
  });

  it('пустой список кандидатов — NOT_FOUND', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Амир', []);

    expect(result).toEqual({ status: 'NOT_FOUND', employeeId: null });
  });

  it('точное совпадение с alias в БД — RESOLVED', async () => {
    const prisma = makePrisma([{ employeeId: 'e1' }]);
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Амирчик', CANDIDATES);

    expect(result).toEqual({ status: 'RESOLVED', employeeId: 'e1' });
    expect(prisma.employeeAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ normalizedAlias: 'амирчик' }) }),
    );
  });

  it('alias совпадает у двух разных сотрудников — AMBIGUOUS', async () => {
    const prisma = makePrisma([{ employeeId: 'e1' }, { employeeId: 'e3' }]);
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('леша', CANDIDATES);

    expect(result).toEqual({ status: 'AMBIGUOUS', employeeId: null });
  });

  it('точное совпадение с fullName (именительный падеж) — RESOLVED', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Амир Жаксылыков', CANDIDATES);

    expect(result).toEqual({ status: 'RESOLVED', employeeId: 'e1' });
  });

  it('дательный/творительный падеж имени резолвится через эвристику окончаний — RESOLVED', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    // "Амиру" (дательный) → стем "амир", совпадает с "Амир Жаксылыков".
    const dative = await service.resolve('Амиру', CANDIDATES);
    expect(dative).toEqual({ status: 'RESOLVED', employeeId: 'e1' });

    // "Жанну Жаксылыкову" (винительный) → стемы "жанн"/"жаксылыков",
    // совпадают только с "Жанна Жаксылыкова".
    const accusative = await service.resolve('Жанну Жаксылыкову', CANDIDATES);
    expect(accusative).toEqual({ status: 'RESOLVED', employeeId: 'e2' });
  });

  it('два одинаковых имени ("Алексей") без уточняющей фамилии — AMBIGUOUS', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Алексею', CANDIDATES);

    expect(result).toEqual({ status: 'AMBIGUOUS', employeeId: null });
  });

  it('полное имя с фамилией однозначно выбирает нужного "Алексея" — RESOLVED', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Алексею Иванову', CANDIDATES);

    expect(result).toEqual({ status: 'RESOLVED', employeeId: 'e3' });
  });

  it('имя, не похожее ни на одного кандидата — NOT_FOUND', async () => {
    const prisma = makePrisma();
    const service = new EmployeeResolverService(prisma as any);

    const result = await service.resolve('Марине Сергеевне', CANDIDATES);

    expect(result).toEqual({ status: 'NOT_FOUND', employeeId: null });
  });

  it('alias-поиск фильтруется по переданным candidateIds — чужой сотрудник не резолвится', async () => {
    const prisma = makePrisma([]); // findMany сам фильтрует по employeeId: {in: candidateIds} — здесь просто нет строк
    const service = new EmployeeResolverService(prisma as any);

    await service.resolve('амир', [CANDIDATES[1]]); // только Жанна видима

    expect(prisma.employeeAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ employeeId: { in: ['e2'] } }) }),
    );
  });
});
