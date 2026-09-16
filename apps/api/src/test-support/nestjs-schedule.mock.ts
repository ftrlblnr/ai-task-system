// @nestjs/schedule v12 публикуется как чистый ESM-пакет ("type": "module" в
// package.json), который jest (CommonJS-раннер) не может распарсить напрямую
// (SyntaxError: Unexpected token 'export'). В рантайме Nest его подгружает
// нормально, но юнит-тесты вызывают методы крона напрямую, а не через
// планировщик — сам декоратор @Cron в тестах не участвует в поведении,
// поэтому безопасно подменить пакет лёгким CJS-мок в jest.moduleNameMapper
// (см. package.json) вместо того, чтобы городить ESM-транспиляцию всего
// node_modules ради одного пакета.
export const Cron: (...args: unknown[]) => MethodDecorator = () => () => undefined;

export const CronExpression = {
  EVERY_HOUR: '0 * * * *',
} as const;
