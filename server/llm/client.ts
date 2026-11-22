import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { NonsenseError } from '../domain/types.ts';
import { ANTHROPIC_MODEL, config, redactSecrets } from '../env.ts';
import { BudgetError, httpError, providerFetch, responseJson, sanitize, ToolError } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/tool.ts';

// USD per million tokens, cached 2026-11-03. Check provider rate cards before changing models.
const prices: Record<string, readonly [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [4, 20],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [1, 5],
  'claude-haiku-5-5': [0.1, 0.5],
  'gpt-5-mini': [0.25, 2],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
};

function price(model: string, input: number, output: number) {
  const [inRate, outRate] = model.startsWith('claude-haiku-5-5') && input > 100_000
    ? [0.5, 2.5] : prices[model] ?? prices[model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')] ?? [10, 50];
  return (input * inRate + output * outRate) / 1_000_000;
}

const token = z.number().int().nonnegative();
const anthropicUsage = z.object({
  input_tokens: token, output_tokens: token,
  iterations: z.array(z.object({ type: z.string(), model: z.string().optional(), input_tokens: token, output_tokens: token })).nullish(),
});
const openaiUsage = z.object({ prompt_tokens: token, completion_tokens: token });
const openaiChoice = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullish() }),
  })).min(1),
});

interface CompletionRequest {
  purpose: 'parse' | 'draft';
  system: string;
  user: string;
  maxTokens: number;
  json?: boolean;
}

export interface Completion { text: string; model: string }
let anthropic: Anthropic | undefined;

function textResult(text: string, model: string, json?: boolean): Completion {
  const cleaned = redactSecrets(text.trim()).replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  if (!cleaned) throw new NonsenseError('No text content');
  if (json) {
    try {
      const value: unknown = JSON.parse(cleaned);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
    } catch {
      throw new NonsenseError('Expected a JSON object');
    }
  }
  return { text: cleaned, model };
}

export function modelClient(ctx: ToolContext) {
  return {
    async complete({ purpose, system, user, maxTokens, json }: CompletionRequest): Promise<Completion | null> {
      const provider = config.llm;
      if (provider === 'template') return null;
      const model = provider === 'anthropic' ? ANTHROPIC_MODEL : config.openaiModel;
      system = redactSecrets(json ? system + '\nReply with a single JSON object.' : system);
      user = redactSecrets(user);
      const estimateInput = Buffer.byteLength(system + user) + 128;
      const estimateUsd = price(model, estimateInput, maxTokens)
        + (provider === 'anthropic' ? price('claude-opus-4-8', estimateInput, maxTokens) : 0);
      try {
        return await ctx.tool<Completion | null>({
          provider, endpoint: model, body: { purpose, system, user, maxTokens, json },
          attempt: {
            mode: 'model', estimate: { usd: estimateUsd },
            inject: () => { throw new NonsenseError('Expected a message object'); },
            async run(signal, report) {
              if (provider === 'anthropic') {
                anthropic ??= new Anthropic({
                  baseURL: 'https://api.anthropic.com', authToken: null, maxRetries: 0, logLevel: 'off',
                  defaultHeaders: { 'anthropic-version': '2023-06-01' },
                  fetchOptions: { redirect: 'error' },
                });
                const result = await anthropic.beta.messages.create({
                  model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
                  output_config: { effort: purpose === 'parse' ? 'low' : 'medium' },
                  betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
                }, { signal }).catch((error: unknown) => {
                  signal.throwIfAborted();
                  if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ToolError('Model request timed out', 'timeout', 'timeout');
                  if (error instanceof Anthropic.APIConnectionError) throw new ToolError('Provider network failure', 'network');
                  if (error instanceof Anthropic.APIError && error.status) throw httpError(error.status);
                  if (error instanceof SyntaxError) throw new NonsenseError('Invalid model response');
                  throw new ToolError('Anthropic request failed');
                });
                const usage = anthropicUsage.safeParse(result.usage);
                if (!usage.success) throw new NonsenseError('Missing model usage');
                const stop = result.stop_reason;
                const obscured = stop === 'refusal' || stop === 'max_tokens';
                const blocks = obscured || !Array.isArray(result.content) ? [] : result.content;
                const fallback = blocks.find(block => block.type === 'fallback');
                const billedRefusal = ['bio', 'frontier_llm', 'reasoning_extraction']
                  .includes(result.stop_details?.type === 'refusal' ? result.stop_details.category ?? '' : '');
                const earlierBilled = fallback?.type === 'fallback' && ['bio', 'frontier_llm', 'reasoning_extraction']
                  .includes(fallback.trigger.category ?? '');
                const { input_tokens: input, output_tokens: output, iterations } = usage.data;
                const earlier = iterations?.some(item => item.type === 'fallback_message')
                  ? iterations.filter(item => item.type === 'message') : [];
                const servedModel = result.model || model;
                const usd = (stop !== 'refusal' || output > 0 || billedRefusal ? price(servedModel, input, output) : 0)
                  + earlier.reduce((sum, entry) => sum + (entry.output_tokens > 0 || earlierBilled
                    ? price(entry.model || model, entry.input_tokens, entry.output_tokens) : 0), 0);
                report({
                  inputTokens: input + earlier.reduce((sum, item) => sum + item.input_tokens, 0),
                  outputTokens: output + earlier.reduce((sum, item) => sum + item.output_tokens, 0),
                  usd,
                });
                if (stop === 'refusal') return null;
                if (stop === 'max_tokens') return null;
                return textResult(blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
                  `anthropic:${redactSecrets(servedModel)}`, json);
              }

              const response = await providerFetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST', signal, redirect: 'error',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({
                  model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                  max_completion_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}),
                }),
              });
              if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                throw httpError(response.status);
              }
              const raw = sanitize(await responseJson(response));
              const usage = z.object({ usage: openaiUsage }).safeParse(raw);
              if (!usage.success) throw new NonsenseError('Missing model usage');
              const { prompt_tokens: input, completion_tokens: output } = usage.data.usage;
              report({ inputTokens: input, outputTokens: output, usd: price(model, input, output) });
              const message = openaiChoice.safeParse(raw);
              if (!message.success) throw new NonsenseError('Missing model completion');
              const choice = message.data.choices[0];
              if (choice.message.refusal || choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') return null;
              return textResult(choice.message.content ?? '', `openai:${message.data.model ?? model}`, json);
            },
          },
        });
      } catch (error) {
        if (error instanceof BudgetError) throw error;
        if (!(error instanceof ToolError)) throw error;
        ctx.store.appendEvent(ctx.runId, { type: 'log', level: 'warn', message: 'Model unavailable. Using deterministic output.' });
        return null;
      }
    },
  };
}
