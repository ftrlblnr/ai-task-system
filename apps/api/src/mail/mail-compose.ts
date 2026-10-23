import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailDraftMode } from '@prisma/client';
import { TIMEZONE_OFFSET_HOURS } from '../common/timezone';

// Чистые функции почтового клиента (владелец 23.10.2026): кому отвечать,
// тема Re:/Fwd:, цитата исходного письма и сборка MIME. Без БД и сети —
// проверяются юнит-тестами.

export interface ComposeAddress {
  address: string;
  name?: string | null;
}

// Исходное письмо для ответа/пересылки — поля EmailMessage.
export interface SourceMessage {
  internetMessageId: string | null;
  referencesIds: string[];
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  isOutgoing: boolean;
  sentAt: Date | null;
  receivedAt: Date | null;
  textBody: string | null;
  htmlBody: string | null;
  recipients: { type: 'TO' | 'CC' | 'BCC'; address: string; name: string | null }[];
}

const REPLY_PREFIX = /^\s*(re|ответ|отв)\s*(\[\d+\])?\s*:\s*/i;
const FORWARD_PREFIX = /^\s*(fwd?|пересл|переслано)\s*:\s*/i;
// Цепочка References не растёт бесконечно — достаточно последних.
const MAX_REFERENCES = 20;

export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`.trim();
}

export function forwardSubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return FORWARD_PREFIX.test(s) ? s : `Fwd: ${s}`.trim();
}

function uniqueAddresses(list: ComposeAddress[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const a of list) {
    const key = a.address.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Кому и в копию при ответе. Ответ на своё же письмо (из «Отправленных») —
// тем же получателям, как в Outlook.
export function replyRecipients(source: SourceMessage, mode: MailDraftMode, ownAddress: string): { to: string[]; cc: string[] } {
  const own = ownAddress.toLowerCase();
  const to = source.recipients.filter((r) => r.type === 'TO');
  const cc = source.recipients.filter((r) => r.type === 'CC');
  const primary: ComposeAddress[] = source.isOutgoing ? to : [{ address: source.fromAddress, name: source.fromName }];
  const toList = uniqueAddresses(primary, new Set(source.isOutgoing ? [] : [own]));
  if (mode !== 'REPLY_ALL') return { to: toList, cc: [] };
  const rest = source.isOutgoing ? cc : [...to, ...cc];
  return { to: toList, cc: uniqueAddresses(rest, new Set([own, ...toList])) };
}

export function threadHeaders(source: SourceMessage): { inReplyTo?: string; references?: string[] } {
  if (!source.internetMessageId) return {};
  const references = [...source.referencesIds.filter((r) => r !== source.internetMessageId), source.internetMessageId].slice(-MAX_REFERENCES);
  return { inReplyTo: source.internetMessageId, references };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>\n');
}

const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «23 октября 2026 г. 10:15» по времени Казахстана — как в шапке цитаты Outlook.
export function formatQuoteDate(date: Date): string {
  const local = new Date(date.getTime() + TIMEZONE_OFFSET_HOURS * 3_600_000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${local.getUTCDate()} ${RU_MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} г. ${hh}:${mm}`;
}

function formatAddress(a: ComposeAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

// Тело исходного HTML без <head>/скриптов — вкладывается в цитату.
export function htmlFragment(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<\/?(html|body|head|meta|link)[^>]*>/gi, '');
}

export interface Quote {
  header: { label: string; value: string }[];
  text: string;
  html: string;
}

// Шапка «От/Отправлено/Кому/Копия/Тема» и тело исходного письма.
export function buildQuote(source: SourceMessage, mode: MailDraftMode): Quote {
  const recipients = (type: 'TO' | 'CC') => source.recipients.filter((r) => r.type === type).map(formatAddress).join('; ');
  const date = source.sentAt ?? source.receivedAt;
  const header = [
    { label: 'От', value: formatAddress({ address: source.fromAddress, name: source.fromName }) },
    ...(date ? [{ label: 'Отправлено', value: formatQuoteDate(date) }] : []),
    { label: 'Кому', value: recipients('TO') },
    ...(recipients('CC') ? [{ label: 'Копия', value: recipients('CC') }] : []),
    { label: 'Тема', value: source.subject ?? '' },
  ];
  const title = mode === 'FORWARD' ? '-------- Пересылаемое сообщение --------' : '-------- Исходное сообщение --------';
  const headerText = header.map((h) => `${h.label}: ${h.value}`).join('\n');
  const body = source.textBody ?? '';
  const text = `${title}\n${headerText}\n\n${body}`;
  const headerHtml = header.map((h) => `<b>${h.label}:</b> ${escapeHtml(h.value)}`).join('<br>\n');
  const bodyHtml = source.htmlBody ? htmlFragment(source.htmlBody) : textToHtml(body);
  const html = `<div style="border:none;border-top:solid #E1E1E1 1pt;padding:3pt 0 0 0"><p style="margin:0 0 12pt 0">${headerHtml}</p></div>\n<div>${bodyHtml}</div>`;
  return { header, text, html };
}

export interface ComposeInput {
  from: ComposeAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  quote: Quote | null;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; content: Buffer; contentType?: string | null }[];
}

export interface ComposedMessage {
  messageId: string;
  // Для SMTP — без заголовка Bcc (скрытые получатели не видят друг друга).
  raw: Buffer;
  // Копия в «Отправленные» — с Bcc, как в Outlook.
  rawWithBcc: Buffer;
  envelope: { from: string; to: string[] };
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'adyutant.local';
  return `<${randomUUID()}@${domain}>`;
}

export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const messageId = newMessageId(input.from.address);
  const date = new Date();
  const text = input.quote ? `${input.body}\n\n${input.quote.text}` : input.body;
  const html =
    `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${textToHtml(input.body)}</div>` +
    (input.quote ? `\n<br>\n<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${input.quote.html}</div>` : '');
  const options = {
    from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
    to: input.to,
    cc: input.cc.length ? input.cc : undefined,
    bcc: input.bcc.length ? input.bcc : undefined,
    subject: input.subject,
    text,
    html: `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`,
    messageId,
    date,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType ?? undefined })),
  };
  const build = (keepBcc: boolean) => {
    const node = new MailComposer(options).compile();
    node.keepBcc = keepBcc;
    return node.build();
  };
  const [raw, rawWithBcc] = await Promise.all([build(false), build(true)]);
  return { messageId, raw, rawWithBcc, envelope: { from: input.from.address, to: [...new Set([...input.to, ...input.cc, ...input.bcc])] } };
}
