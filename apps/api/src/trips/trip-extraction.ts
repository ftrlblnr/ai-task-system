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

export interface TripExtractedLeg {
  mode: TripLegModeValue;
  fromLocation: string | null;
  toLocation: string | null;
  departAt: string | null;
  departTimeZoneOffsetMinutes: number | null;
  arriveAt: string | null;
  arriveTimeZoneOffsetMinutes: number | null;
  carrier: string | null;
  referenceCode: string | null;
  bookingStatus: TripBookingStatusValue;
}

export interface TripExtractedEvent {
  title: string;
  startAt: string | null;
  startTimeZoneOffsetMinutes: number | null;
  dateOnly: string | null;
  endAt: string | null;
  location: string | null;
  notes: string | null;
}

export interface TripExtractedStay {
  name: string | null;
  address: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  bookingStatus: TripBookingStatusValue;
}

export interface TripExtractedContact {
  name: string;
  role: TripContactRoleValue;
  organization: string | null;
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
const NULLABLE_NUMBER = { anyOf: [{ type: 'integer' }, { type: 'null' }] } as const;
const NULLABLE_DATETIME = { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] } as const;
const NULLABLE_DATE = { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] } as const;

const LEG_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: TRIP_LEG_MODES },
    fromLocation: NULLABLE_STRING,
    toLocation: NULLABLE_STRING,
    departAt: NULLABLE_DATETIME,
    departTimeZoneOffsetMinutes: NULLABLE_NUMBER,
    arriveAt: NULLABLE_DATETIME,
    arriveTimeZoneOffsetMinutes: NULLABLE_NUMBER,
    carrier: NULLABLE_STRING,
    referenceCode: NULLABLE_STRING,
    bookingStatus: { type: 'string', enum: TRIP_BOOKING_STATUSES },
  },
  required: [
    'mode',
    'fromLocation',
    'toLocation',
    'departAt',
    'departTimeZoneOffsetMinutes',
    'arriveAt',
    'arriveTimeZoneOffsetMinutes',
    'carrier',
    'referenceCode',
    'bookingStatus',
  ],
  additionalProperties: false,
} as const;

const EVENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    startAt: NULLABLE_DATETIME,
    startTimeZoneOffsetMinutes: NULLABLE_NUMBER,
    dateOnly: NULLABLE_DATE,
    endAt: NULLABLE_DATETIME,
    location: NULLABLE_STRING,
    notes: NULLABLE_STRING,
  },
  required: ['title', 'startAt', 'startTimeZoneOffsetMinutes', 'dateOnly', 'endAt', 'location', 'notes'],
  additionalProperties: false,
} as const;

const STAY_SCHEMA = {
  type: 'object',
  properties: {
    name: NULLABLE_STRING,
    address: NULLABLE_STRING,
    checkInAt: NULLABLE_DATETIME,
    checkOutAt: NULLABLE_DATETIME,
    bookingStatus: { type: 'string', enum: TRIP_BOOKING_STATUSES },
  },
  required: ['name', 'address', 'checkInAt', 'checkOutAt', 'bookingStatus'],
  additionalProperties: false,
} as const;

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string', enum: TRIP_CONTACT_ROLES },
    organization: NULLABLE_STRING,
    email: NULLABLE_STRING,
    phone: NULLABLE_STRING,
  },
  required: ['name', 'role', 'organization', 'email', 'phone'],
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
- Если у события известна дата, но не известен точный час — заполни dateOnly, оставь startAt null. Не изобретай час.
- Часовой пояс указывай только если он явно понятен из материала (например, код аэропорта/город); если не уверен —
  null.
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
