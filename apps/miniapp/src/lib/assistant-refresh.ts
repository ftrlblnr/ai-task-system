// Карточка в ленте ассистента просит перечитать разговор (единый агент A2):
// после «Отменить» у задачи сервер дописал в разговор «Отменено.», а у
// карточки нет доступа к состоянию ленты. Слушает use-assistant-stream.
const ASSISTANT_REFRESH_EVENT = 'assistant:refresh';

export function requestAssistantRefresh(): void {
  window.dispatchEvent(new Event(ASSISTANT_REFRESH_EVENT));
}

export function onAssistantRefresh(handler: () => void): () => void {
  window.addEventListener(ASSISTANT_REFRESH_EVENT, handler);
  return () => window.removeEventListener(ASSISTANT_REFRESH_EVENT, handler);
}
