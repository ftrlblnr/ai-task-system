'use client';

import { useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { Button } from '@/components/ui';

// Тело письма — порт apps/web/src/components/mail/message-body.tsx. HTML
// чужого отправителя — в iframe без скриптов и форм (sandbox без
// allow-scripts), CSP запрещает загрузки; картинки из интернета (в них
// прячут пиксели-трекеры) — только по кнопке. allow-same-origin нужен лишь
// чтобы подогнать высоту по содержимому.

const REMOTE_IMAGE = /(<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|background\s*=\s*["']?\s*https?:)/i;

function buildDocument(html: string, allowRemote: boolean): string {
  const img = allowRemote ? 'data: cid: https: http:' : 'data: cid:';
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>html{margin:0;padding:0}body{margin:0;padding:12px 14px;background:#fff;color:#111;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>` +
    `</head><body>${html}</body></html>`
  );
}

export function MailBody({ html, text }: { html: string | null; text: string | null }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(200);
  const frame = useRef<HTMLIFrameElement>(null);
  const hasRemote = useMemo(() => (html ? REMOTE_IMAGE.test(html) : false), [html]);
  const doc = useMemo(() => (html ? buildDocument(html, allowRemote) : ''), [html, allowRemote]);

  if (!html) return <p className="mail-text">{text ?? '(текст письма недоступен)'}</p>;

  function fit() {
    const body = frame.current?.contentDocument?.documentElement;
    if (body) setHeight(Math.min(Math.max(body.scrollHeight + 8, 80), 6000));
  }

  return (
    <>
      {hasRemote && !allowRemote && (
        <div className="mail-images-bar">
          <ImageOff size={14} strokeWidth={1.75} />
          <span>Картинки из интернета скрыты</span>
          <Button variant="ghost" size="sm" onClick={() => setAllowRemote(true)}>
            Показать
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Текст письма"
        className="mail-html-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        onLoad={fit}
        style={{ height }}
      />
    </>
  );
}
