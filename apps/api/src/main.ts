import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Web App и Telegram Mini App — разные origin (раздел 14.2 ТЗ), оба должны
  // проходить CORS. MINIAPP_URL опционален — до его настройки Mini App
  // просто не сможет вызывать API из браузера вне Telegram (сам Telegram
  // WebView не всегда подчиняется CORS так же строго, как обычный браузер,
  // но полагаться на это не стоит).
  //
  // Функция вместо массива — с массивом `cors` пакет (через Express-адаптер
  // NestJS) на практике всегда отражал ПЕРВЫЙ элемент массива в
  // Access-Control-Allow-Origin независимо от реального Origin запроса
  // (проверено вручную curl'ом с разными Origin, включая заведомо чужой —
  // ответ был идентичен), из-за чего браузер блокировал ответы с любого
  // origin, кроме первого в списке. Функция — однозначно рабочий способ
  // для NestJS enableCors с несколькими origin.
  const allowedOrigins = [process.env.WEB_APP_URL ?? 'http://localhost:3000', process.env.MINIAPP_URL].filter(
    (origin): origin is string => Boolean(origin),
  );
  app.enableCors({
    // Параметры аннотированы явно (аудит 10.09.2026, п. 5.2) — без этого
    // TS не выводит тип callback из объектного литерала enableCors(), и
    // @typescript-eslint/no-unsafe-call (первый реальный прогон lint в CI)
    // справедливо ругался на вызов callback(...) как на any.
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // callback(null, false), не callback(new Error(...)) — аудит
      // 10.09.2026, п. 2.13: передача Error превращает обычный CORS-отказ
      // в необработанное исключение (500 клиенту) вместо чистого "не
      // разрешено" (браузер и так блокирует ответ без нужных заголовков).
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Аудит 10.09.2026, п. 2.12: несуществующий assigneeId/taskProfileId/
  // parentTaskId и т.п. отдавал 500 вместо внятной 400 — см. комментарий в
  // самом фильтре.
  app.useGlobalFilters(new PrismaExceptionFilter());

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
