// Логотип «Адъютанта»: буква «А», у которой перекладина — галочка
// «сделано» с хвостом за правую ножку. Сетка 64×64; та же геометрия — в
// app/icon.svg (вкладка браузера), apple-icon.png и favicon.ico.

// Галочка тоньше ножек и отступает от левой — иначе на 16px сливается с ней.
const A_PATH = 'M16 51 32 12 48 51';
const CHECK_PATH = 'M25.5 37 30.5 42 43.5 29';

// Только штрихи — цветом текста. Для подложки, которая уже есть в
// разметке (.ds-brand-mark в меню).
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={A_PATH} strokeWidth={7} />
      <path d={CHECK_PATH} strokeWidth={5} />
    </svg>
  );
}

// Знак целиком: подложка акцентом темы, штрихи — цветом текста на акценте.
export function Logo({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="64" height="64" rx="16" style={{ fill: 'var(--accent)' }} />
      <path d={A_PATH} strokeWidth={7} style={{ stroke: 'var(--accent-contrast)' }} />
      <path d={CHECK_PATH} strokeWidth={5} style={{ stroke: 'var(--accent-contrast)' }} />
    </svg>
  );
}

// Шапка экранов входа, регистрации, сброса пароля и подключения.
export function AuthBrand() {
  return (
    <div className="auth-brand">
      <Logo size={48} />
      <span className="auth-brand-name">Адъютант</span>
    </div>
  );
}
