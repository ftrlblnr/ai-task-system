import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} не разрешён`));
      }
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
