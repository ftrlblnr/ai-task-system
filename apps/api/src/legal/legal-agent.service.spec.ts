import { ConfigService } from '@nestjs/config';
import type Anthropic from '@anthropic-ai/sdk';
import { LegalAgentError, LegalAgentService } from './legal-agent.service';

const ARTICLE = {
  text: 'на несущие конструкции, кровлю и наружные стены (фасады) зданий – не менее десяти лет',
  title: 'Гарантийный срок',
  short: 'Строительный кодекс',
  url: 'u',
};

function msg(content: unknown[], stop_reason: Anthropic.StopReason = 'tool_use'): Anthropic.Message {
  return { content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
}
const tool = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const submit = (quote: string) =>
  tool('s', 'submit_answer', {
    conclusion: 'Не меньше 10 лет',
    reasoning: 'r',
    citations: [{ norm_id: 'K2600000253:ст.122', quote, relevance: 'x' }],
    not_covered: [],
    questions: [],
  });

function makeAgent(responses: Anthropic.Message[]) {
  const npa = {
    listDocuments: jest.fn().mockResolvedValue([{ code: 'K2600000253', short: 'СК', title: 'Строительный кодекс' }]),
    find: jest.fn().mockResolvedValue([{ id: 'K2600000253:ст.122' }]),
    getArticle: jest.fn().mockResolvedValue({ id: 'K2600000253:ст.122', text: ARTICLE.text }),
    verifyQuote: jest.fn().mockResolvedValue({ id: 'K2600000253:ст.122', exists: true, verified: true }),
    term: jest.fn().mockResolvedValue([]),
    lookupArticles: jest.fn().mockResolvedValue(new Map([['K2600000253:ст.122', ARTICLE]])),
  };
  const requests: Anthropic.MessageCreateParams[] = [];
  const agent = new LegalAgentService(new ConfigService({}), npa as never);
  const queue = [...responses];
  (agent as unknown as { client: unknown }).client = {
    messages: {
      stream: (params: Anthropic.MessageCreateParams) => {
        requests.push(JSON.parse(JSON.stringify(params)) as Anthropic.MessageCreateParams);
        return { finalMessage: () => Promise.resolve(queue.shift()) };
      },
    },
  };
  return { agent, npa, requests };
}

describe('LegalAgentService.ask', () => {
  it('поиск → статья → ответ: цитата проверена сервером', async () => {
    const { agent, npa, requests } = makeAgent([
      msg([tool('a', 'search_npa', { query: 'гарантийный срок', code: '' })]),
      msg([tool('b', 'get_article', { id: 'K2600000253:ст.122' })]),
      msg([submit('не менее десяти лет')]),
    ]);
    const r = await agent.ask('гарантия на несущие?');
    expect(r.rounds).toBe(3);
    expect(r.citations[0]).toMatchObject({ verified: true, articleTitle: 'Гарантийный срок' });
    expect(npa.find).toHaveBeenCalledWith('гарантийный срок', { code: undefined, limit: 8 });
    // Opus 5.5: auto, без принуждения; effort high; размышления не трогаем.
    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', tool_choice: { type: 'auto' }, output_config: { effort: 'high' } });
    // Ответ модели уходит в историю как есть, результаты — tool_result.
    expect(requests[2].messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }] });
  });

  it('неподтверждённая цитата — одна попытка исправления, затем ответ с пометкой', async () => {
    const { agent, requests } = makeAgent([msg([submit('не менее восьми лет')]), msg([submit('не менее девяти лет')])]);
    const r = await agent.ask('вопрос');
    expect(r.rounds).toBe(2);
    expect(r.citations[0].verified).toBe(false);
    const fixRequest = requests[1].messages.at(-1) as { content: { is_error: boolean; content: string }[] };
    expect(fixRequest.content[0].is_error).toBe(true);
    expect(fixRequest.content[0].content).toContain('не подтвердила 1');
  });

  it('ответ текстом без submit_answer — одна просьба, потом ошибка NO_ANSWER', async () => {
    const text = msg([{ type: 'text', text: 'ответ' }], 'end_turn');
    const { agent } = makeAgent([text, text]);
    await expect(agent.ask('вопрос')).rejects.toMatchObject({ code: 'NO_ANSWER' });
  });

  it('просьба сдать ответ работает', async () => {
    const { agent, requests } = makeAgent([msg([{ type: 'text', text: 'ответ' }], 'end_turn'), msg([submit('не менее десяти лет')])]);
    const r = await agent.ask('вопрос');
    expect(r.conclusion).toBe('Не меньше 10 лет');
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('submit_answer') });
  });

  it('refusal и max_tokens — ошибки с кодом', async () => {
    await expect(makeAgent([msg([], 'refusal')]).agent.ask('в')).rejects.toBeInstanceOf(LegalAgentError);
    await expect(makeAgent([msg([], 'max_tokens')]).agent.ask('в')).rejects.toMatchObject({ code: 'OUTPUT_TOO_LONG' });
  });

  it('потолок раундов — TOO_MANY_ROUNDS, на предпоследнем раунде предупреждение', async () => {
    const loop = Array.from({ length: 12 }, (_, i) => msg([tool(`t${i}`, 'term', { query: 'x' })]));
    const { agent, requests } = makeAgent(loop);
    await expect(agent.ask('в')).rejects.toMatchObject({ code: 'TOO_MANY_ROUNDS' });
    expect(JSON.stringify(requests[11].messages.at(-1))).toContain('Лимит обращений почти исчерпан');
  });

  it('пустая база — EMPTY_BASE до обращения к модели', async () => {
    const { agent, npa, requests } = makeAgent([]);
    npa.listDocuments.mockResolvedValueOnce([]);
    await expect(agent.ask('в')).rejects.toMatchObject({ code: 'EMPTY_BASE' });
    expect(requests).toHaveLength(0);
  });
});

describe('LegalAgentService.review', () => {
  const CONTRACT = 'п. 4.1. Гарантийный срок на выполненные работы составляет 8 (восемь) лет с даты подписания акта.';
  const submitReview = (asIs: string) =>
    tool('r', 'submit_review', {
      contract: '',
      gc_role: 'заказчик',
      applicable_acts: 'СК',
      summary: 'Гарантия ниже минимума.',
      findings: [
        {
          clause: 'п. 4.1',
          as_is: asIs,
          proposed: '10 лет',
          reasoning: 'r',
          gc_impact: 'g',
          norm_id: 'K2600000253:ст.122',
          quote: 'не менее десяти лет',
          risk: 'высокий',
          type: 'несоответствие НПА',
        },
      ],
      general_issues: [],
      not_checked: [],
    });

  it('договор и фокус — в первом сообщении; «как есть» сверяется с договором', async () => {
    const { agent, requests } = makeAgent([
      msg([submitReview('Гарантийный срок на работы составляет пять лет')]),
      msg([submitReview('Гарантийный срок на выполненные работы составляет 8 (восемь) лет')]),
    ]);
    const r = await agent.review(CONTRACT, 'Договор.docx', ' гарантии ');
    expect(r.rounds).toBe(2);
    expect(r.contract).toBe('Договор.docx');
    expect(r.findings[0]).toMatchObject({ verified: true, documentShort: 'Строительный кодекс' });
    const first = JSON.stringify(requests[0].messages[0].content);
    expect(first).toContain('<contract>');
    expect(first).toContain('обратить особое внимание: гарантии');
    expect(requests[0].tools!.map((t) => (t as Anthropic.Tool).name)).toContain('submit_review');
    expect(JSON.stringify(requests[1].messages.at(-1)!.content)).toContain('фрагмент «как есть» не найден в договоре');
  });
});
