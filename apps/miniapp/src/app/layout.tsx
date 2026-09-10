import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { Plus_Jakarta_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

const sans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin", "latin-ext", "cyrillic-ext"],
  weight: ["400", "500", "600", "700", "800"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
