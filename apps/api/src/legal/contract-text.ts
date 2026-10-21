import { extractRawText } from 'mammoth';
import { extractPdfText } from '../mail/attachment-extraction';
import { DOCX_MIME } from '../files/file-signature';

// Текст договора для агента-юриста (handoff, раздел 3.2): PDF — тем же
// pdfjs-экстрактором, что вложения почты, DOCX — mammoth (raw text, абзацы
// через перевод строки). Сканы без текстового слоя не распознаются — OCR нет.

export const CONTRACT_MIME_TYPES = ['application/pdf', DOCX_MIME] as const;

// ~400 тыс. символов ≈ 100–130 тыс. токенов: договор с приложениями
// целиком, но не «том документов», за который разбор стал бы золотым.
export const MAX_CONTRACT_CHARS = 400_000;
// Меньше — почти наверняка скан или пустой файл, разбирать нечего.
export const MIN_CONTRACT_CHARS = 200;

export type ContractTextErrorCode = 'UNSUPPORTED_TYPE' | 'NO_TEXT' | 'TOO_LONG';

export class ContractTextError extends Error {
  constructor(
    readonly code: ContractTextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContractTextError';
  }
}

export function isContractMimeType(mimeType: string): boolean {
  return (CONTRACT_MIME_TYPES as readonly string[]).includes(mimeType);
}

// Пустые строки схлопываются, пробелы по краям строк убираются: агент
// цитирует «как есть» из этого текста, а сервер ищет цитату в нём же.
export function cleanContractText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractContractText(buffer: Buffer, mimeType: string): Promise<string> {
  let raw: string | null;
  if (mimeType === 'application/pdf') raw = await extractPdfText(buffer);
  else if (mimeType === DOCX_MIME) raw = (await extractRawText({ buffer })).value;
  else throw new ContractTextError('UNSUPPORTED_TYPE', 'Поддерживаются только договоры PDF и DOCX');

  const text = cleanContractText(raw ?? '');
  if (text.length < MIN_CONTRACT_CHARS) {
    throw new ContractTextError('NO_TEXT', 'В файле нет текста — возможно, это скан. Нужен PDF с текстовым слоем или DOCX');
  }
  if (text.length > MAX_CONTRACT_CHARS) {
    throw new ContractTextError('TOO_LONG', `Договор слишком большой для разбора (${text.length} символов, предел ${MAX_CONTRACT_CHARS})`);
  }
  return text;
}
