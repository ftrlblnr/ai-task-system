import ExcelJS from 'exceljs';
import { buildTasksWorkbookBuffer, type TaskExportItem } from './task-export';

// Round-trip (записали buffer → прочитали обратно тем же ExcelJS) — этого
// достаточно, чтобы поймать реальную порчу формата/данных, без сравнения с
// эталонным бинарным файлом (хрупко к версии библиотеки).
function task(overrides: Partial<TaskExportItem> = {}): TaskExportItem {
  return {
    id: 't1',
    title: 'Подготовить отчёт',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    dueDate: new Date('2026-09-20T00:00:00Z'),
    assignee: { id: 'e1', fullName: 'Иван Иванов' },
    isOverdue: false,
    ...overrides,
  } as TaskExportItem;
}

describe('buildTasksWorkbookBuffer (Stage 2, Phase G)', () => {
  it('формирует читаемый .xlsx с переведёнными статусом/приоритетом и русскими "Да"/"Нет" для просрочки', async () => {
    const buffer = await buildTasksWorkbookBuffer([
      task(),
      task({ id: 't2', title: 'Просроченная задача', status: 'NEW', priority: 'LOW', assignee: null, dueDate: null, isOverdue: true }),
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Задачи');
    expect(sheet).toBeDefined();

    const headerRow = sheet!.getRow(1).values as unknown[];
    expect(headerRow.slice(1)).toEqual(['Задача', 'Статус', 'Приоритет', 'Исполнитель', 'Срок', 'Просрочена']);

    const row1 = sheet!.getRow(2).values as unknown[];
    expect(row1.slice(1)).toEqual(['Подготовить отчёт', 'В работе', 'Высокий', 'Иван Иванов', '20.09.2026', 'Нет']);

    const row2 = sheet!.getRow(3).values as unknown[];
    expect(row2.slice(1)).toEqual(['Просроченная задача', 'Новая', 'Низкий', '', '', 'Да']);
  });

  it('пустой список задач — валидный файл с одной только шапкой', async () => {
    const buffer = await buildTasksWorkbookBuffer([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Задачи');
    expect(sheet!.rowCount).toBe(1);
  });
});
