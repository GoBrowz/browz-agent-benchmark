#!/usr/bin/env node
// Browz agent benchmark: the runner. The same Claude model, with the same prompt, does each public web task twice:
// once through the Browz MCP server (a fresh ephemeral Browz session per task) and once through a plain browser MCP
// (the open-source Playwright MCP, a fresh isolated browser context per task). Both headless by default.
//
//   node bench.mjs --browz <Browz.app or install folder> --out <dir>
//        [--setups browz,playwright] [--tasks all|id,id] [--model sonnet] [--max-turns 30] [--timeout 300]
//        [--playwright @playwright/mcp@0.0.84] [--pw-browser chrome] [--claude claude] [--headed]
//        [--agent <browz-agent>] [--mcp <browz-mcp>] [--engine <Chromium binary>] [--fingerprint <dir>]
//        [--dry-run] [--no-prefetch]
//   then: node score.mjs <dir>
//
// Your own Claude credential must be in the environment: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN. It is passed
// to `claude` through the environment only, and never printed or written.
//
// Browz runs from your installed app with its OWN scratch data folder (BROWZ_DATA in a new temp folder,
// BROWZ_KEYSTORE=off, a random non-default port), so the run never reads or changes your own Browz profiles.
//
// Each task's run is saved to <out>/runs/<setup>/<task>.json as soon as it ends; existing files are skipped, so a
// stopped run resumes where it stopped. A harness failure (the browser or claude did not start, a usage limit) is
// kept under <out>/errors/ and retried on the next run, never recorded as a task failure. The two setups run side
// by side, one lane each, in the same task order. Every record is passed through redact.mjs before it is written
// (keys, emails, home and temp paths, host and user names, IP addresses), and scored before that.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStreamJson, scoreRun } from './scorer.mjs';
import { sanitiseText } from './redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SETUPS = ['browz', 'playwright'];

/** The settings of the published run (results/2026-11-02/meta.json). */
export const DEFAULTS = { model: 'sonnet', maxTurns: 30, timeout: 300, playwright: '@playwright/mcp@0.0.84', pwBrowser: 'chrome' };

export function parseArgs(argv) {
  const o = { setups: [...SETUPS], tasks: 'all', ...DEFAULTS, claude: 'claude', dryRun: false, prefetch: true, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--out') o.out = v();
    else if (k === '--browz') o.browz = v();
    else if (k === '--setups') o.setups = v().split(',').filter(Boolean);
    else if (k === '--tasks') o.tasks = v();
    else if (k === '--agent') o.agent = v();
    else if (k === '--mcp') o.mcp = v();
    else if (k === '--engine') o.engine = v();
    else if (k === '--fingerprint') o.fingerprint = v();
    else if (k === '--model') o.model = v();
    else if (k === '--max-turns') o.maxTurns = Number(v());
    else if (k === '--timeout') o.timeout = Number(v());
    else if (k === '--playwright') o.playwright = v();
    else if (k === '--pw-browser') o.pwBrowser = v();
    else if (k === '--claude') o.claude = v();
    else if (k === '--headed') o.headed = true;
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--no-prefetch') o.prefetch = false;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!o.out) throw new Error('--out <dir> is required');
  for (const s of o.setups) if (!SETUPS.includes(s)) throw new Error(`unknown setup ${s} (setups: ${SETUPS.join(', ')})`);
  if (o.setups.includes('browz')) {
    Object.assign(o, { ...resolveBrowz(o.browz), ...Object.fromEntries(['agent', 'mcp', 'engine', 'fingerprint'].filter((x) => o[x]).map((x) => [x, o[x]])) });
    if (!o.dryRun) for (const x of ['agent', 'mcp']) if (!o[x] || !existsSync(o[x])) throw new Error(`the browz setup needs ${x === 'agent' ? 'browz-agent' : 'browz-mcp'}: pass --browz <Browz.app or install folder> (or --${x} <path>)`);
  }
  return o;
}

/**
 * Where an installed Browz keeps the agent, the MCP server, the engine and the fingerprint tables.
 * macOS: Browz.app/Contents/Resources/ holds all four (engine/BrowzEngine.app). Windows (install folder) and Linux
 * (an extracted AppImage, squashfs-root/usr/lib/Browz, or its folder) hold the agent, MCP server and tables; the
 * engine is downloaded on first start, so pass --engine there if the agent cannot find its own.
 */
export function resolveBrowz(path) {
  if (!path) return {};
  const p = resolve(path);
  const candidates = [join(p, 'Contents', 'Resources'), join(p, 'usr', 'lib', 'Browz'), join(p, 'squashfs-root', 'usr', 'lib', 'Browz'), p];
  const root = candidates.find((c) => existsSync(c) && statSync(c).isDirectory() && (existsSync(join(c, 'browz-agent')) || existsSync(join(c, 'browz-agent.exe'))));
  if (!root) throw new Error(`no browz-agent found in ${p} (pass the Browz.app, the Windows install folder or the extracted AppImage)`);
  const exe = (n) => (existsSync(join(root, `${n}.exe`)) ? join(root, `${n}.exe`) : join(root, n));
  const engines = [join(root, 'engine', 'BrowzEngine.app', 'Contents', 'MacOS', 'Chromium'), join(root, 'engine', 'chrome.exe'), join(root, 'engine', 'chrome')];
  return { agent: exe('browz-agent'), mcp: exe('browz-mcp'), engine: engines.find((e) => existsSync(e)) ?? null, fingerprint: join(root, 'fingerprint') };
}

export function loadTasks() {
  return JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
}

export function selectTasks(all, spec) {
  if (spec === 'all') return all;
  const want = spec.split(',');
  const unknown = want.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(', ')}`);
  return all.filter((t) => want.includes(t.id));
}

// Built-in tools the agent may not use: the browser MCP is the only way to the web.
export const DISALLOWED = ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read', 'Write',
  'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'Skill', 'SlashCommand'];

/** The exact prompt. Only the two lead lines differ between the setups; the task text and the rules are the same. */
export function prompt(task, setup, profileId) {
  const lead = setup === 'browz'
    ? [`You are doing a web task in a browser, using only the tools of the "browz" MCP server.`,
      `A Browz browser session is already open for you: pass "${profileId}" as the id argument of the page tools`
      + ' (browz_navigate, browz_snapshot, browz_act, browz_wait, browz_screenshot, ...). Do not create, start, stop or'
      + ' delete profiles or sessions.']
    : ['You are doing a web task in a browser, using only the tools of the "playwright" MCP server.',
      'The browser opens when you first navigate.'];
  return [...lead,
    `Start at: ${task.start}`,
    `Task: ${task.ask}`,
    'Rules: answer only from what you see on the site, never from memory. Do not sign in, sign up, buy anything or submit'
    + ' any form other than a site search. Dismiss cookie or location banners if they are in the way. If a block page,'
    + ' CAPTCHA or bot check stops you and you cannot get past it, stop and say so.',
    'Finish your reply with exactly these two lines:',
    'ANSWER: <your answer, or NONE>',
    'BLOCKED: <yes if a block page, CAPTCHA or bot check stopped you, otherwise no>'].join('\n');
}

export function claudeArgs(o, text, cfgPath, server) {
  return ['-p', text, '--mcp-config', cfgPath, '--strict-mcp-config', '--model', o.model,
    '--allowedTools', `mcp__${server}`, '--disallowedTools', ...DISALLOWED,
    '--setting-sources', 'project', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '--max-turns', String(o.maxTurns)];
}

function runClaude(o, args, cwd) {
  return new Promise((done) => {
    const t0 = Date.now();
    const c = spawn(o.claude, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = ''; let se = ''; let timedOut = false;
    c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => { timedOut = true; c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 5000); }, o.timeout * 1000);
    c.on('error', (e) => { se += String(e); });
    c.on('close', (code) => { clearTimeout(timer); done({ code, so, se, timedOut, wallMs: Date.now() - t0 }); });
  });
}

/** Starts browz-agent on a scratch data folder and a random non-default port; resolves once /status answers. */
export async function startAgent(o, dataDir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 51000 + Math.floor(Math.random() * 4000);
    const env = { ...process.env, BROWZ_DATA: dataDir, BROWZ_API_PORT: String(port), BROWZ_KEYSTORE: 'off' };
    if (o.fingerprint) Object.assign(env, { BROWZ_TABLES: join(o.fingerprint, 'tables.generated.json'), BROWZ_REALDATA: join(o.fingerprint, 'realdata') });
    if (o.engine) env.BROWZ_CHROMIUM_BINARY = o.engine;
    // The agent treats ANY value, even empty, as headless, so headed means absent.
    if (o.headed) delete env.BROWZ_HEADLESS; else env.BROWZ_HEADLESS = '1';
    const child = spawn(o.agent, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (child.exitCode !== null) break;
      const tokenPath = join(dataDir, 'api-token');
      if (!existsSync(tokenPath)) continue;
      const token = readFileSync(tokenPath, 'utf8').trim();
      try {
        const s = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
        if (s.product === 'browz-agent') return { child, port, token, status: s };
      } catch { /* not up yet */ }
    }
    child.kill('SIGTERM');
    console.error(`browz-agent did not come up on port ${port}: ${log.split('\n').slice(-3).join(' | ')}`);
  }
  throw new Error('browz-agent never started');
}

// A lane opens one browser per task for one setup: task(t) -> { cfgPath, server, cwd, profileId, cleanup }, then close().
async function browzLane(o) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'browz-bench-')));
  const agent = await startAgent(o, dataDir);
  const api = async (path, body = {}) => (await fetch(`http://127.0.0.1:${agent.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` }, body: JSON.stringify(body),
  })).json();
  const env = { BROWZ_DATA: dataDir, BROWZ_MCP: o.mcp, BROWZ_API_PORT: String(agent.port), BROWZ_KEYSTORE: 'off' };
  const cfgPath = join(dataDir, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { browz: { command: o.mcp, args: [], env } } }), { mode: 0o600 });
  return {
    info: { browz: agent.status.version ?? null },
    async task(task) {
      const opened = await api('/api/v1/agent/session/open', { task: `benchmark ${task.id}`, mode: 'ephemeral', headless: !o.headed });
      if (opened.code !== 0) throw new Error(`session open: ${opened.msg}`);
      const { sessionId, profileId } = opened.data;
      return { cfgPath, server: 'browz', cwd: dataDir, profileId,
        cleanup: () => api('/api/v1/agent/session/close', { sessionId }).catch(() => {}) };
    },
    async close() {
      await api('/api/v1/browser/stop-all', {}).catch(() => {});
      agent.child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function playwrightLane(o) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'browz-bench-pw-')));
  const cfgPath = join(work, 'mcp.json');
  const args = ['-y', o.playwright, ...(o.headed ? [] : ['--headless']), '--isolated', '--browser', o.pwBrowser];
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args } } }));
  return {
    info: {},
    async task() { return { cfgPath, server: 'playwright', cwd: work, cleanup: async () => {} }; },
    async close() { rmSync(work, { recursive: true, force: true }); },
  };
}

async function runTask(o, setup, lane, task) {
  const file = join(o.out, 'runs', setup, `${task.id}.json`);
  if (existsSync(file)) { console.log(`skip ${setup} ${task.id} (recorded)`); return; }
  const startedAt = new Date().toISOString();
  let r;
  try {
    const t = await lane.task(task);
    try { r = await runClaude(o, claudeArgs(o, prompt(task, setup, t.profileId), t.cfgPath, t.server), t.cwd); } finally { await t.cleanup(); }
  } catch (e) { r = { error: String(e?.message ?? e) }; }
  const parsed = parseStreamJson(r.so ?? '');
  const run = { setup, taskId: task.id, startedAt, exitCode: r.code ?? null, timedOut: !!r.timedOut, wallMs: r.wallMs ?? null,
    error: r.error ?? (parsed.result || r.timedOut ? null : `claude exited ${r.code}: ${(r.se ?? '').slice(-300)}`),
    ...parsed };
  if (run.error && !parsed.result && !run.timedOut) {
    const ef = join(o.out, 'errors', setup, `${task.id}.json`);
    mkdirSync(dirname(ef), { recursive: true });
    writeFileSync(ef, sanitiseText(JSON.stringify(run, null, 1)));
    console.log(`${setup.padEnd(10)} ${task.id.padEnd(20)} ERROR (not recorded, retried on the next run): ${run.error}`.slice(0, 300));
    return;
  }
  const score = scoreRun(task, run);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sanitiseText(JSON.stringify({ ...run, score }, null, 1)));
  console.log(`${setup.padEnd(10)} ${task.id.padEnd(20)} ${score.success ? 'ok  ' : 'FAIL'} ${score.blocked ? 'blocked ' : ''}steps=${score.steps} tokens=${score.tokens.total} ${Math.round((score.wallMs ?? 0) / 1000)}s ${score.answer ?? ''}`.slice(0, 200));
}

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; }
}

export async function main(argv) {
  const o = parseArgs(argv);
  const file = loadTasks();
  const tasks = selectTasks(file.tasks, o.tasks);
  mkdirSync(o.out, { recursive: true });
  // No host name, user name or path goes into the record: only the OS family and release.
  const meta = {
    benchmark: 'browz-agent-benchmark', taskFileVersion: file.version ?? null, startedAt: new Date().toISOString(),
    setups: o.setups, tasks: tasks.map((t) => t.id),
    model: o.model, maxTurns: o.maxTurns, timeoutSeconds: o.timeout, playwrightMcp: o.playwright, playwrightBrowser: o.pwBrowser,
    browzMcp: 'browz-mcp binary', headless: !o.headed,
    host: { platform: platform(), release: release() },
    claudeVersion: o.dryRun ? null : version(o.claude, ['--version']),
    browzVersion: o.setups.includes('browz') && o.agent && existsSync(o.agent) ? version(o.agent, ['--version']) : null,
    disallowedTools: DISALLOWED,
  };
  if (o.dryRun) {
    console.log(JSON.stringify({ ...meta, browz: o.setups.includes('browz') ? { agent: !!o.agent, mcp: !!o.mcp, engine: !!o.engine, fingerprint: !!o.fingerprint } : null,
      example: Object.fromEntries(o.setups.map((s) => [s, prompt(tasks[0], s, '<profileId>')])) }, null, 1));
    return meta;
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error('set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) to your own Claude credential');
  // Fetch the Playwright MCP package before any timing starts.
  if (o.setups.includes('playwright') && o.prefetch) meta.playwrightMcpVersion = version('npx', ['-y', o.playwright, '--version']);
  writeFileSync(join(o.out, 'meta.json'), JSON.stringify(meta, null, 1));
  const lane = async (s) => {
    const l = s === 'browz' ? await browzLane(o) : await playwrightLane(o);
    try { for (const t of tasks) await runTask(o, s, l, t); } finally { await l.close(); }
  };
  const settled = await Promise.allSettled(o.setups.map(lane));
  meta.laneErrors = settled.filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message ?? x.reason));
  meta.endedAt = new Date().toISOString();
  writeFileSync(join(o.out, 'meta.json'), JSON.stringify(meta, null, 1));
  if (meta.laneErrors.length) { console.error(meta.laneErrors.join('\n')); process.exitCode = 1; }
  return meta;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(2); });
}
