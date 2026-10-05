import type { Metadata } from "next";
import { Onest, JetBrains_Mono } from "next/font/google";
import "@ai-task-system/design-tokens/tokens.css";
import "@ai-task-system/design-tokens/ds.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { Sidebar } from "@/components/sidebar";

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
  description: "Закрытая система задач для руководителя и подчинённых",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AuthProvider>
          <div className="app-shell">
            <Sidebar />
            <main className="app-main">{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
