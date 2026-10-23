import { formatZoneTime, zoneDayKey, zoneShortName } from './trip-timeline';

// Предложение изменения поездки (ProposedChange) человеческими словами —
// «было → станет» для уточнения записи, список полей для новой записи.
// Общий для web и miniapp (23.10.2026).

export interface ProposedChangeLike {
  entityType: string;
  entityId: string | null;
  fieldKey: string | null;
  previousValue: unknown;
  proposedValue: unknown;
  reason: string | null;
}

export interface ProposedChangeRow {
  label: string;
  before: string | null;
  after: string;
}

export interface ProposedChangeView {
  title: string;
  isUpdate: boolean;
  rows: ProposedChangeRow[];
}

const NEW_TITLES: Record<string, string> = { TRIP_LEG: 'Новый перелёт/переезд', TRIP_EVENT: 'Новое событие программы', TRIP_STAY: 'Новое проживание', TRIP_CONTACT: 'Новый контакт' };

const LABELS: Record<string, string> = {
  mode: 'Вид',
  fromLocation: 'Откуда',
  toLocation: 'Куда',
  departAt: 'Отправление',
  arriveAt: 'Прибытие',
  carrier: 'Перевозчик',
  referenceCode: 'Рейс / бронь',
  bookingStatus: 'Статус',
  title: 'Название',
  startAt: 'Начало',
  endAt: 'Окончание',
  dateOnly: 'Дата',
  location: 'Место',
  notes: 'Примечание',
  name: 'Название / имя',
  address: 'Адрес',
  checkInAt: 'Заезд',
  checkOutAt: 'Выезд',
  organization: 'Организация',
  email: 'Email',
  phone: 'Телефон',
  periodStart: 'Начало поездки',
  periodEnd: 'Окончание поездки',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  bookingStatus: { BOOKED: 'Забронировано', PROPOSED: 'Предложено', UNCONFIRMED: 'Подтверждения не найдено' },
  mode: { FLIGHT: 'Перелёт', TRAIN: 'Поезд', CAR: 'Автомобиль', OTHER: 'Другое' },
};

const OFFSET_KEYS: Record<string, string> = {
  departAt: 'departTimeZoneOffsetMinutes',
  arriveAt: 'arriveTimeZoneOffsetMinutes',
  startAt: 'startTimeZoneOffsetMinutes',
  endAt: 'startTimeZoneOffsetMinutes',
};
const MOMENT_KEYS = new Set(['departAt', 'arriveAt', 'startAt', 'endAt', 'checkInAt', 'checkOutAt', 'periodStart', 'periodEnd']);
const DEFAULT_OFFSET = 300;

function suffixOffset(value: string): number | null {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function formatMoment(value: string, offset: number | null): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(8, 10) + '.' + value.slice(5, 7);
  const zone = offset ?? suffixOffset(value) ?? DEFAULT_OFFSET;
  const day = zoneDayKey(at, zone);
  const tail = zone === DEFAULT_OFFSET ? '' : `, ${zoneShortName(zone)}`;
  return `${day.slice(8, 10)}.${day.slice(5, 7)} ${formatZoneTime(at, zone)}${tail}`;
}

function formatValue(key: string, value: unknown, source: Record<string, unknown>): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (MOMENT_KEYS.has(key) && typeof value === 'string') {
    const offsetKey = OFFSET_KEYS[key];
    const offset = offsetKey && typeof source[offsetKey] === 'number' ? (source[offsetKey] as number) : null;
    // Время из материала несёт пояс суффиксом — он точнее сохранённого.
    return formatMoment(value, suffixOffset(value) ?? offset);
  }
  if (key === 'dateOnly' && typeof value === 'string') return formatMoment(value.slice(0, 10), null);
  const mapped = VALUE_LABELS[key]?.[String(value)];
  return mapped ?? String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function describeProposedChange(change: ProposedChangeLike): ProposedChangeView {
  const next = asRecord(change.proposedValue);
  const prev = asRecord(change.previousValue);

  if (change.entityType === 'TRIP') {
    if (change.fieldKey === 'purposeSummary') {
      return { title: 'Описание цели поездки', isUpdate: true, rows: [{ label: 'Описание', before: typeof change.previousValue === 'string' ? change.previousValue : null, after: String(change.proposedValue ?? '') }] };
    }
    const rows = ['periodStart', 'periodEnd'].flatMap((key) => {
      const after = formatValue(key, next[key], next);
      return after ? [{ label: LABELS[key], before: formatValue(key, prev[key], prev), after }] : [];
    });
    return { title: 'Даты поездки', isUpdate: true, rows };
  }

  const isUpdate = change.entityId !== null;
  const rows: ProposedChangeRow[] = [];
  for (const key of Object.keys(LABELS)) {
    if (!(key in next)) continue;
    const after = formatValue(key, next[key], next);
    if (after === null) continue;
    rows.push({ label: LABELS[key], before: isUpdate ? formatValue(key, prev[key], prev) : null, after });
  }
  const title = isUpdate ? (change.reason ?? 'Уточнение записи') : (NEW_TITLES[change.entityType] ?? 'Новая запись');
  return { title, isUpdate, rows };
}
