import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

// Мгновенные обновления экранов вместо опроса (владелец 21.10.2026). Сигнал
// «в теме что-то изменилось», без данных: клиент перезапрашивает их обычным
// GET со своими правами, поэтому поток ничего не раскрывает. Один процесс
// API — достаточно EventEmitter в памяти.
export type RealtimeTopic = 'reception';

@Injectable()
export class RealtimeService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Каждый открытый экран — подписчик; предупреждение о «утечке» после 10
    // слушателей здесь ложное.
    this.emitter.setMaxListeners(0);
  }

  publish(topic: RealtimeTopic): void {
    this.emitter.emit(topic);
  }

  subscribe(topic: RealtimeTopic, listener: () => void): () => void {
    this.emitter.on(topic, listener);
    return () => this.emitter.off(topic, listener);
  }
}
