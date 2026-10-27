import type { Metadata } from "next";
import { Onest, JetBrains_Mono } from "next/font/google";
import "@ai-task-system/design-tokens/tokens.css";
import "@ai-task-system/design-tokens/ds.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { AvatarsProvider } from "@/lib/avatars";
import { Sidebar } from "@/components/sidebar";
import { AgentPanelProvider } from "@/components/agent-panel/agent-context";
import { AgentPanel } from "@/components/agent-panel/agent-panel";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

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
  // Вкладка браузера: «Адъютант»; иконка — app/icon.svg, favicon.ico, apple-icon.png.
  title: { default: "Адъютант", template: "%s · Адъютант" },
  description: "Закрытая система задач для руководителя и подчинённых",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: data-theme на <html> ставит скрипт до гидрации.
    <html lang="ru" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>
          <AvatarsProvider>
            <AgentPanelProvider>
              <div className="app-shell">
                <Sidebar />
                <main className="app-main">{children}</main>
                <AgentPanel />
              </div>
            </AgentPanelProvider>
          </AvatarsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
