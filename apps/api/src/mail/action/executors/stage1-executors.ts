import { MailActionItem } from '@prisma/client';
import { StaleLocatorError } from '../../providers/email-provider';
import { MailActionExecutor, MailActionExecutorRegistry, MailActionExecutorResult } from '../mail-action-executor';
import { findSpecialUseFolder, parseMessageLocator } from './mail-action-locator';

// Этап 1 (раздел 3 ТЗ) — ARCHIVE/MOVE/CREATE_FOLDER/SET_READ/SET_UNREAD/
// FLAG/UNFLAG/TRASH. Каждый исполнитель получает УЖЕ открытую сессию через
// ctx.session (движок открывает её один раз на весь прогон, не на пункт).

function toStaleResult(): MailActionExecutorResult {
  // Раздел 14/15 ТЗ — "старые координаты при смене UIDVALIDITY не
  // исполнять": это не ошибка исполнителя, письмо просто сдвинулось с
  // момента согласования — SKIPPED_CHANGED, не FAILED.
  return { outcome: 'SKIPPED_CHANGED', errorCode: 'LOCATOR_CHANGED' };
}

class ArchiveExecutor implements MailActionExecutor {
  async execute(item: MailActionItem, ctx: Parameters<MailActionExecutor['execute']>[1]): Promise<MailActionExecutorResult> {
    const locator = parseMessageLocator(item.sourceLocators);
    // Раздел 17 ТЗ / решение владельца 05.10.2026 — если \Archive не нашлась
    // живьём при первой попытке, владелец выбирает/создаёт папку сам (через
    // GET/POST /mail/folders) и правит параметры пункта (PATCH .../items/:id,
    // раздел 14 ТЗ) — folderPath в параметрах явно переопределяет
    // автопоиск \Archive, не ищет её повторно.
    const params = item.parameters as unknown as { folderPath?: string } | null;
    const targetPath = params?.folderPath ?? (await findSpecialUseFolder(ctx.session, '\\Archive'))?.path;
    if (!targetPath) {
      return { outcome: 'FAILED', errorCode: 'ARCHIVE_FOLDER_MISSING' };
    }
    try {
      const result = await ctx.session.moveMessage(locator, targetPath);
      return { outcome: 'SUCCEEDED', destinationLocator: { folderPath: targetPath, uid: result.newUid, uidValidity: result.newUidValidity } };
    } catch (err) {
      if (err instanceof StaleLocatorError) return toStaleResult();
      throw err;
    }
  }
}

class MoveExecutor implements MailActionExecutor {
  async execute(item: MailActionItem, ctx: Parameters<MailActionExecutor['execute']>[1]): Promise<MailActionExecutorResult> {
    const locator = parseMessageLocator(item.sourceLocators);
    const params = item.parameters as unknown as { folderPath?: string } | null;
    if (!params?.folderPath) return { outcome: 'FAILED', errorCode: 'MISSING_FOLDER_PATH' };
    try {
      const result = await ctx.session.moveMessage(locator, params.folderPath);
      return { outcome: 'SUCCEEDED', destinationLocator: { folderPath: params.folderPath, uid: result.newUid, uidValidity: result.newUidValidity } };
    } catch (err) {
      if (err instanceof StaleLocatorError) return toStaleResult();
      throw err;
    }
  }
}

class TrashExecutor implements MailActionExecutor {
  async execute(item: MailActionItem, ctx: Parameters<MailActionExecutor['execute']>[1]): Promise<MailActionExecutorResult> {
    const locator = parseMessageLocator(item.sourceLocators);
    const trash = await findSpecialUseFolder(ctx.session, '\\Trash');
    if (!trash) return { outcome: 'FAILED', errorCode: 'TRASH_FOLDER_MISSING' };
    try {
      const result = await ctx.session.moveMessage(locator, trash.path);
      return { outcome: 'SUCCEEDED', destinationLocator: { folderPath: trash.path, uid: result.newUid, uidValidity: result.newUidValidity } };
    } catch (err) {
      if (err instanceof StaleLocatorError) return toStaleResult();
      throw err;
    }
  }
}

class CreateFolderExecutor implements MailActionExecutor {
  async execute(item: MailActionItem, ctx: Parameters<MailActionExecutor['execute']>[1]): Promise<MailActionExecutorResult> {
    const params = item.parameters as unknown as { parentPath?: string | null; name?: string } | null;
    if (!params?.name) return { outcome: 'FAILED', errorCode: 'MISSING_FOLDER_NAME' };
    const result = await ctx.session.createFolder(params.parentPath ?? null, params.name);
    // created=false — папка с таким именем/родителем уже существовала
    // (раздел 9 ТЗ: "не создавать дубликат") — для зависящего MOVE это
    // всё равно успех, путь известен и реален.
    return { outcome: 'SUCCEEDED', destinationLocator: { folderPath: result.path, created: result.created } };
  }
}

function makeFlagExecutor(flag: '\\Seen' | '\\Flagged', set: boolean): MailActionExecutor {
  return {
    async execute(item, ctx) {
      const locator = parseMessageLocator(item.sourceLocators);
      try {
        await ctx.session.changeFlag(locator, flag, set);
        return { outcome: 'SUCCEEDED' };
      } catch (err) {
        if (err instanceof StaleLocatorError) return toStaleResult();
        throw err;
      }
    },
  };
}

export function registerStage1MailActionExecutors(registry: MailActionExecutorRegistry): void {
  registry.register('ARCHIVE', new ArchiveExecutor());
  registry.register('MOVE', new MoveExecutor());
  registry.register('TRASH', new TrashExecutor());
  registry.register('CREATE_FOLDER', new CreateFolderExecutor());
  registry.register('SET_READ', makeFlagExecutor('\\Seen', true));
  registry.register('SET_UNREAD', makeFlagExecutor('\\Seen', false));
  registry.register('FLAG', makeFlagExecutor('\\Flagged', true));
  registry.register('UNFLAG', makeFlagExecutor('\\Flagged', false));
}
