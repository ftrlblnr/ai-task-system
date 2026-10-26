'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { MailStatus, MailboxStatus } from '@ai-task-system/shared-types';
import { MANAGER_ROLES } from '@ai-task-system/shared-types';
import { api, setMailboxId } from '@/lib/api';
import { Protected } from '@/components/protected';
import { DataOwnerScope, useActingAsLeader } from '@/components/data-owner-scope';
import { PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { MailAgentTab } from '@/components/mail-agent';
import { MailboxConnectCard } from '@/components/mail/mailbox-connect';
import { MailboxStatusBar } from '@/components/mail/mailbox-status-bar';
import { MessagesPane } from '@/components/mail/messages-tab';
import { DigestList } from '@/components/mail/digests-tab';

// Stage 2, Phase R (Mail.ru Email Intelligence, 25.09.2026) — подключение ящика и
// просмотр локально синхронизированной почты. Только OWNER (как Plaud/календарь).
// Пароль приложения отправляется один раз и нигде не отображается.
// Вкладки — components/mail/*-tab.tsx (редизайн web W0).

const SYNC_POLL_MS = 5_000;

// Выбранный ящик — удобство на этом устройстве (не общее состояние).
const SELECTED_MAILBOX_KEY = 'mail.selectedMailbox';

type MailTab = 'messages' | 'digests' | 'agent';

function readSelectedMailbox(): string | null {
  try {
    return localStorage.getItem(SELECTED_MAILBOX_KEY);
  } catch {
    return null;
  }
}

function rememberSelectedMailbox(id: string) {
  try {
    localStorage.setItem(SELECTED_MAILBOX_KEY, id);
  } catch {
    // приватный режим — просто не запомним выбор
  }
}

// Содержимое одного ящика. Заголовок X-Mailbox-Id (api.ts) ставится до
// первого запроса детей — они рендерятся, только когда выбор применён.
function MailboxView({ mailbox, onChange }: { mailbox: MailboxStatus; onChange: () => void }) {
  const [tab, setTab] = useState<MailTab>('messages');
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    setMailboxId(mailbox.id);
    // Флаг модуля api.ts — внешнее состояние (тот же приём, что DataOwnerScope).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApplied(mailbox.id);
    return () => setMailboxId(null);
  }, [mailbox.id]);

  if (applied !== mailbox.id) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <>
      <MailboxStatusBar status={mailbox} onChange={onChange} />
      <div style={{ marginBottom: 16 }}>
        <SegmentedControl
          options={[
            { value: 'messages', label: 'Письма' },
            { value: 'digests', label: 'Дайджест' },
            { value: 'agent', label: 'Разбор' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as MailTab)}
        />
      </div>
      {tab === 'messages' && <MessagesPane />}
      {tab === 'digests' && <DigestList />}
      {tab === 'agent' && <MailAgentTab />}
    </>
  );
}

function MailView() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readSelectedMailbox);
  const [adding, setAdding] = useState(false);
  const actingAsLeader = useActingAsLeader();

  const load = useCallback(() => {
    api
      .get<MailStatus>('/mail/status')
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch(() => setError('Не удалось проверить статус почты'));
  }, []);

  useEffect(load, [load]);

  const mailboxes = status?.mailboxes ?? [];
  const selected = mailboxes.find((m) => m.id === selectedId) ?? mailboxes[0] ?? null;

  // Пока идёт синхронизация — обновляем статус (счётчик писем растёт).
  const syncing = mailboxes.some((m) => m.syncState === 'SYNCING');
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(load, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, load]);

  function select(id: string) {
    setSelectedId(id);
    rememberSelectedMailbox(id);
    setAdding(false);
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!status) return <p className="ds-field-hint">Загрузка…</p>;
  if (mailboxes.length === 0) {
    return actingAsLeader ? (
      <Alert tone="info">Почта руководителя не подключена — подключить её может только она сама.</Alert>
    ) : (
      <MailboxConnectCard
        onConnected={(id) => {
          select(id);
          load();
        }}
      />
    );
  }

  return (
    <>
      <div className="mail-boxes">
        {mailboxes.length > 1 && (
          <SegmentedControl
            label="Ящик"
            value={selected?.id ?? ''}
            onChange={select}
            options={mailboxes.map((m) => ({ value: m.id, label: m.emailAddress }))}
          />
        )}
        {!actingAsLeader && !adding && (
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
            Добавить ящик
          </Button>
        )}
      </div>
      {adding ? (
        <MailboxConnectCard
          onConnected={(id) => {
            select(id);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        selected && <MailboxView key={selected.id} mailbox={selected} onChange={load} />
      )}
    </>
  );
}

export default function MailPage() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <PageHeader title="Почта" />
      <DataOwnerScope>
        <MailView />
      </DataOwnerScope>
    </Protected>
  );
}
