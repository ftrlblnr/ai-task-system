'use client';

import { useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Письмо с оформлением (владелец 23.10.2026: «как в Outlook»). HTML чужого
// отправителя — в iframe без скриптов и форм (sandbox без allow-scripts),
// CSP запрещает любые загрузки; картинки из интернета (в них прячут
// пиксели-трекеры) — только по кнопке «Показать картинки». allow-same-origin
// нужен лишь для того, чтобы подогнать высоту по содержимому: без скриптов
// документ письма сам ничего сделать не может.

const REMOTE_IMAGE = /(<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|background\s*=\s*["']?\s*https?:)/i;

function buildDocument(html: string, allowRemote: boolean): string {
  const img = allowRemote ? 'data: cid: https: http:' : 'data: cid:';
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>html{margin:0;padding:0}body{margin:0;padding:12px 14px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>` +
    `</head><body>${html}</body></html>`
  );
}

export function MessageBody({ html, text }: { html: string | null; text: string | null }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(200);
  const frame = useRef<HTMLIFrameElement>(null);
  const hasRemote = useMemo(() => (html ? REMOTE_IMAGE.test(html) : false), [html]);
  const doc = useMemo(() => (html ? buildDocument(html, allowRemote) : ''), [html, allowRemote]);

  if (!html) {
    return (
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{text ?? '(тело письма недоступно)'}</pre>
    );
  }

  function fit() {
    const body = frame.current?.contentDocument?.documentElement;
    if (body) setHeight(Math.min(Math.max(body.scrollHeight + 8, 80), 4000));
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
