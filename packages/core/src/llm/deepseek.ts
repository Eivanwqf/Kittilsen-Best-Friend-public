// LLM 客户端（多格式：OpenAI chat/completions 默认 / Anthropic messages / OpenAI Responses）
// 供分类器 / 演化判定 / 检索规划器共用。JSON 模式 + 指数退避重试 + token 用量统计。
// 格式由 LLM_API_FORMAT 控制（openai | anthropic | responses），env 运行时读取。
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  json?: boolean; // JSON 模式（openai: response_format；responses: text.format；anthropic: system 指令）
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type LlmFormat = 'openai' | 'anthropic' | 'responses';

// env 运行时读取（避免 ESM 求值顺序问题：server 在 import 本模块后才 dotenv.config）
const MAX_RETRIES = 3;

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function llmFormat(): LlmFormat {
  const f = env('LLM_API_FORMAT', 'openai');
  return f === 'anthropic' || f === 'responses' ? f : 'openai';
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// ── 格式适配：端点 / 请求头 / 请求体 / 响应解析 ──

function buildEndpoint(format: LlmFormat, baseUrl: string): string {
  // 防御：用户可能在 baseUrl 末尾多填 /（如 /v1/）→ 去尾斜杠避免双斜杠 404
  const base = baseUrl.replace(/\/+$/, '');
  if (format === 'anthropic') return `${base}/messages`;
  if (format === 'responses') return `${base}/responses`;
  return `${base}/chat/completions`;
}

function buildHeaders(format: LlmFormat, apiKey: string): Record<string, string> {
  if (format === 'anthropic') {
    return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

function buildBody(format: LlmFormat, messages: LlmMessage[], opts: ChatOptions, stream: boolean): Record<string, unknown> {
  const model = env('DEEPSEEK_MODEL', 'deepseek-chat');
  if (format === 'anthropic') {
    // system 提为顶层字段；max_tokens 必填；无 response_format（JSON 靠 system 指令）
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system');
    return {
      model,
      system: system || undefined,
      messages: rest.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.2,
      ...(opts.json ? { json: true } : {}), // anthropic 支持 json: true 原生 JSON 模式
      stream,
    };
  }
  if (format === 'responses') {
    return {
      model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream,
    };
  }
  // openai
  return {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    stream,
  };
}

interface ParsedResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

function parseContent(format: LlmFormat, data: Record<string, unknown>): ParsedResult {
  if (format === 'anthropic') {
    const parts = (data.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
    const content = parts.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const input = (data.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0;
    const output = (data.usage as { output_tokens?: number } | undefined)?.output_tokens ?? 0;
    return { content, usage: { promptTokens: input, completionTokens: output, totalTokens: input + output } };
  }
  if (format === 'responses') {
    const output = (data.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined) ?? [];
    const content = output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text' || c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const input = (data.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0;
    const outputT = (data.usage as { output_tokens?: number } | undefined)?.output_tokens ?? 0;
    return { content, usage: { promptTokens: input, completionTokens: outputT, totalTokens: input + outputT } };
  }
  // openai
  const choices = (data.choices as Array<{ message?: { content?: string } }> | undefined) ?? [];
  const content = choices[0]?.message?.content ?? '';
  const usage = (data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined) ?? {};
  return {
    content,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
  };
}

// ── chat（非流式）+ 指数退避重试 ──

export async function chat(messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const format = llmFormat();
  const apiKey = env('DEEPSEEK_API_KEY', '');
  if (!apiKey) throw new LlmError('DEEPSEEK_API_KEY 未配置（.env）');
  const baseUrl = env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
  const url = buildEndpoint(format, baseUrl);
  const body = buildBody(format, messages, opts, false);

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(format, apiKey),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // 429/5xx 重试；其他（4xx）不重试
        if (res.status === 429 || res.status >= 500) {
          throw new LlmError(`LLM HTTP ${res.status}`, res.status);
        }
        const text = await res.text().catch(() => '');
        throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const parsed = parseContent(format, data);
      if (!parsed.content) throw new LlmError('LLM 返回空 content');
      return parsed;
    } catch (err) {
      lastErr = err;
      if (err instanceof LlmError && err.status && !(err.status === 429 || err.status >= 500)) {
        throw err; // 4xx 不重试
      }
      const delay = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new LlmError(`LLM 重试 ${MAX_RETRIES} 次仍失败: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

// JSON 模式封装：解析失败抛错，由调用方降级
export async function chatJson<T>(messages: LlmMessage[], opts: ChatOptions = {}): Promise<T> {
  const result = await chat(messages, { ...opts, json: true });
  return JSON.parse(result.content) as T;
}

// ── 流式聊天：SSE 转发 delta（/api/chat 用）。按格式解析不同事件流 ──

export async function chatStream(
  messages: LlmMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {},
): Promise<string> {
  const format = llmFormat();
  const apiKey = env('DEEPSEEK_API_KEY', '');
  if (!apiKey) throw new LlmError('DEEPSEEK_API_KEY 未配置（.env）');
  const baseUrl = env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
  const url = buildEndpoint(format, baseUrl);
  const body = buildBody(format, messages, { ...opts, temperature: opts.temperature ?? 0.7 }, true);

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(format, apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`LLM stream HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 按行分隔：event: xxx / data: {...}
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          eventName = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let delta = '';
        if (format === 'openai') {
          try {
            const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            delta = json.choices?.[0]?.delta?.content ?? '';
          } catch {
            /* 忽略解析失败的行 */
          }
        } else if (format === 'anthropic') {
          // event: content_block_delta → data: {"delta":{"type":"text_delta","text":"..."}}
          if (eventName === 'content_block_delta') {
            try {
              const json = JSON.parse(payload) as { delta?: { text?: string } };
              delta = json.delta?.text ?? '';
            } catch {
              /* 忽略 */
            }
          }
        } else {
          // responses: event: response.output_text.delta → data: {"delta":"文本"}
          if (eventName === 'response.output_text.delta') {
            try {
              const json = JSON.parse(payload) as { delta?: string };
              delta = json.delta ?? '';
            } catch {
              /* 忽略 */
            }
          }
        }
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return full;
}
