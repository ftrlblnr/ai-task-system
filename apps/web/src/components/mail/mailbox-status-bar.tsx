'use client';

import { useState } from 'react';
import { Link2Off, RefreshCw } from 'lucide-react';
import type { MailboxStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useActingAsLeader } from '@/components/data-owner-scope';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

// Строка состояния ящика: адрес, число писем, синхронизация, отключение.
// Вынесено из app/mail/page.tsx (редизайн web W0).

const ERROR_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Сервер отклонил логин или пароль — подключите ящик заново.',
  IMAP_DISABLED: 'Доступ по IMAP выключен в настройках почты — включите его и подключите ящик заново.',
  TIMEOUT: 'Почтовый сервер не отвечает — повторим автоматически.',
  TLS_ERROR: 'Сертификат почтового сервера не прошёл проверку — проверьте адрес сервера и подключите ящик заново.',
  SYNC_FAILED: 'Синхронизация прервалась — повторим автоматически.',
  UNKNOWN: 'Не удалось подключиться к почтовому серверу — повторим автоматически.',
};

export function MailboxStatusBar({ status, onChange }: { status: MailboxStatus; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actingAsLeader = useActingAsLeader();
  const syncing = status.syncState === 'SYNCING';

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/mail/sync');
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось запустить синхронизацию');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(`Отключить ящик ${status.emailAddress}? Синхронизированные письма будут удалены из системы (на почтовом сервере они останутся).`)) return;
    setBusy(true);
    try {
      await api.delete(`/mail/mailboxes/${status.id}`);
      onChange();
    } catch {
      setError('Не удалось отключить почту');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong>{status.emailAddress}</strong>
        <Badge>{status.messageCount} писем</Badge>
        <Badge>{syncing ? 'Синхронизация…' : status.lastSyncedAt ? `Обновлено: ${new Date(status.lastSyncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}</Badge>
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={syncNow} disabled={busy || syncing || status.syncState === 'PAUSED'}>
          Синхронизировать
        </Button>
        {!actingAsLeader && (
          <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
            Отключить
          </Button>
        )}
      </div>
      {status.lastError && (
        <div style={{ marginTop: 8 }}>
          <Alert tone="danger">
            {status.syncState === 'PAUSED' ? 'Синхронизация приостановлена. ' : ''}
            {ERROR_LABELS[status.lastError] ?? 'Ошибка синхронизации.'}
          </Alert>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
