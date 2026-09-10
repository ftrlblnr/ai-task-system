import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';

// Аудит 10.09.2026, п. 2.12: TasksService.create/update (и другие места,
// где id внешнего сотрудника/профиля/родителя передаётся в Prisma
// напрямую) отдавали 500 Internal Server Error на несуществующий
// assigneeId/taskProfileId/parentTaskId вместо внятной 400 — Prisma просто
// бросает P2003 (нарушение foreign key), которая ничем не обработана,
// долетает до дефолтного обработчика Nest как непредвиденное исключение.
// Глобальный фильтр вместо точечных проверок в каждом сервисе — так же
// покрывает и будущие места, где появится тот же паттерн.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    switch (exception.code) {
      case 'P2003': // Foreign key constraint failed — ссылка на несуществующую запись.
        return response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Одно из указанных значений ссылается на несуществующую запись',
        });
      case 'P2025': // Record to update/delete does not exist.
        return response.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Запись не найдена',
        });
      case 'P2002': // Unique constraint failed.
        return response.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: 'Запись с такими данными уже существует',
        });
      default:
        // Прочие коды Prisma — по-прежнему непредвиденная ошибка, 500, но
        // с тем же чистым форматом ответа, что и у остальных веток здесь.
        return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Внутренняя ошибка сервера',
        });
    }
  }
}
