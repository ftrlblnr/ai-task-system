// Тема оформления (ARMS, фаза 6): «как в системе» (по умолчанию), светлая
// или тёмная. Выбор — в localStorage, data-theme на <html> ставит inline-
// скрипт в layout до первой отрисовки (без мигания), здесь — переключение.
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'theme';

// Выполняется до гидрации — без зависимостей, только try/catch.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // приватный режим — тема всё равно применится до перезагрузки
  }
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}
