import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { Onest, JetBrains_Mono } from "next/font/google";
import "@ai-task-system/design-tokens/tokens.css";
import "@ai-task-system/design-tokens/ds.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

// Дизайн-система «Адъютант» (владелец 04.10.2026, внедрение по
// project/implementation.md, шаг 1) — Plus Jakarta Sans не содержал
// кириллицы, русский текст рендерился системным фолбэком. Onest —
// вариативная гарнитура (300–800), поэтому `weight` не указывается.
const sans = Onest({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "AI Task System",
  description: "Telegram Mini App для руководителя и подчинённых",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      {/* suppressHydrationWarning: telegram-web-app.js (ниже) выставляет
          --tg-viewport-height и т.п. на <html> сразу при загрузке, до
          гидрации React — расхождение с SSR-разметкой ожидаемо и безвредно. */}
      <head>
        {/* Официальный скрипт Telegram Mini App (раздел 14.2 ТЗ) — не npm-
            пакет: Telegram сам обновляет его на своей стороне без релиза
            нашего кода. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
