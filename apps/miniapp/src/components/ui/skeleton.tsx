// Порт Skeleton — нейтральная заглушка для ОБЫЧНЫХ данных (не «ИИ думает» —
// Skeleton/README.md: для агента всегда ThinkingLine/AgentMark, не это).

export function Skeleton({ width = '100%', height = 14, radius }: { width?: string | number; height?: number; radius?: number | string }) {
  return <span className="ds-skel" style={{ width, height, borderRadius: radius }} />;
}
