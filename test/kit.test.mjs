// The kit's own tests: no browser, no network, no Claude account (a stub stands in).   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as run, parseArgs, prompt, claudeArgs, selectTasks, DISALLOWED, DEFAULTS } from '../bench.mjs';
import { score } from '../score.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TASKS = JSON.parse(readFileSync(join(ROOT, 'tasks.json'), 'utf8')).tasks;

test('the task list: 50 tasks, 32 on open sites and 18 on bot-protected ones, unique ids', () => {
  assert.equal(TASKS.length, 50);
  assert.equal(TASKS.filter((t) => t.group === 'open').length, 32);
  assert.equal(TASKS.filter((t) => t.group === 'protected').length, 18);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, 50);
  for (const t of TASKS) for (const k of ['id', 'group', 'site', 'domain', 'start', 'ask', 'check']) assert.ok(t[k], `${t.id}: ${k}`);
});

test('the published run re-scores to its published numbers', () => {
  const { summary, meta } = score(join(ROOT, 'results', '2026-11-02'));
  assert.deepEqual(summary.missing, []);
  const b = summary.setups.browz; const p = summary.setups.playwright;
  assert.deepEqual([b.all.succeeded, b.all.tasks, b.all.blocked], [46, 50, 3]);
  assert.deepEqual([b.groups.open.succeeded, b.groups.protected.succeeded], [32, 14]);
  assert.deepEqual([p.all.succeeded, p.all.tasks, p.all.blocked], [38, 50, 12]);
  assert.deepEqual([p.groups.open.succeeded, p.groups.protected.succeeded], [29, 9]);
  assert.deepEqual([meta.model, meta.maxTurns, meta.timeoutSeconds, meta.playwrightMcp], [DEFAULTS.model, DEFAULTS.maxTurns, DEFAULTS.timeout, DEFAULTS.playwright]);
  assert.deepEqual(meta.disallowedTools, DISALLOWED);
});

test('parseArgs: defaults are the published settings; unknown setups and flags are refused', () => {
  const o = parseArgs(['--out', '/tmp/x', '--setups', 'playwright']);
  assert.deepEqual([o.model, o.maxTurns, o.timeout, o.playwright, o.pwBrowser], ['sonnet', 30, 300, '@playwright/mcp@0.0.84', 'chrome']);
  assert.throws(() => parseArgs([]), /--out/);
  assert.throws(() => parseArgs(['--out', 'x']), /browz-agent/);
  assert.throws(() => parseArgs(['--out', 'x', '--setups', 'other']), /unknown setup/);
  assert.throws(() => parseArgs(['--out', 'x', '--bogus']), /unknown argument/);
  assert.throws(() => selectTasks(TASKS, 'nope'), /unknown task ids: nope/);
});

test('both setups get the same task text and rules; only the browser lead differs', () => {
  const t = TASKS[0];
  const a = prompt(t, 'browz', 'p-1'); const b = prompt(t, 'playwright');
  const tail = (s) => s.slice(s.indexOf('Start at:'));
  assert.equal(tail(a), tail(b));
  assert.match(a, /"p-1"/);
  const args = claudeArgs(parseArgs(['--out', 'x', '--setups', 'playwright']), 'hi', '/c.json', 'playwright');
  assert.ok(args.includes('--strict-mcp-config'));
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task']) assert.ok(args.includes(tool));
});

test('a stubbed run records, scores and resumes; a harness failure is retried, not recorded', async () => {
  const out = mkdtempSync(join(tmpdir(), 'browz-bench-test-'));
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
  try {
    const argv = ['--out', out, '--setups', 'playwright', '--tasks', 'arxiv-attention,google-light', '--claude', FAKE, '--no-prefetch'];
    process.env.FAKE_CLAUDE_CRASH = '1';
    await run(argv);
    delete process.env.FAKE_CLAUDE_CRASH;
    assert.ok(!existsSync(join(out, 'runs/playwright/arxiv-attention.json')));
    assert.ok(existsSync(join(out, 'errors/playwright/arxiv-attention.json')));
    await run(argv);
    const { summary } = score(out);
    assert.equal(summary.setups.playwright.all.succeeded, 1);
    assert.equal(summary.setups.playwright.all.blocked, 1);
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
    assert.equal(meta.host.name, undefined, 'no host name in the record');
  } finally {
    delete process.env.FAKE_CLAUDE_CRASH;
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    rmSync(out, { recursive: true, force: true });
  }
});
