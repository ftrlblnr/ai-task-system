'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Scale, Upload } from 'lucide-react';
import type { UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useRealtime } from '@/lib/use-realtime';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, Card, EmptyState, Field, FileChip, PageHeader, SegmentedControl, Textarea, type BadgeTone } from '@/components/ui';

// Агент-юрист (handoff, этап 4): разбор договора в фоне с отчётом Word и
// вопрос по НПА РК. Тот же API, что инструменты ассистента
// (legal_review_contract / legal_ask) — /legal/*.

type ReviewStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

interface LegalReviewView {
  id: string;
  status: ReviewStatus;
  fileName: string;
  focus: string | null;
  reportFileId: string | null;
  findingsCount: number | null;
  unverifiedCount: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface LegalAnswerResponse {
  markdown: string;
}

const STATUS: Record<ReviewStatus, [BadgeTone, string]> = {
  QUEUED: ['neutral', 'В очереди'],
  RUNNING: ['agent', 'Идёт разбор'],
  SUCCEEDED: ['ok', 'Готов'],
  FAILED: ['danger', 'Не выполнен'],
};

const ACCEPT = '.pdf,.docx';
const CONTRACT_EXT = /\.(pdf|docx)$/i;
// Подстраховка к realtime: пока разбор идёт, раз в 30 секунд.
const ACTIVE_POLL_MS = 30_000;

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function reportName(fileName: string): string {
  return `Разбор — ${fileName.replace(/\.(pdf|docx)$/i, '').trim() || 'договор'}.docx`;
}

async function downloadFile(fileId: string, name: string) {
  const blob = await api.downloadBlob(`/files/${fileId}/download`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ReviewRow({ review }: { review: LegalReviewView }) {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tone, label] = STATUS[review.status];

  async function download() {
    if (!review.reportFileId) return;
    setDownloading(true);
    setFailed(false);
    try {
      await downloadFile(review.reportFileId, reportName(review.fileName));
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  const details: string[] = [formatDateTime(review.createdAt)];
  if (review.status === 'SUCCEEDED' && review.findingsCount !== null) {
    details.push(`находок: ${review.findingsCount}`);
    if (review.unverifiedCount) details.push(`не подтверждено: ${review.unverifiedCount}`);
  }
  if (review.focus) details.push(`фокус: ${review.focus}`);

  return (
    <div className="ds-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ overflowWrap: 'anywhere' }}>{review.fileName}</strong>
          <Badge tone={tone} dot>
            {label}
          </Badge>
        </div>
        <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
          {details.join(' · ')}
        </p>
        {review.status === 'FAILED' && review.error && (
          <p className="ds-field-hint" style={{ margin: '4px 0 0', color: 'var(--danger)' }}>
            {review.error}
          </p>
        )}
        {failed && <p className="ds-field-hint">Не удалось скачать отчёт</p>}
      </div>
      {review.status === 'SUCCEEDED' && review.reportFileId && (
        <Button variant="secondary" icon={FileText} onClick={download} loading={downloading}>
          Отчёт
        </Button>
      )}
    </div>
  );
}

function ReviewsTab() {
  const [reviews, setReviews] = useState<LegalReviewView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [focus, setFocus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  const load = useCallback(() => {
    api
      .get<LegalReviewView[]>('/legal/reviews?limit=30')
      .then((items) => {
        setReviews(items);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить разборы'));
  }, []);

  useEffect(load, [load]);
  useRealtime('legal', load);

  const hasActive = (reviews ?? []).some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(load, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (picked && !CONTRACT_EXT.test(picked.name)) {
      setSubmitError('Нужен договор в PDF или DOCX');
      return;
    }
    setSubmitError(null);
    setFile(picked);
    idem.reset();
  }

  async function submit() {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploaded = await api.postForm<UploadedFileInfo>('/files/upload', formData);
      await api.post<LegalReviewView>('/legal/reviews', { fileId: uploaded.fileId, focus: focus.trim() || undefined }, { 'Idempotency-Key': idem.key() });
      idem.reset();
      setFile(null);
      setFocus('');
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setSubmitError(err instanceof ApiError ? err.message : 'Не удалось запустить разбор');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card title="Новый разбор" subtitle="Разбор занимает несколько минут. Отчёт появится в списке ниже.">
        {submitError && <Alert tone="danger">{submitError}</Alert>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {file ? (
            <FileChip name={file.name} onRemove={submitting ? undefined : () => setFile(null)} />
          ) : (
            <label className="ds-btn ds-btn-secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
              <Upload size={18} strokeWidth={1.75} />
              Выбрать договор
              <input type="file" hidden accept={ACCEPT} onChange={onFileSelected} />
            </label>
          )}
        </div>
        <Field label="На что обратить внимание (необязательно)">
          <Textarea value={focus} maxLength={2000} onChange={(e) => setFocus(e.target.value)} placeholder="Например: сроки, гарантии, штрафы" />
        </Field>
        <Button variant="primary" icon={Scale} onClick={submit} loading={submitting} disabled={!file}>
          Разобрать
        </Button>
      </Card>

      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {!reviews && !loadError && <p className="ds-field-hint">Загрузка…</p>}
      {reviews && reviews.length === 0 && <EmptyState icon={FileText} title="Разборов пока нет" description="Выберите договор и нажмите «Разобрать»." />}
      {reviews && reviews.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          {reviews.map((r) => (
            <ReviewRow key={r.id} review={r} />
          ))}
        </div>
      )}
    </>
  );
}

function AskTab() {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ question: string; markdown: string } | null>(null);

  async function ask() {
    const q = question.trim();
    if (q.length < 3) return;
    setAsking(true);
    setError(null);
    try {
      const res = await api.post<LegalAnswerResponse>('/legal/ask', { question: q });
      setAnswer({ question: q, markdown: res.markdown });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось получить ответ');
    } finally {
      setAsking(false);
    }
  }

  return (
    <>
      <Card title="Вопрос по НПА РК" subtitle="Ответ со ссылками на статьи и цитатами, сверенными с базой. Обычно до минуты.">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Вопрос">
          <Textarea
            value={question}
            maxLength={4000}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Например: какой минимальный гарантийный срок на несущие конструкции?"
          />
        </Field>
        <Button variant="primary" onClick={ask} loading={asking} disabled={question.trim().length < 3}>
          {asking ? 'Ищу в базе…' : 'Спросить'}
        </Button>
      </Card>
      {answer && (
        <Card title={answer.question} style={{ marginTop: 16 }}>
          <div className="assistant-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.markdown}</ReactMarkdown>
          </div>
        </Card>
      )}
    </>
  );
}

function LegalView() {
  const [tab, setTab] = useState<'reviews' | 'ask'>('reviews');
  return (
    <>
      <PageHeader title="Юрист" description="Разбор договоров в интересах генподрядчика и вопросы по НПА РК. Проект — требует проверки юристом." />
      <div style={{ marginBottom: 16, maxWidth: 360 }}>
        <SegmentedControl
          label="Раздел"
          value={tab}
          onChange={(v) => setTab(v as 'reviews' | 'ask')}
          options={[
            { value: 'reviews', label: 'Договоры' },
            { value: 'ask', label: 'Вопрос по НПА' },
          ]}
        />
      </div>
      {tab === 'reviews' ? <ReviewsTab /> : <AskTab />}
    </>
  );
}

export default function LegalPage() {
  return (
    <Protected>
      <LegalView />
    </Protected>
  );
}
