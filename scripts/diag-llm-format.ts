// LLM 三格式诊断：本地 mock server 捕获请求（URL/头/请求体），验证 anthropic/responses/openai 构造正确
// 运行：npx tsx scripts/diag-llm-format.ts
import http from 'node:http';
import { chat, chatStream } from '../packages/core/src/llm/deepseek.js';

const captured: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    captured.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, body });
    const isStream = body.stream === true;
    const url = req.url ?? '';
    if (isStream) {
      // SSE 流式 mock（按格式）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (url.includes('/messages')) {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"安流式"}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else if (url.includes('/responses')) {
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"应流式","sequence_number":1}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"开流式"}}]}\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.includes('/messages')) {
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic-reply' }], usage: { input_tokens: 3, output_tokens: 2 } }));
    } else if (url.includes('/responses')) {
      res.end(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses-reply' }] }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: 'openai-reply' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    }
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.DEEPSEEK_API_KEY = 'sk-mock-1234567890abcdef';

  // 1. anthropic（chat + stream）
  process.env.LLM_API_FORMAT = 'anthropic';
  const a = await chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  const c1 = captured[0]!;
  console.log('anthropic chat →', a.content);
  console.log('  URL:', c1.path, '| x-api-key:', c1.headers['x-api-key'] ? '✓' : '✗', '| anthropic-version:', c1.headers['anthropic-version'] ? '✓' : '✗');
  console.log('  body:', JSON.stringify(c1.body));
  captured.length = 0;
  const aStream = await chatStream([{ role: 'user', content: 'hi' }], (d) => {});
  console.log('anthropic stream →', aStream, '| URL:', captured[0]?.path);

  // 2. responses（chat + stream）
  captured.length = 0;
  process.env.LLM_API_FORMAT = 'responses';
  const r = await chat([{ role: 'user', content: 'hi' }]);
  console.log('\nresponses chat →', r.content);
  console.log('  URL:', captured[0]?.path, '| body:', JSON.stringify(captured[0]?.body));
  captured.length = 0;
  const rStream = await chatStream([{ role: 'user', content: 'hi' }], (d) => {});
  console.log('responses stream →', rStream, '| URL:', captured[0]?.path);

  // 3. openai 回归（chat + stream）
  captured.length = 0;
  process.env.LLM_API_FORMAT = 'openai';
  const o = await chat([{ role: 'user', content: 'hi' }]);
  console.log('\nopenai chat →', o.content, '| URL:', captured[0]?.path);
  captured.length = 0;
  const oStream = await chatStream([{ role: 'user', content: 'hi' }], (d) => {});
  console.log('openai stream →', oStream, '| URL:', captured[0]?.path);

  server.close();
  console.log('\n✅ 三格式请求构造验证完成');
}

main().catch((e) => {
  console.error('诊断异常:', e);
  process.exit(1);
});
