import type Anthropic from '@anthropic-ai/sdk';

// Агент поездок (ТЗ 08.10.2026, раздел 5/8/18) — чистый билдер промпта/схемы
// тула + content-блока для ОДНОГО материала, тот же приём, что mail/mail-analysis.ts:
// логика промпта тестируется без живого API-ключа, инжектируемый сервис
// (trip-extraction.service.ts) занимается только вызовом Anthropic.
//
// В отличие от mail-analysis.ts (текстовый вход), здесь материал передаётся
// МУЛЬТИМОДАЛЬНО (document/image content block) — билеты и скриншоты часто
// значимы по вёрстке (номер места, QR-код), извлечение в чистый текст
// потеряло бы это. DOCX/XLSX из общего upload-allowlist НЕ входят в
// extractable-подмножество этой версии — у Claude нет нативного блока для
// них, а превращать .docx-zip в текст через toString() дало бы мусор;
// такой материал помечается unreadable без вызова модели (экономия вызова).

export const EXTRACTABLE_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/csv'] as const;

export function isExtractableMimeType(mimeType: string): boolean {
  return (EXTRACTABLE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export const TRIP_LEG_MODES = ['FLIGHT', 'TRAIN', 'CAR', 'OTHER'] as const;
export const TRIP_BOOKING_STATUSES = ['BOOKED', 'PROPOSED', 'UNCONFIRMED'] as const;
export const TRIP_CONTACT_ROLES = ['ORGANIZER_HOST', 'RECEIVING_PARTY', 'DELEGATE', 'OTHER'] as const;

export type TripLegModeValue = (typeof TRIP_LEG_MODES)[number];
export type TripBookingStatusValue = (typeof TRIP_BOOKING_STATUSES)[number];
export type TripContactRoleValue = (typeof TRIP_CONTACT_ROLES)[number];

// Раздел 18 ТЗ — живой баг 08.10.2026: исходная схема тула (23 nullable/
// union-параметра — top(2)+LEG(8)+EVENT(6)+STAY(4)+CONTACT(3)) превышала
// жёсткий лимит Anthropic API в 16 union-типизированных параметров на
// инструмент ("too many parameters with union types... exponential
// compilation cost") — КАЖДЫЙ вызов extractOne() падал 400 и тихо уходил в
// UNREADABLE/FAILED, что не было замечено раньше, т.к. живой вызов с
// реальным файлом не делался до этого дня. Раздел времени пояса
// (departTimeZoneOffsetMinutes и т.п.) свёрнут в сам ISO-timestamp (смещение
// как суффикс "+05:00" — валидный ISO 8601, парсится в
// trip-compose.ts.parseIsoWithOffset), carrier+referenceCode объединены в
// bookingReference, TripEvent.notes и TripStay.name убраны из
// автоизвлечения, TripContact.organization убран — ничего из этого не
// теряется безвозвратно: соответствующие колонки в БД остаются, просто не
// заполняются автоматически (можно дозаполнить вручную через PATCH).
// Итог — 15 union-параметров, см. trip-extraction.spec.ts, тест на точное
// совпадение required-списков фиксирует это число на будущее.
export interface TripExtractedLeg {
  mode: TripLegModeValue;
  fromLocation: string | null;
  toLocation: string | null;
  departAt: string | null;
  arriveAt: string | null;
  bookingReference: string | null;
  bookingStatus: TripBookingStatusValue;
}

export interface TripExtractedEvent {
  title: string;
  startAt: string | null;
  endAt: string | null;
  location: string | null;
}

export interface TripExtractedStay {
  address: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  bookingStatus: TripBookingStatusValue;
}

export interface TripExtractedContact {
  name: string;
  role: TripContactRoleValue;
  email: string | null;
  phone: string | null;
}

export interface TripExtractedFactEntry {
  key: string;
  value: string;
}

export interface TripExtractionDraft {
  readable: boolean;
  summaryHint: string | null;
  destinationHint: string | null;
  legs: TripExtractedLeg[];
  events: TripExtractedEvent[];
  stays: TripExtractedStay[];
  contacts: TripExtractedContact[];
  facts: TripExtractedFactEntry[];
  issues: string[];
}

const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
// Датавремя — обычный ISO 8601 строкой; смещение часового пояса, если
// известно, передаётся суффиксом САМОЙ строки ("2026-12-01T06:00:00+05:00"),
// а не отдельным числовым параметром — это валидный ISO 8601 и экономит
// union-параметр схемы (см. комментарий на интерфейсах выше). Для события
// с известной датой, но неизвестным часом — просто "YYYY-MM-DD" в этом же
// поле (определяется по длине строки в trip-compose.ts.isDateOnly).
const NULLABLE_DATETIME = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

const LEG_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: TRIP_LEG_MODES },
    fromLocation: NULLABLE_STRING,
    toLocation: NULLABLE_STRING,
    departAt: NULLABLE_DATETIME,
    arriveAt: NULLABLE_DATETIME,
    bookingReference: { ...NULLABLE_STRING, description: 'Перевозчик и/или номер рейса/бронирования одной строкой, например "Air Astana KC901".' },
    bookingStatus: { type: 'string', enum: TRIP_BOOKING_STATUSES },
  },
  required: ['mode', 'fromLocation', 'toLocation', 'departAt', 'arriveAt', 'bookingReference', 'bookingStatus'],
  additionalProperties: false,
} as const;

const EVENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    startAt: { ...NULLABLE_DATETIME, description: 'Полный ISO-момент, либо просто "YYYY-MM-DD", если известна только дата.' },
    endAt: NULLABLE_DATETIME,
    location: NULLABLE_STRING,
  },
  required: ['title', 'startAt', 'endAt', 'location'],
  additionalProperties: false,
} as const;

const STAY_SCHEMA = {
  type: 'object',
  properties: {
    address: { ...NULLABLE_STRING, description: 'Название и/или адрес проживания одной строкой, например "Hilton Istanbul, Istiklal Cad. 123".' },
    checkInAt: NULLABLE_DATETIME,
    checkOutAt: NULLABLE_DATETIME,
    bookingStatus: { type: 'string', enum: TRIP_BOOKING_STATUSES },
  },
  required: ['address', 'checkInAt', 'checkOutAt', 'bookingStatus'],
  additionalProperties: false,
} as const;

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string', enum: TRIP_CONTACT_ROLES },
    email: NULLABLE_STRING,
    phone: NULLABLE_STRING,
  },
  required: ['name', 'role', 'email', 'phone'],
  additionalProperties: false,
} as const;

const FACT_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    value: { type: 'string' },
  },
  required: ['key', 'value'],
  additionalProperties: false,
} as const;

export function buildExtractionTool(): Anthropic.Tool {
  return {
    name: 'extract_trip_facts',
    description: 'Извлечь факты о поездке из одного материала (билет, программа, переписка, скриншот).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        readable: { type: 'boolean', description: 'false, если материал нечитаем/повреждён/не по теме поездки.' },
        summaryHint: { ...NULLABLE_STRING, description: 'Одно предложение — что это за материал.' },
        destinationHint: { ...NULLABLE_STRING, description: 'Город/страна назначения, если упомянут.' },
        legs: { type: 'array', items: LEG_SCHEMA },
        events: { type: 'array', items: EVENT_SCHEMA },
        stays: { type: 'array', items: STAY_SCHEMA },
        contacts: { type: 'array', items: CONTACT_SCHEMA },
        facts: { type: 'array', items: FACT_SCHEMA },
        issues: { type: 'array', items: { type: 'string' }, description: 'Неоднозначности/конфликты, замеченные именно в этом материале.' },
      },
      required: ['readable', 'summaryHint', 'destinationHint', 'legs', 'events', 'stays', 'contacts', 'facts', 'issues'],
      additionalProperties: false,
    },
  };
}

export function buildExtractionSystemPrompt(): string {
  return `Ты извлекаешь факты о деловой поездке из ОДНОГО материала (билет, программа, письмо, скриншот, приглашение).
Вызови инструмент extract_trip_facts ровно один раз.

Правила (строго):
- Никогда не придумывай дату/время/адрес, которых нет в материале. Нет данных — null, не оценка "на глаз".
- Различай "забронировано" (есть номер билета/бронирования, явное подтверждение), "предложено" (черновик/вариант
  без подтверждения) и "подтверждения не найдено" (bookingStatus=UNCONFIRMED) — никогда не присваивай BOOKED
  плану или варианту без явного подтверждения в самом материале.
- Даты/время — строкой в формате ISO 8601. Если известен час, но известен и часовой пояс — включи смещение в
  саму строку, например "2026-12-01T06:00:00+05:00". Если часовой пояс не понятен из материала — просто
  "2026-12-01T06:00:00" без смещения. Если у события известна только дата, без часа — "2026-12-01" (10 символов,
  без времени) и ничего не изобретай для часа.
- bookingReference (у перелёта/переезда) — перевозчик и/или номер рейса/бронирования в одну строку, например
  "Air Astana KC901"; если в материале есть только одно из двух — пиши то, что есть.
- facts — только то, что не укладывается в leg/event/stay/contact (виза, бюджет, особые требования и т.п.).
- issues — конкретные проблемы именно этого материала: нечитаемый скан, противоречие внутри самого документа,
  обрезанный текст. Общие фразы типа "всё хорошо" не нужны — для этого issues просто пустой массив.
- readable=false только если материал реально не удалось разобрать (повреждён/нечитаемый скан/пустой) — не
  используй это как способ сказать "не по теме поездки", для этого просто оставь массивы пустыми.`;
}

function base64Of(buffer: Buffer): string {
  return buffer.toString('base64');
}

// Content-блок для ОДНОГО материала — null, если формат не входит в
// extractable-подмножество (вызывающий код должен такой материал не
// отправлять в модель вообще, см. isExtractableMimeType).
export function buildMaterialContentBlock(buffer: Buffer, mimeType: string, fileName: string): Anthropic.Messages.ContentBlockParam | null {
  if (mimeType === 'application/pdf') {
    return {
      type: 'document',
      title: fileName,
      source: { type: 'base64', media_type: 'application/pdf', data: base64Of(buffer) },
    };
  }
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp' || mimeType === 'image/gif') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: base64Of(buffer) },
    };
  }
  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return { type: 'text', text: buffer.toString('utf-8').slice(0, MAX_TEXT_MATERIAL_CHARS) };
  }
  return null;
}

export const MAX_TEXT_MATERIAL_CHARS = 50_000;
