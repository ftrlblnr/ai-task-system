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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  postForm: <T>(path: string, formData: FormData) => requestForm<T>(path, formData),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
