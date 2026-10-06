import type { EmailSession, MessageLocator, ProviderFolder } from '../../providers/email-provider';

// MailActionItem.sourceLocators — Json, записан на этапе анализа (#123,
// LLM по уже синкнутым письмам). Форма фиксирована (MessageLocator) с
// самого начала (schema.prisma, раздел 15 ТЗ), но Prisma типизирует поле
// как JsonValue — здесь только runtime-проверка формы перед использованием.
export function parseMessageLocator(sourceLocators: unknown): MessageLocator {
  const v = sourceLocators as Partial<MessageLocator> | null;
  if (!v || typeof v.folderPath !== 'string' || typeof v.uidValidity !== 'string' || typeof v.uid !== 'number') {
    throw new Error('MALFORMED_SOURCE_LOCATOR: sourceLocators пункта плана не содержит folderPath/uidValidity/uid');
  }
  return { folderPath: v.folderPath, uidValidity: v.uidValidity, uid: v.uid };
}

// Раздел 9 ТЗ — Archive/Trash ищутся ЖИВЬЁМ по special-use, не по жёсткому
// имени (единственное исключение — Sent, см. mapSpecialUseToRole).
export async function findSpecialUseFolder(session: EmailSession, specialUse: string): Promise<ProviderFolder | undefined> {
  const folders = await session.listAllFolders();
  return folders.find((f) => f.specialUse === specialUse);
}
