#!/usr/bin/env node
// A stand-in for `claude -p ... --output-format stream-json`, so the tests run with no browser, no network and no
// Claude account. It answers from the prompt's start URL: Google pages show a block page, every other page the answer.
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0 (fake)'); process.exit(0); }
const text = args[args.indexOf('-p') + 1];
const start = /Start at: (\S+)/.exec(text)[1];
const server = /mcp__(\w+)/.exec(args[args.indexOf('--allowedTools') + 1])[1];
const tool = server === 'browz' ? 'mcp__browz__browz_navigate' : 'mcp__playwright__browser_navigate';
// FAKE_CLAUDE_CRASH=1: exit like a usage limit, with no result event (a harness failure, not an agent result).
if (process.env.FAKE_CLAUDE_CRASH) { console.error('usage limit reached'); process.exit(1); }
const blocked = start.includes('google.');
const page = blocked ? 'Our systems have detected unusual traffic from your computer network.' : 'heading "Attention Is All You Need"';
const ev = [
  { type: 'system', subtype: 'init', model: 'fake-model', claude_code_version: '0.0.0', tools: [tool] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: tool, input: { url: start } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: `- Page URL: ${start}\n${page}` }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    result: blocked ? 'ANSWER: NONE\nBLOCKED: yes' : 'ANSWER: Attention Is All You Need\nBLOCKED: no' },
];
for (const e of ev) console.log(JSON.stringify(e));
