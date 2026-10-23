'use client';

import { useState, type FormEvent } from 'react';
import type { ConnectMailboxInput, MailProviderKind } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, Input, Select } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';

// Подключение ящика (владелец 23.10.2026): Mail.ru — пресет серверов и
// пароль приложения; «Другой сервер» — корпоративная почта с теми же
// настройками IMAP/SMTP, что в любой почтовой программе. Пароль уходит один раз и нигде не
// отображается.

type Security = 'ssl' | 'starttls';

const DEFAULT_PORTS: Record<'imap' | 'smtp', Record<Security, number>> = {
  imap: { ssl: 993, starttls: 143 },
  smtp: { ssl: 465, starttls: 587 },
};

const SECURITY_OPTIONS = [
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
];

export function MailboxConnectCard({ onConnected, onCancel }: { onConnected: (mailboxId: string) => void; onCancel?: () => void }) {
  const [provider, setProvider] = useState<MailProviderKind>('MAIL_RU');
  const [emailAddress, setEmailAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [login, setLogin] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [initialDays, setInitialDays] = useState(30);
  const [imapHost, setImapHost] = useState('');
  const [imapSecurity, setImapSecurity] = useState<Security>('ssl');
  const [imapPort, setImapPort] = useState(String(DEFAULT_PORTS.imap.ssl));
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpSecurity, setSmtpSecurity] = useState<Security>('ssl');
  const [smtpPort, setSmtpPort] = useState(String(DEFAULT_PORTS.smtp.ssl));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body: ConnectMailboxInput = { provider, emailAddress, appPassword, initialDays, displayName: displayName.trim() || undefined };
    if (provider === 'IMAP') {
      body.login = login.trim() || undefined;
      body.servers = {
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecure: imapSecurity === 'ssl',
        smtpHost: (smtpHost.trim() || imapHost).trim(),
        smtpPort: Number(smtpPort),
        smtpSecure: smtpSecurity === 'ssl',
      };
    }
    try {
      const res = await api.post<{ mailboxId: string }>('/mail/connect', body);
      setAppPassword('');
      onConnected(res.mailboxId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить почту');
    } finally {
      setBusy(false);
    }
  }

  function changeSecurity(kind: 'imap' | 'smtp', value: Security) {
    if (kind === 'imap') {
      setImapSecurity(value);
      setImapPort(String(DEFAULT_PORTS.imap[value]));
    } else {
      setSmtpSecurity(value);
      setSmtpPort(String(DEFAULT_PORTS.smtp[value]));
    }
  }

  return (
    <Card title="Подключить почтовый ящик">
      <div style={{ marginBottom: 16, maxWidth: 360 }}>
        <SegmentedControl
          label="Почта"
          value={provider}
          onChange={(v) => setProvider(v as MailProviderKind)}
          options={[
            { value: 'MAIL_RU', label: 'Mail.ru' },
            { value: 'IMAP', label: 'Другой сервер' },
          ]}
        />
      </div>
      {provider === 'MAIL_RU' ? (
        <ol className="setup-steps">
          <li>В настройках Mail.ru включите доступ по IMAP (раздел «Почтовые программы»).</li>
          <li>В настройках безопасности аккаунта создайте «Пароль для внешнего приложения» и скопируйте его.</li>
          <li>Введите адрес ящика и этот пароль ниже. Пароль хранится только в зашифрованном виде.</li>
        </ol>
      ) : (
        <p className="ds-field-hint" style={{ margin: 0 }}>
          Адреса серверов и порты выдаёт администратор вашей почты — те же, что вводят в любой почтовой программе. Пароль хранится только в
          зашифрованном виде.
        </p>
      )}
      <form onSubmit={connect} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Адрес почты">
          <Input type="email" value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} placeholder={provider === 'MAIL_RU' ? 'name@mail.ru' : 'name@company.kz'} required autoComplete="off" />
        </Field>
        <Field label="Имя отправителя (необязательно)">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Как вас увидят получатели" maxLength={200} />
        </Field>
        {provider === 'IMAP' && (
          <Field label="Логин (если отличается от адреса)">
            <Input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Например, DOMAIN\\name" autoComplete="off" />
          </Field>
        )}
        <Field label={provider === 'MAIL_RU' ? 'Пароль приложения' : 'Пароль'}>
          <Input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} required autoComplete="new-password" />
        </Field>
        {provider === 'IMAP' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
              <Field label="Сервер входящей почты (IMAP)">
                <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="mail.company.kz" required />
              </Field>
              <Field label="Шифрование">
                <Select value={imapSecurity} onChange={(e) => changeSecurity('imap', e.target.value as Security)} options={SECURITY_OPTIONS} />
              </Field>
              <Field label="Порт">
                <Input inputMode="numeric" value={imapPort} onChange={(e) => setImapPort(e.target.value.replace(/\D/g, ''))} required />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
              <Field label="Сервер исходящей почты (SMTP)">
                <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={imapHost || 'mail.company.kz'} />
              </Field>
              <Field label="Шифрование">
                <Select value={smtpSecurity} onChange={(e) => changeSecurity('smtp', e.target.value as Security)} options={SECURITY_OPTIONS} />
              </Field>
              <Field label="Порт">
                <Input inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, ''))} required />
              </Field>
            </div>
          </>
        )}
        <Field label="Загрузить письма за">
          <Select
            value={String(initialDays)}
            onChange={(e) => setInitialDays(Number(e.target.value))}
            options={[
              { value: '30', label: '30 дней' },
              { value: '90', label: '90 дней' },
              { value: '180', label: '180 дней' },
            ]}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" variant="primary" disabled={busy} loading={busy}>
            {busy ? 'Проверяю подключение…' : 'Подключить'}
          </Button>
          {onCancel && (
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              Отмена
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
