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
  document.documentElement.dataset.theme = app.colorScheme;
}

export function initTelegramChrome() {
  const app = getTelegramWebApp();
  if (!app) return;
  app.ready();
  app.expand();
  syncTheme(app);
  app.onEvent('themeChanged', () => syncTheme(app));
  try {
    app.setHeaderColor('secondary_bg_color');
    app.setBackgroundColor('secondary_bg_color');
  } catch {
    // themeParams может быть неполным в старых клиентах Telegram — не критично
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
