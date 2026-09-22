const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

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
    // auth-context.tsx на старте читает user из localStorage без проверки
    // токена на сервере — при истёкшем JWT (JWT_EXPIRES_IN=8h) Protected
    // считал сессию живой, а каждый реальный запрос тихо падал в 401,
    // которые все страницы одинаково глотают в generic "Не удалось
    // загрузить…" (найдено 04.09.2026: пользователь не видел ни одной
    // задачи/события спустя больше 8ч с последнего входа). Здесь —
    // единственная точка, через которую проходят все запросы, поэтому
    // самое надёжное место разлогинить и вернуть на /login, а не
    // дублировать эту проверку в каждом .catch() по всему приложению.
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    throw new ApiError(body.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// multipart/form-data (голосовые заметки, /voice/parse) — не может идти
// через request(): Content-Type там всегда 'application/json'. Здесь
// Content-Type намеренно НЕ выставляется — браузер сам проставляет
// multipart/form-data; boundary=... по FormData, ручной заголовок ломает
// границу и Multer не парсит тело (тот же паттерн, что в apps/miniapp).
async function requestForm<T>(path: string, formData: FormData): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    throw new ApiError(body.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  return res.json() as Promise<T>;
}

// Stage 2, Phase M (Web Assistant parity, 22.09.2026) — SSE-стриминг
// (POST .../messages/stream). Логика самого разбора потока (data:-фреймы)
// живёт на стороне вызывающего кода (assistant/page.tsx), здесь только
// транспорт (тот же auth/401-паттерн, что request()/requestForm() выше),
// отдаёт сырой Response для чтения потока. Порт apps/miniapp/src/lib/api.ts
// один в один, кроме localStorage вместо sessionStorage — тот выбор был
// специфичен для Telegram WebView, web уже везде использует localStorage
// (см. request()/requestForm() выше).
async function requestStream(path: string, body: unknown): Promise<Response> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

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
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    throw new ApiError(respBody.message ?? `Ошибка запроса (${res.status})`, res.status);
  }

  return res;
}

// Скачивание сгенерированных/приложенных файлов (Phase M) — отдаёт Blob,
// вызывающий код (assistant-message-part.tsx) сам делает временный
// <a download> с URL.createObjectURL, тот же приём, что в apps/miniapp.
async function downloadBlob(path: string): Promise<Blob> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_URL}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    throw new ApiError(`Ошибка запроса (${res.status})`, res.status);
  }

  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  postForm: <T>(path: string, formData: FormData) => requestForm<T>(path, formData),
  postStream: (path: string, body: unknown) => requestStream(path, body),
  downloadBlob: (path: string) => downloadBlob(path),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
