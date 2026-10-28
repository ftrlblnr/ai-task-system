import {
  buildSkillBlock,
  buildToneBlock,
  parseSkillInvocation,
  pickSkillUpgrades,
  SKILL_SLUG_RE,
  SKILL_TOOL_LABELS,
  skillUserText,
  SYSTEM_SKILL_UPGRADES,
  SYSTEM_SKILLS,
  TONE_PLACEHOLDER,
} from './skill-catalog';

describe('parseSkillInvocation', () => {
  it('кириллица, дефис и текст после команды', () => {
    expect(parseSkillInvocation('/к-встрече с Ахметовым в 15:00')).toEqual({
      slug: 'к-встрече',
      rest: 'с Ахметовым в 15:00',
    });
  });

  it('команда без текста и с переносами строк', () => {
    expect(parseSkillInvocation('  /день  ')).toEqual({
      slug: 'день',
      rest: '',
    });
    expect(parseSkillInvocation('/просрочки\nтолько отдел снабжения')).toEqual({
      slug: 'просрочки',
      rest: 'только отдел снабжения',
    });
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
    const block = buildSkillBlock({
      slug: 'день',
      title: 'Мой день',
      instructions: '  Шаг 1.  ',
    });
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
      for (const t of s.allowedTools)
        expect(SKILL_TOOL_LABELS[t]).toBeDefined();
    }
  });
});

// Единый агент A1: общие навыки переведены с get_tasks на find_tasks; в базе
// обновляются только те, что никто не правил.
describe('обновление общих навыков до нового seed', () => {
  it('новые стартовые навыки не используют get_tasks; прежние тексты есть для каждого обновлённого', () => {
    for (const s of SYSTEM_SKILLS)
      expect(s.allowedTools).not.toContain('get_tasks');
    for (const u of SYSTEM_SKILL_UPGRADES) {
      expect(SYSTEM_SKILLS.some((s) => s.slug === u.slug)).toBe(true);
      expect(u.allowedTools).toContain('get_tasks');
    }
  });

  it('обновляется только навык с дословно прежними текстом и инструментами', () => {
    const day = SYSTEM_SKILL_UPGRADES.find((u) => u.slug === 'день')!;
    const picked = pickSkillUpgrades([
      {
        id: 's1',
        slug: 'день',
        instructions: day.instructions,
        allowedTools: day.allowedTools,
      },
      {
        id: 's2',
        slug: 'просрочки',
        instructions: 'Руководитель переписал',
        allowedTools: ['get_tasks'],
      },
      {
        id: 's3',
        slug: 'к-встрече',
        instructions: SYSTEM_SKILL_UPGRADES.find((u) => u.slug === 'к-встрече')!
          .instructions,
        allowedTools: ['get_tasks'],
      },
      {
        id: 's4',
        slug: 'тон',
        instructions: TONE_PLACEHOLDER,
        allowedTools: [],
      },
    ]);
    expect(picked.map((p) => p.id)).toEqual(['s1']);
    expect(picked[0].seed.allowedTools).toContain('find_tasks');
  });
});
