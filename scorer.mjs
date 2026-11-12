// Pure scoring for the agent benchmark (no I/O). Tested by scorer.test.mjs.
//   parseStreamJson(text)  -> run record from `claude -p --output-format stream-json --verbose`
//   parseFinal(text)       -> { answer, blockedSelf } from the agent's closing ANSWER:/BLOCKED: lines
//   checkAnswer(answer, check), visitedDomain(domain, calls), blockSignatures(calls)
//   scoreRun(task, run)    -> one scored row;  summarise(rows) -> per-setup numbers
//   verdict(task, row)     -> passed | challenged | blocked | failed (detection track); summariseDetection(rows)

const RESULT_TEXT_KEEP = 4000;

// Text a block or challenge page shows. Matched only in tool results (what the browser showed),
// never in the agent's own words. Names are the defence vendors' generic page wording.
export const BLOCK_SIGNATURES = [
  ['captcha', /\bcaptcha\b/i],
  ['unusual-traffic', /unusual traffic from your computer network/i],
  ['verify-human', /verify (?:that )?you(?:'|’)?re? (?:a )?human|verify you are human|confirm you are (?:a )?human/i],
  ['not-a-robot', /(?:you(?:'|’)?re|you are|i(?:'|’)?m|i am) not a robot|are you a robot/i],
  ['just-a-moment', /\bjust a moment\.\.\.|checking (?:if the site connection is secure|your browser)/i],
  ['cf-attention', /attention required! \| cloudflare|sorry, you have been blocked/i],
  ['access-denied', /\baccess denied\b|you don(?:'|’)t have permission to access/i],
  ['robot-check', /robot check|enter the characters you see below|type the characters you see in this image/i],
  ['press-hold', /press (?:&|and) hold/i],
  ['interruption', /pardon our interruption|request (?:was )?blocked|blocked by network security/i],
  ['google-sorry', /google\.[a-z.]+\/sorry\//i],
  ['http-403', /\b403 forbidden\b|\berror 403\b/i],
];

export function normalise(s) {
  return String(s ?? '')
    .replace(/[*`_]+/g, '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseFinal(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let answer = null; let blockedSelf = null;
  for (const raw of lines) {
    const l = raw.replace(/[*`]+/g, '').trim();
    const a = /^answer\s*:\s*(.*)$/i.exec(l);
    if (a) answer = a[1].trim();
    const b = /^blocked\s*:\s*(yes|no)\b/i.exec(l);
    if (b) blockedSelf = b[1].toLowerCase() === 'yes';
  }
  if (answer !== null && /^(none|n\/a|unknown)?$/i.test(normalise(answer))) answer = null;
  return { answer, blockedSelf };
}

// First number in the answer; accepts 8,848.86 / 299 792 458 / 1889.
export function firstNumber(s) {
  const m = /-?(?:\d{1,3}(?:[,   ]\d{3})+|\d+)(?:\.\d+)?/.exec(String(s ?? ''));
  return m ? Number(m[0].replace(/[,   ]/g, '')) : null;
}

const PRICE = /(?:[$€£¥]|\b(?:usd|aud|eur|gbp|cad)\b)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:\b(?:usd|aud|eur|gbp|cad)\b|[$€£])/i;
const NON_ANSWER = /^(none|n\/a|unknown|not found|could not|couldn(?:'|’)t|unable|blocked|i (?:could|can)(?:not|n(?:'|’)t))/i;

export function checkAnswer(answer, check) {
  if (answer == null || !check) return false;
  const a = normalise(answer);
  if (!a || NON_ANSWER.test(a)) return false;
  switch (check.type) {
    case 'exact': return a === normalise(check.value);
    case 'oneOf': return check.value.some((v) => a === normalise(v));
    case 'regex': return new RegExp(check.value, 'i').test(a);
    case 'number': { const n = firstNumber(a); return n !== null && n >= check.min && n <= check.max; }
    case 'price': return PRICE.test(a);
    case 'text': return a.length >= (check.minLength ?? 1);
    default: throw new Error(`unknown check type ${check.type}`);
  }
}

function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// URLs the browser was sent to or reported being on: tool inputs, plus "Page URL:" / "url" lines in results.
export function visitedUrls(calls) {
  const urls = new Set();
  for (const c of calls ?? []) {
    for (const s of strings(c.input)) if (/^https?:\/\//i.test(s)) urls.add(s);
    const t = c.resultText ?? '';
    for (const m of t.matchAll(/(?:page url|"url"|url)\s*[:=]\s*"?(https?:\/\/[^\s"'<>)]+)/gi)) urls.add(m[1]);
  }
  return [...urls];
}

export function visitedDomain(domain, calls) {
  return visitedUrls(calls).some((u) => {
    try { return new URL(u).hostname.includes(domain); } catch { return false; }
  });
}

export function blockSignatures(calls) {
  const seen = new Set();
  for (const c of calls ?? []) {
    const t = c.resultText ?? '';
    for (const [name, re] of BLOCK_SIGNATURES) if (re.test(t)) seen.add(name);
  }
  return [...seen];
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n');
}

export function parseStreamJson(text) {
  const run = { init: null, calls: [], finalText: '', result: null, images: 0 };
  const byId = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'init') {
      run.init = { model: e.model, claude_code_version: e.claude_code_version, tools: (e.tools ?? []).length,
        mcp_servers: e.mcp_servers };
    }
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use') {
        const call = { id: c.id, name: c.name, input: c.input, resultText: '', isError: false };
        byId.set(c.id, call); run.calls.push(call);
      } else if (c.type === 'tool_result') {
        const call = byId.get(c.tool_use_id);
        if (!call) continue;
        if (Array.isArray(c.content)) run.images += c.content.filter((x) => x?.type === 'image').length;
        call.resultText = textOf(c.content).slice(0, RESULT_TEXT_KEEP);
        call.isError = !!c.is_error;
      }
    }
    if (e.type === 'result') {
      run.result = { subtype: e.subtype, is_error: !!e.is_error, num_turns: e.num_turns, duration_ms: e.duration_ms,
        total_cost_usd: e.total_cost_usd, usage: e.usage ?? {} };
      if (typeof e.result === 'string') run.finalText = e.result;
    }
  }
  return run;
}

export function tokensOf(usage = {}) {
  const input = usage.input_tokens ?? 0; const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0; const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
}

// run: { setup, calls, finalText, result, wallMs, timedOut, error }
export function scoreRun(task, run) {
  const { answer, blockedSelf } = parseFinal(run.finalText);
  const correct = checkAnswer(answer, task.check);
  const visited = visitedDomain(task.domain, run.calls);
  const signatures = blockSignatures(run.calls);
  const success = correct && visited && blockedSelf !== true && !run.timedOut && !run.error;
  // A detector page that the agent read and that flagged the browser (a value outside the fixed threshold) is a block.
  const flagged = task.kind === 'detector' && !correct && visited && answerRead(answer, task.check);
  const blocked = blockedSelf === true || (signatures.length > 0 && !correct) || flagged;
  const row = {
    id: task.id, group: task.group, site: task.site, setup: run.setup,
    success, correct, visited, blocked, blockedSelf, signatures, answer,
    steps: (run.calls ?? []).length,
    turns: run.result?.num_turns ?? null,
    tokens: tokensOf(run.result?.usage),
    costUsd: run.result?.total_cost_usd ?? null,
    wallMs: run.wallMs ?? run.result?.duration_ms ?? null,
    timedOut: !!run.timedOut, error: run.error ?? null,
  };
  if (task.track === 'detection') Object.assign(row, { defence: task.defence, kind: task.kind, flagged, verdict: verdict(task, row) });
  return row;
}

// The agent gave a usable value for the check (so a miss means the page's verdict, not a failure to read it).
export function answerRead(answer, check) {
  if (answer == null) return false;
  const a = normalise(answer);
  if (!a || NON_ANSWER.test(a)) return false;
  if (check?.type === 'number') return firstNumber(a) !== null;
  return true;
}

// Signatures of a challenge page (an interstitial the browser had to get through), not just a page that mentions
// a CAPTCHA (many sites say "protected by reCAPTCHA" in a footer) or a stray 403 in a resource list.
export const CHALLENGE_SIGNATURES = new Set(['just-a-moment', 'press-hold', 'verify-human', 'not-a-robot', 'robot-check', 'cf-attention', 'interruption']);

export function verdict(task, row) {
  if (row.success) return task.kind !== 'detector' && row.signatures.some((s) => CHALLENGE_SIGNATURES.has(s)) ? 'challenged' : 'passed';
  return row.blocked ? 'blocked' : 'failed';
}

export const VERDICTS = ['passed', 'challenged', 'blocked', 'failed'];

/** Per setup: verdict counts overall and per defence, plus the usual task/token/time block. */
export function summariseDetection(rows) {
  const out = { setups: {}, defences: [...new Set(rows.map((r) => r.defence))], tasks: [] };
  const count = (rs) => Object.fromEntries(VERDICTS.map((v) => [v, rs.filter((r) => r.verdict === v).length]));
  for (const s of [...new Set(rows.map((r) => r.setup))]) {
    const mine = rows.filter((r) => r.setup === s);
    out.setups[s] = { all: { ...block(mine), verdicts: count(mine) },
      defences: Object.fromEntries(out.defences.map((d) => { const m = mine.filter((r) => r.defence === d); return [d, { tasks: m.length, ...count(m) }]; })) };
  }
  for (const id of [...new Set(rows.map((r) => r.id))]) {
    const t = rows.filter((r) => r.id === id);
    out.tasks.push({ id, defence: t[0].defence, kind: t[0].kind, site: t[0].site,
      bySetup: Object.fromEntries(t.map((r) => [r.setup, { verdict: r.verdict, success: r.success, answer: r.answer, steps: r.steps,
        tokens: r.tokens.total, seconds: r.wallMs == null ? null : Math.round(r.wallMs / 100) / 10 }])) });
  }
  return out;
}

export function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

function block(rows) {
  const ok = rows.filter((r) => r.success);
  return {
    tasks: rows.length,
    succeeded: ok.length,
    successRate: pct(ok.length, rows.length),
    blocked: rows.filter((r) => r.blocked).length,
    blockRate: pct(rows.filter((r) => r.blocked).length, rows.length),
    medianSteps: median(rows.map((r) => r.steps)),
    medianTokens: median(rows.map((r) => r.tokens.total)),
    medianOutputTokens: median(rows.map((r) => r.tokens.output)),
    medianSeconds: median(rows.map((r) => (r.wallMs == null ? null : r.wallMs / 1000))),
    totalTokens: sum(rows.map((r) => r.tokens.total)),
    costUsd: Math.round(sum(rows.map((r) => r.costUsd)) * 100) / 100,
  };
}

export function summarise(rows) {
  const setups = [...new Set(rows.map((r) => r.setup))];
  const groups = [...new Set(rows.map((r) => r.group))];
  const out = { setups: {}, tasks: [] };
  for (const s of setups) {
    const mine = rows.filter((r) => r.setup === s);
    out.setups[s] = { all: block(mine), groups: Object.fromEntries(groups.map((g) => [g, block(mine.filter((r) => r.group === g))])) };
  }
  for (const id of [...new Set(rows.map((r) => r.id))]) {
    const t = rows.filter((r) => r.id === id);
    out.tasks.push({ id, group: t[0].group, site: t[0].site,
      bySetup: Object.fromEntries(t.map((r) => [r.setup, { success: r.success, blocked: r.blocked, steps: r.steps,
        tokens: r.tokens.total, seconds: r.wallMs == null ? null : Math.round(r.wallMs / 100) / 10 }])) });
  }
  return out;
}

// Public IP addresses never reach a committed record (CLAUDE.md: redact public IPs, which include proxy exits).
// Loopback, private, link-local and documentation ranges stay; a dotted version such as 156.0.8078.48 is not an
// address (an octet over 255), so it stays too.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
const IPV6 = /(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})(?![0-9a-f:])|(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:?){1,6}(?![0-9a-f:])/gi;
export function isPublicIpv4(parts) {
  const [a, b] = parts.map(Number);
  if (parts.some((p) => Number(p) > 255 || (p.length > 1 && p.startsWith('0')))) return null; // not an address
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return true;
}
export function redactPublicIps(text) {
  return String(text)
    .replace(IPV4, (m, ...g) => (isPublicIpv4(g.slice(0, 4)) ? '<public-ip>' : m))
    .replace(IPV6, (m) => (/^(?:::1?|fe80:|fc|fd)/i.test(m) || !/[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i.test(m) || /^\d{1,2}:\d{2}:\d{2}$/.test(m) ? m : '<public-ip>'));
}
