import ExcelJS from 'exceljs';
import { TASK_STATUS_RU, type TasksService } from '../tasks/tasks.service';

// Stage 2, Phase G — форма элемента списка ровно та же, что уже отдаёт
// TasksService.findAll() (переиспользуется, а не дублируется): isOverdue,
// assignee.fullName, dueDate — сырой Date, уже посчитанные поля, тот же
// источник, которым уже пользуется AssistantToolsService.getTasks для
// карточек в чате — здесь просто другой рендер того же результата.
export type TaskExportItem = Awaited<ReturnType<TasksService['findAll']>>[number];

// Третья копия тех же лейблов приоритета (первые две — apps/web и
// apps/miniapp/src/lib/labels.ts) — apps/api не подключает фронтендные
// пакеты (см. комментарий в dto/message-part-data.dto.ts), тот же
// осознанный компромисс, что уже сделан для TASK_STATUS_RU в
// tasks.service.ts.
const PRIORITY_RU: Record<string, string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
  CRITICAL: 'Критический',
};

export async function buildTasksWorkbookBuffer(tasks: TaskExportItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Задачи');
  sheet.columns = [
    { header: 'Задача', key: 'title', width: 40 },
    { header: 'Статус', key: 'status', width: 18 },
    { header: 'Приоритет', key: 'priority', width: 14 },
    { header: 'Исполнитель', key: 'assignee', width: 24 },
    { header: 'Срок', key: 'dueDate', width: 14 },
    { header: 'Просрочена', key: 'overdue', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const t of tasks) {
    sheet.addRow({
      title: t.title,
      status: TASK_STATUS_RU[t.status] ?? t.status,
      priority: PRIORITY_RU[t.priority] ?? t.priority,
      assignee: t.assignee?.fullName ?? '',
      dueDate: t.dueDate ? t.dueDate.toLocaleDateString('ru-RU') : '',
      overdue: t.isOverdue ? 'Да' : 'Нет',
    });
  }

  // exceljs объявляет собственный ambient `interface Buffer extends
  // ArrayBuffer {}` (не подключает @types/node) — writeBuffer() формально
  // возвращает этот несовместимый тип-заглушку, не настоящий Node Buffer
  // (TS2769/TS2740, поймано в nest build, не в ts-jest — тот же
  // повторяющийся паттерн, что уже был с TS2352 в Phase F.1). Buffer.from
  // на границе — реальный рантайм-объект и там, и там один и тот же (это
  // чисто расхождение в типах, не в поведении), явное преобразование
  // просто согласовывает объявленный тип с тем, что дальше по цепочке
  // (FilesService.createGenerated) ожидает настоящий Buffer.
  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.from(raw as unknown as ArrayBuffer);
}
