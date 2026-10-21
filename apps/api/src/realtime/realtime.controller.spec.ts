import { BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & { setHeader: jest.Mock; flushHeaders: jest.Mock; write: jest.Mock };
  res.setHeader = jest.fn();
  res.flushHeaders = jest.fn();
  res.write = jest.fn();
  return res;
}

describe('RealtimeController.stream', () => {
  it('изменение темы приходит событием change, после закрытия — нет', () => {
    const realtime = new RealtimeService();
    const controller = new RealtimeController(realtime);
    const res = fakeResponse();

    controller.stream('reception', res as any);
    realtime.publish('reception');

    expect(res.write).toHaveBeenCalledWith('event: change\ndata: {"topic":"reception"}\n\n');

    res.emit('close');
    res.write.mockClear();
    realtime.publish('reception');
    expect(res.write).not.toHaveBeenCalled();
  });

  it('неизвестная тема — 400, поток не открывается', () => {
    const controller = new RealtimeController(new RealtimeService());
    const res = fakeResponse();

    expect(() => controller.stream('mail', res as any)).toThrow(BadRequestException);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });
});
