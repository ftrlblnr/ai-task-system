-- Владелец 09.09.2026: у Plaud нет self-service регистрации OAuth-приложения
-- для доступа к своим же записям (portal.plaud.ai — отдельный продукт,
-- Plaud Embedded). Вместо своего клиента используем публичный клиент
-- официальных @plaud-ai/cli/mcp (без client_secret, PKCE) — таблица для
-- хранения самостоятельно введённых Client ID/Secret не нужна.
-- Строк в таблице ещё не было (форма ни разу не была успешно сохранена).

-- DropTable
DROP TABLE "PlaudOAuthAppConfig";
