/* eslint-disable @typescript-eslint/require-await -- фейковая сессия без реального I/O, тот же приём, что FakeMailActionPrisma */
import { MailActionItem } from '@prisma/client';
import { StaleLocatorError } from '../../providers/email-provider';
import type { EmailSession, MoveResult, ProviderFolder } from '../../providers/email-provider';
import { MailActionExecutionContext, MailActionExecutorRegistry } from '../mail-action-executor';
import { registerStage1MailActionExecutors } from './stage1-executors';

const LOCATOR = { folderPath: 'INBOX', uidValidity: '123', uid: 7 };

function item(over: Partial<MailActionItem> & { id: string }): MailActionItem {
  return {
    sourceLocators: LOCATOR,
    parameters: {},
    ...over,
  } as MailActionItem;
}

class FakeSession implements Pick<EmailSession, 'listAllFolders' | 'moveMessage' | 'changeFlag' | 'createFolder'> {
  folders: ProviderFolder[] = [];
  moveCalls: { toFolderPath: string }[] = [];
  flagCalls: { flag: string; set: boolean }[] = [];
  moveResult: MoveResult | (() => never) = { newUid: 9, newUidValidity: '123' };

  async listAllFolders() {
    return this.folders;
  }
  async moveMessage(_locator: unknown, toFolderPath: string) {
    this.moveCalls.push({ toFolderPath });
    if (typeof this.moveResult === 'function') return this.moveResult();
    return this.moveResult;
  }
  async changeFlag(_locator: unknown, flag: string, set: boolean) {
    this.flagCalls.push({ flag, set });
  }
  async createFolder(parentPath: string | null, name: string) {
    return { path: parentPath ? `${parentPath}/${name}` : name, role: 'OTHER' as const, specialUse: null, created: true };
  }
}

function ctx(session: FakeSession): MailActionExecutionContext {
  return { mailboxId: 'mbx-1', session: session as unknown as EmailSession };
}

describe('Stage 1 executors (ТЗ разд. 3/9/14/15)', () => {
  let registry: MailActionExecutorRegistry;

  beforeEach(() => {
    registry = new MailActionExecutorRegistry();
    registerStage1MailActionExecutors(registry);
  });

  describe('ARCHIVE', () => {
    it('находит \\Archive живьём и перемещает туда', async () => {
      const session = new FakeSession();
      session.folders = [{ path: 'Archive', role: 'ARCHIVE', specialUse: '\\Archive' }];
      const result = await registry.get('ARCHIVE')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(session.moveCalls).toEqual([{ toFolderPath: 'Archive' }]);
    });

    it('\\Archive не найдена и параметр folderPath не задан — FAILED ARCHIVE_FOLDER_MISSING', async () => {
      const session = new FakeSession();
      const result = await registry.get('ARCHIVE')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result).toEqual({ outcome: 'FAILED', errorCode: 'ARCHIVE_FOLDER_MISSING' });
      expect(session.moveCalls).toHaveLength(0);
    });

    it('раздел 17 ТЗ: folderPath в параметрах переопределяет автопоиск \\Archive', async () => {
      const session = new FakeSession();
      const result = await registry.get('ARCHIVE')!.execute(item({ id: 'i1', parameters: { folderPath: 'INBOX/MyArchive' } }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(session.moveCalls).toEqual([{ toFolderPath: 'INBOX/MyArchive' }]);
    });

    it('устаревший локатор (UIDVALIDITY сменился) — SKIPPED_CHANGED, не FAILED', async () => {
      const session = new FakeSession();
      session.folders = [{ path: 'Archive', role: 'ARCHIVE', specialUse: '\\Archive' }];
      session.moveResult = () => {
        throw new StaleLocatorError();
      };
      const result = await registry.get('ARCHIVE')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result).toEqual({ outcome: 'SKIPPED_CHANGED', errorCode: 'LOCATOR_CHANGED' });
    });
  });

  describe('TRASH', () => {
    it('находит \\Trash живьём', async () => {
      const session = new FakeSession();
      session.folders = [{ path: 'Корзина', role: 'TRASH', specialUse: '\\Trash' }];
      const result = await registry.get('TRASH')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(session.moveCalls).toEqual([{ toFolderPath: 'Корзина' }]);
    });

    it('\\Trash не найдена — FAILED TRASH_FOLDER_MISSING', async () => {
      const session = new FakeSession();
      const result = await registry.get('TRASH')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result).toEqual({ outcome: 'FAILED', errorCode: 'TRASH_FOLDER_MISSING' });
    });
  });

  describe('MOVE', () => {
    it('перемещает в указанную параметром папку', async () => {
      const session = new FakeSession();
      const result = await registry.get('MOVE')!.execute(item({ id: 'i1', parameters: { folderPath: 'INBOX/News' } }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(session.moveCalls).toEqual([{ toFolderPath: 'INBOX/News' }]);
    });

    it('без folderPath в параметрах — FAILED MISSING_FOLDER_PATH', async () => {
      const session = new FakeSession();
      const result = await registry.get('MOVE')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result).toEqual({ outcome: 'FAILED', errorCode: 'MISSING_FOLDER_PATH' });
    });
  });

  describe('CREATE_FOLDER', () => {
    it('создаёт папку и возвращает её путь', async () => {
      const session = new FakeSession();
      const result = await registry.get('CREATE_FOLDER')!.execute(item({ id: 'i1', parameters: { parentPath: 'INBOX', name: 'Новая' } }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(result.destinationLocator).toEqual({ folderPath: 'INBOX/Новая', created: true });
    });

    it('без имени — FAILED MISSING_FOLDER_NAME', async () => {
      const session = new FakeSession();
      const result = await registry.get('CREATE_FOLDER')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result).toEqual({ outcome: 'FAILED', errorCode: 'MISSING_FOLDER_NAME' });
    });
  });

  describe('флаги (SET_READ/SET_UNREAD/FLAG/UNFLAG)', () => {
    it('SET_READ выставляет \\Seen', async () => {
      const session = new FakeSession();
      const result = await registry.get('SET_READ')!.execute(item({ id: 'i1' }), ctx(session));
      expect(result.outcome).toBe('SUCCEEDED');
      expect(session.flagCalls).toEqual([{ flag: '\\Seen', set: true }]);
    });

    it('SET_UNREAD снимает \\Seen', async () => {
      const session = new FakeSession();
      await registry.get('SET_UNREAD')!.execute(item({ id: 'i1' }), ctx(session));
      expect(session.flagCalls).toEqual([{ flag: '\\Seen', set: false }]);
    });

    it('FLAG/UNFLAG управляют \\Flagged', async () => {
      const session = new FakeSession();
      await registry.get('FLAG')!.execute(item({ id: 'i1' }), ctx(session));
      await registry.get('UNFLAG')!.execute(item({ id: 'i1' }), ctx(session));
      expect(session.flagCalls).toEqual([
        { flag: '\\Flagged', set: true },
        { flag: '\\Flagged', set: false },
      ]);
    });
  });
});
