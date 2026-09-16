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

// multipart/form-data (голосовые заметки, /voice/parse) — не может идти
// через request(): Content-Type там всегда 'application/json' и body всегда
// JSON.stringify. Здесь Content-Type намеренно НЕ выставляется — браузер
// сам проставляет multipart/form-data; boundary=... по FormData, ручной
// заголовок ломает границу и Multer не парсит тело.
async function requestForm<T>(path: string, formData: FormData): Promise<T> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
async function requestStream(path: string, body: unknown): Promise<Response> {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const respBody = await res.json().catch(() => ({}));
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(respBody.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  return res;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  postForm: <T>(path: string, formData: FormData) => requestForm<T>(path, formData),
  postStream: (path: string, body: unknown) => requestStream(path, body),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
