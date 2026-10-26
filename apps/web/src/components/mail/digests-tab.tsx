'use client';

import { useEffect, useState } from 'react';
import type { MailDigestDetail, MailDigestEmailItem, MailDigestListItem, MailDigestListResponse } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { IMPORTANCE_LABELS, formatDate } from './mail-labels';

// Вкладка «Дайджест»: ежедневные сводки почты. Вынесено из
// app/mail/page.tsx (редизайн web W0).

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function digestItemBadges(item: Pick<MailDigestEmailItem, 'analysis'>): string[] {
  const badges: string[] = [];
  if (item.analysis?.status === 'COMPLETED') {
    const label = item.analysis.importance ? IMPORTANCE_LABELS[item.analysis.importance] : '';
    if (label) badges.push(label);
    if (item.analysis.needsReply) badges.push('нужен ответ');
    if (item.analysis.needsAction) badges.push('нужно действие');
  }
  return badges;
}

function DigestDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<MailDigestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MailDigestDetail>(`/mail/digests/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть сводку'));
  }, [id]);

  return (
    <Card style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ marginBottom: 6 }}>{detail ? `Сводка за ${formatDay(detail.periodFrom)}` : 'Сводка'}</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!detail && !error && <p className="ds-field-hint">Загрузка…</p>}
      {detail && (
        <>
          <p className="ds-field-hint" style={{ marginBottom: 12 }}>
            Источник: {detail.source}
          </p>
          {detail.items.length === 0 && <p className="ds-field-hint">Писем за эти сутки не было.</p>}
          {detail.items.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {detail.items.map((item, i) => {
                const badges = digestItemBadges(item);
                return (
                  <li key={item.id ?? i} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                    <div>
                      <span className="ds-field-hint">{formatDate(item.receivedAt)}</span>{' '}
                      <strong>{item.fromName || item.fromAddress}</strong> — {item.subject || '(без темы)'}
                      {badges.map((b) => (
                        <span key={b} style={{ marginLeft: 8 }}>
                          <Badge>{b}</Badge>
                        </span>
                      ))}
                    </div>
                    {item.analysis?.summary && <div className="ds-field-hint">{item.analysis.summary}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

export function DigestList() {
  const [data, setData] = useState<MailDigestListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MailDigestListResponse>('/mail/digests')
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить сводки'));
  }, []);

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.digests.length === 0 && (
        <EmptyState title="Сводок пока нет" description="Первая ежедневная сводка появится завтра в 06:00 по Алматы." />
      )}
      {data && data.digests.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Источник</th>
                <th>Писем</th>
              </tr>
            </thead>
            <tbody>
              {data.digests.map((d: MailDigestListItem) => (
                <tr key={d.id} onClick={() => setOpenId(d.id)} style={{ cursor: 'pointer' }}>
                  <td>{formatDay(d.periodFrom)}</td>
                  <td>{data.source}</td>
                  <td>
                    {d.totalCount}
                    {d.importantCount > 0 && (
                      <span style={{ marginLeft: 8 }}>
                        <Badge>важных: {d.importantCount}</Badge>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <DigestDetailView key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
