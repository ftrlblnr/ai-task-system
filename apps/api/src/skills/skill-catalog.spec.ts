import { buildSkillBlock, buildToneBlock, parseSkillInvocation, SKILL_SLUG_RE, SKILL_TOOL_LABELS, skillUserText, SYSTEM_SKILLS, TONE_PLACEHOLDER } from './skill-catalog';

describe('parseSkillInvocation', () => {
  it('кириллица, дефис и текст после команды', () => {
    expect(parseSkillInvocation('/к-встрече с Ахметовым в 15:00')).toEqual({ slug: 'к-встрече', rest: 'с Ахметовым в 15:00' });
  });

  it('команда без текста и с переносами строк', () => {
    expect(parseSkillInvocation('  /день  ')).toEqual({ slug: 'день', rest: '' });
    expect(parseSkillInvocation('/просрочки\nтолько отдел снабжения')).toEqual({ slug: 'просрочки', rest: 'только отдел снабжения' });
  });

  it('регистр команды не важен', () => {
    expect(parseSkillInvocation('/День')?.slug).toBe('день');
  });

  it('не команда — null', () => {
    expect(parseSkillInvocation('сделай /день')).toBeNull();
    expect(parseSkillInvocation('/ день')).toBeNull();
    expect(parseSkillInvocation('путь /tmp/x')).toBeNull();
    expect(parseSkillInvocation('/tmp/x')).toBeNull();
  });

  it('пустой текст навыка — «Выполни навык.»', () => {
    expect(skillUserText('')).toBe('Выполни навык.');
    expect(skillUserText('с Ивановым')).toBe('с Ивановым');
  });
});

describe('блоки навыка и тона', () => {
  it('блок навыка — в рамке [skill …]…[/skill] с инструкцией', () => {
    const block = buildSkillBlock({ slug: 'день', title: 'Мой день', instructions: '  Шаг 1.  ' });
    expect(block.startsWith('[skill /день — Мой день]')).toBe(true);
    expect(block.endsWith('Шаг 1.\n[/skill]')).toBe(true);
  });

  it('тон-заглушка и пустой тон — блока нет', () => {
    expect(buildToneBlock(TONE_PLACEHOLDER)).toBeNull();
    expect(buildToneBlock('  ')).toBeNull();
    expect(buildToneBlock('## Правила\n- коротко')).toContain('[tone]');
  });
});

describe('стартовые навыки', () => {
  it('команды корректны, инструменты известны, slug не повторяются', () => {
    const slugs = SYSTEM_SKILLS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of SYSTEM_SKILLS) {
      expect(s.slug).toMatch(SKILL_SLUG_RE);
      for (const t of s.allowedTools) expect(SKILL_TOOL_LABELS[t]).toBeDefined();
    }
  });
});
