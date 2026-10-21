import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

// Мгновенные обновления экранов вместо опроса (владелец 21.10.2026). Сигнал
// «в теме что-то изменилось», без данных: клиент перезапрашивает их обычным
// GET со своими правами, поэтому поток ничего не раскрывает. Один процесс
// API — достаточно EventEmitter в памяти.
export type RealtimeTopic = 'reception' | 'assistant' | 'legal';

// Личные темы — событие только владельцу (userId): что в беседе ассистента
// появился ответ, что разбор договора поменял статус. Общие — всем
// подписчикам (приёмная).
export const PERSONAL_TOPICS: ReadonlySet<RealtimeTopic> = new Set(['assistant', 'legal']);

function channel(topic: RealtimeTopic, userId?: string): string {
  return PERSONAL_TOPICS.has(topic) ? `${topic}:${userId ?? ''}` : topic;
}

@Injectable()
export class RealtimeService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Каждый открытый экран — подписчик; предупреждение о «утечке» после 10
    // слушателей здесь ложное.
    this.emitter.setMaxListeners(0);
  }

  // userId обязателен для личных тем и игнорируется для общих.
  publish(topic: RealtimeTopic, userId?: string): void {
    this.emitter.emit(channel(topic, userId));
  }

  subscribe(topic: RealtimeTopic, listener: () => void, userId?: string): () => void {
    const key = channel(topic, userId);
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
