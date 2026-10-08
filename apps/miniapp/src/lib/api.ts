const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// Токен истёк (JWT_EXPIRES_IN=8h) или невалиден — sessionStorage обычно и
// так очищается при каждом переоткрытии Mini App из Telegram, но
// dev-фолбэк на email/пароль (login-screen.tsx) может держать одну вкладку
// открытой дольше 8ч. Перезагрузка страницы — та же логика восстановления,
// что и у обычного переоткрытия: auth-context.tsx заново пройдёт либо
// Telegram initData, либо покажет форму входа, вместо того чтобы экраны
// тихо показывали "Не удалось загрузить" на каждый запрос.
function handleUnauthorized() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem('accessToken');
  window.location.reload();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(body.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// multipart/form-data (голосовые заметки, /voice/parse, материалы поездки)
// — не может идти через request(): Content-Type там всегда
// 'application/json' и body всегда JSON.stringify. Здесь Content-Type
// намеренно НЕ выставляется — браузер сам проставляет multipart/form-data;
// boundary=... по FormData, ручной заголовок ломает границу и Multer не
// парсит тело. headers — агент поездок (ТЗ 08.10.2026): POST /trips/runs и
// /trips/:id/materials требуют Idempotency-Key тем же способом, что
// api.post (тот же приём, что в apps/web/src/lib/api.ts).
async function requestForm<T>(path: string, formData: FormData, headers?: HeadersInit): Promise<T> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(body.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  return res.json() as Promise<T>;
}

// text/event-stream-ответ (Stage 2 §14, Phase E) — EventSource браузера
// сюда не годится (только GET, без тела/заголовков), поэтому это обычный
// fetch() с потоковым телом; парсинг SSE-фреймов — задача вызывающего кода
// (assistant-screen.tsx), здесь только транспорт (тот же auth/401-паттерн,
// что request()/requestForm()), отдаёт сырой Response для чтения потока.
// signal — дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md
// шаг 7): кнопка «Остановить ответ» в Composer прерывает именно этот fetch,
// не трогая соединение (AbortError ловит вызывающий код, см. assistant-screen.tsx).
async function requestStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const respBody = await res.json().catch(() => ({}));
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(respBody.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  return res;
}

// Скачивание файла (Stage 2 §8, Phase F) — не простая <a href>: скачивание
// защищено Bearer-токеном, не куки/сессией, обычная ссылка его не пошлёт.
// Отдаёт Blob, вызывающий код (assistant-message-part.tsx) сам делает
// временный <a download> с URL.createObjectURL.
async function downloadBlob(path: string): Promise<Blob> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(`Ошибка запроса (${res.status})`, res.status);
  }

  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // headers — раздел 12 ТЗ «Приёмная»: мутирующие запросы требуют
  // Idempotency-Key, обычный заголовок, не часть тела — остальные вызовы
  // api.post/api.patch не передают 3-й аргумент, ничего не меняется (тот
  // же приём, что в apps/web/src/lib/api.ts).
  post: <T>(path: string, body?: unknown, headers?: HeadersInit) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers }),
  postForm: <T>(path: string, formData: FormData, headers?: HeadersInit) => requestForm<T>(path, formData, headers),
  postStream: (path: string, body: unknown, signal?: AbortSignal) => requestStream(path, body, signal),
  downloadBlob: (path: string) => downloadBlob(path),
  patch: <T>(path: string, body?: unknown, headers?: HeadersInit) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined, headers }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
