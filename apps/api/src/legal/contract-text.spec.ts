import { Document, Packer, Paragraph } from 'docx';
import { DOCX_MIME } from '../files/file-signature';
import { cleanContractText, ContractTextError, extractContractText, isContractMimeType, MAX_CONTRACT_CHARS } from './contract-text';

async function docxOf(paragraphs: string[]): Promise<Buffer> {
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs.map((p) => new Paragraph(p)) }] }));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ContractTextError ? err.code : String(err);
  }
}

describe('contract-text', () => {
  it('isContractMimeType: только PDF и DOCX', () => {
    expect(isContractMimeType('application/pdf')).toBe(true);
    expect(isContractMimeType(DOCX_MIME)).toBe(true);
    expect(isContractMimeType('application/msword')).toBe(false);
    expect(isContractMimeType('image/jpeg')).toBe(false);
  });

  it('cleanContractText: пробелы, CRLF и пустые строки схлопываются', () => {
    expect(cleanContractText('  1.1.\tСтороны   договорились \r\n\r\n\r\n\r\n 1.2.  Срок ')).toBe('1.1. Стороны договорились\n\n1.2. Срок');
  });

  it('extractContractText: DOCX — текст абзацев', async () => {
    const clause = 'Субподрядчик обязуется выполнить работы по устройству монолитного каркаса жилого дома.';
    const text = await extractContractText(await docxOf(['ДОГОВОР СУБПОДРЯДА', clause, clause, clause]), DOCX_MIME);
    expect(text.startsWith('ДОГОВОР СУБПОДРЯДА\n')).toBe(true);
    expect(text).toContain(clause);
  });

  it('extractContractText: отказы — неподдерживаемый тип, нет текста, слишком длинный', async () => {
    expect(await codeOf(extractContractText(Buffer.from('x'), 'image/png'))).toBe('UNSUPPORTED_TYPE');
    expect(await codeOf(extractContractText(await docxOf(['Короткий']), DOCX_MIME))).toBe('NO_TEXT');
    const long = 'а'.repeat(10_000);
    const paragraphs = Array.from({ length: Math.ceil(MAX_CONTRACT_CHARS / long.length) + 1 }, () => long);
    expect(await codeOf(extractContractText(await docxOf(paragraphs), DOCX_MIME))).toBe('TOO_LONG');
  });
});
