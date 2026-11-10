import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

const errors = async (body: Record<string, unknown>) => (await validate(plainToInstance(LoginDto, body))).map((e) => e.property);

describe('LoginDto', () => {
  it('логин — любая строка: без «@» и обычный email', async () => {
    expect(await errors({ email: 'i.bektemirova', password: '12345678' })).toEqual([]);
    expect(await errors({ email: 'user@example.kz', password: '12345678' })).toEqual([]);
  });

  it('пустой логин, не строка или короткий пароль — ошибка', async () => {
    expect(await errors({ email: '', password: '12345678' })).toEqual(['email']);
    expect(await errors({ email: 42, password: '12345678' })).toEqual(['email']);
    expect(await errors({ email: 'login', password: '123' })).toEqual(['password']);
  });
});
