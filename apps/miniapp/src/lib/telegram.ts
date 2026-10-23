// Тонкая обёртка над window.Telegram.WebApp (раздел 14.2 ТЗ). Официальный
// способ подключения — script-тег telegram-web-app.js (см. layout.tsx), а
// не npm-пакет: это тот же скрипт, который сам Telegram обновляет на своей
// стороне без релиза нашего кода.

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name: string } };
  ready: () => void;
  expand: () => void;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  onEvent: (event: string, cb: () => void) => void;
  // Bot API 6.9+; в старых клиентах поля нет — всегда через проверку.
  CloudStorage?: {
    getItem: (key: string, cb: (err: string | null, value?: string) => void) => void;
    setItem: (key: string, value: string, cb?: (err: string | null, ok?: boolean) => void) => void;
  };
  isVersionAtLeast?: (version: string) => boolean;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

// initData пустая строка вне Telegram (обычный браузер) — используется как
// признак "запущено не из Telegram" для дев-фолбэка на email/пароль (см.
// auth-context.tsx).
export function getInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

// Дизайн-система «Адъютант» (владелец 04.10.2026, project/implementation.md,
// шаг 2) — tokens.css различает темы через `data-theme` на <html>; web
// следует prefers-color-scheme сам, а Mini App выставляет атрибут явно по
// Telegram.WebApp.colorScheme (своя тема, не системная тема устройства).
function syncTheme(app: TelegramWebApp) {
  // Вне Telegram скрипт SDK всё равно создаёт WebApp с colorScheme 'light' —
  // тогда тему не навязываем, работает prefers-color-scheme системы.
  if (!app.initData) return;
  document.documentElement.dataset.theme = app.colorScheme;
}

export function initTelegramChrome() {
  const app = getTelegramWebApp();
  if (!app) return;
  app.ready();
  app.expand();
  syncTheme(app);
  applyChromeColor(app);
  app.onEvent('themeChanged', () => {
    syncTheme(app);
    applyChromeColor(app);
  });
}

// Редизайн M1 (владелец 23.10.2026): шапка и фон Telegram = --bg текущей
// темы, чтобы шапка сливалась с экраном (раньше — secondary_bg_color
// Telegram, заметно другого оттенка). Цвет hex принимают клиенты с Bot API
// 6.1+; старые — молча игнорируют.
function applyChromeColor(app: TelegramWebApp) {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
  try {
    app.setHeaderColor(bg);
    app.setBackgroundColor(bg);
  } catch {
    // старый клиент Telegram — не критично
  }
}

// Небольшие настройки (последний открытый раздел): CloudStorage Telegram —
// общая для всех устройств пользователя, вне Telegram и в старых клиентах —
// localStorage. Ошибки хранилища не мешают работе.
export function loadPref(key: string): Promise<string | null> {
  const cloud = getTelegramWebApp()?.CloudStorage;
  const local = () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  if (!cloud) return Promise.resolve(local());
  return new Promise((resolve) => {
    try {
      cloud.getItem(key, (err, value) => resolve(err || !value ? local() : value));
    } catch {
      resolve(local());
    }
  });
}

export function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // приватный режим и т.п.
  }
  try {
    getTelegramWebApp()?.CloudStorage?.setItem(key, value);
  } catch {
    // старый клиент Telegram
  }
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  getTelegramWebApp()?.HapticFeedback?.impactOccurred(style);
}

// Отдельно от haptic() (impactOccurred, тактильный отклик на тап) —
// notificationOccurred сигнализирует исход действия (успех/ошибка), нужен
// для голосового режима: подтверждение черновика / сбой транскрибации.
export function notificationHaptic(type: 'error' | 'success' | 'warning') {
  getTelegramWebApp()?.HapticFeedback?.notificationOccurred(type);
}
