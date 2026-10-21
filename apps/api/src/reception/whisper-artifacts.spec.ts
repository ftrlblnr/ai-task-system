import { isWhisperArtifact } from './whisper-artifacts';

describe('isWhisperArtifact', () => {
  it.each(['Продолжение следует...', 'Субтитры сделал DimaTorzok', 'Спасибо за просмотр!', '', '  ...  '])('артефакт: %p', (text) => {
    expect(isWhisperArtifact(text)).toBe(true);
  });

  it.each(['Да', 'Согласовано, закупку до пятницы', 'Подготовьте субтитры к ролику для выставки и пришлите мне на согласование до конца недели'])(
    'речь: %p',
    (text) => {
      expect(isWhisperArtifact(text)).toBe(false);
    },
  );
});
