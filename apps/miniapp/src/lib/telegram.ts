import { useEffect, useRef, useSyncExternalStore } from 'react';

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
  // Bot API 6.1+ (BackButton), 7.7+ (disableVerticalSwipes) — всегда через
  // isVersionAtLeast: старые клиенты пишут ошибку в консоль вместо вызова.
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
  };
  MainButton?: {
    setParams: (params: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
  };
  disableVerticalSwipes?: () => void;
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
  // Редизайн M6 (§5): свайп вниз по ленте не должен сворачивать Mini App.
  if (app.initData && app.isVersionAtLeast?.('7.7')) app.disableVerticalSwipes?.();
  app.onEvent('themeChanged', () => {
    syncTheme(app);
    applyChromeColor(app);
    applyMainButton();
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
// CloudStorage — с Bot API 6.9 и только внутри Telegram: вне его и в старых
// клиентах SDK вместо ответа пишет ошибку в консоль.
function cloudStorage() {
  const app = getTelegramWebApp();
  if (!app?.initData || !app.isVersionAtLeast?.('6.9')) return undefined;
  return app.CloudStorage;
}

export function loadPref(key: string): Promise<string | null> {
  const cloud = cloudStorage();
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
    cloudStorage()?.setItem(key, value);
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

// Редизайн M6 (MINIAPP_REDESIGN.md §5): системные «Назад» и главная кнопка
// Telegram вместо своих — только внутри Telegram и в клиентах, где они есть;
// в браузере (вход по паролю) экраны рисуют свои кнопки как раньше.
// Оверлеи могут лежать друг на друге (задача из ленты ассистента поверх
// «Сегодня»), поэтому обработчики — стек: срабатывает верхний.
function nativeApp(version: string): TelegramWebApp | null {
  const app = getTelegramWebApp();
  return app?.initData && app.isVersionAtLeast?.(version) ? app : null;
}

const subscribeNever = () => () => undefined;
function useNative(check: () => boolean): boolean {
  return useSyncExternalStore(subscribeNever, check, () => false);
}

const backStack: { current: () => void }[] = [];
let backBound = false;

// Возвращает true, если работает системная «Назад» — тогда свою стрелку/
// крестик экран не рисует.
export function useBackButton(onBack: (() => void) | undefined): boolean {
  const native = useNative(() => !!nativeApp('6.1')?.BackButton);
  const ref = useRef(onBack);
  useEffect(() => {
    ref.current = onBack;
  });
  const active = native && !!onBack;
  useEffect(() => {
    const button = nativeApp('6.1')?.BackButton;
    if (!active || !button) return;
    const entry = { current: () => ref.current?.() };
    backStack.push(entry);
    if (!backBound) {
      button.onClick(() => backStack[backStack.length - 1]?.current());
      backBound = true;
    }
    button.show();
    return () => {
      backStack.splice(backStack.indexOf(entry), 1);
      if (backStack.length === 0) button.hide();
    };
  }, [active]);
  return native;
}

interface MainButtonParams {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}
const mainStack: { current: MainButtonParams }[] = [];
let mainBound = false;

function cssColor(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

function applyMainButton() {
  const button = nativeApp('6.0')?.MainButton;
  if (!button) return;
  const top = mainStack[mainStack.length - 1]?.current;
  if (!top) {
    button.hideProgress();
    button.hide();
    return;
  }
  button.setParams({
    text: top.text,
    color: cssColor('--accent'),
    text_color: cssColor('--accent-contrast'),
    is_active: !top.disabled && !top.loading,
    is_visible: true,
  });
  if (top.loading) button.showProgress(false);
  else button.hideProgress();
}

// Главное действие формы в оверлее. Возвращает true, если его показывает
// Telegram — тогда своя кнопка внизу формы не рисуется.
export function useMainButton(params: MainButtonParams): boolean {
  const native = useNative(() => !!nativeApp('6.0')?.MainButton);
  const entryRef = useRef({ current: params });
  useEffect(() => {
    entryRef.current.current = params;
  });
  useEffect(() => {
    const button = nativeApp('6.0')?.MainButton;
    if (!native || !button) return;
    const entry = entryRef.current;
    mainStack.push(entry);
    if (!mainBound) {
      button.onClick(() => {
        const top = mainStack[mainStack.length - 1]?.current;
        if (top && !top.disabled && !top.loading) top.onClick();
      });
      mainBound = true;
    }
    return () => {
      mainStack.splice(mainStack.indexOf(entry), 1);
      applyMainButton();
    };
  }, [native]);
  useEffect(() => {
    if (native) applyMainButton();
  }, [native, params.text, params.disabled, params.loading]);
  return native;
}
