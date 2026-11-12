#!/usr/bin/env node
// Browz agent benchmark: score a run folder.
//   node score.mjs <run dir> [--json] [--write]
// Re-scores every <run dir>/runs/<setup>/<task>.json with scorer.mjs (so you can check our scoring against the raw
// logs, or apply a scorer change to a recorded run) and prints the summary table, the per-site table and any missing
// runs. --json prints the summary as JSON instead; --write also saves <run dir>/scores.json and summary.json.
//   node score.mjs results/2026-11-02    # our published run: 46/50 and 38/50
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun, summarise } from './scorer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LABELS = { browz: 'Browz MCP', playwright: 'Plain browser MCP' };

export function loadRuns(dir, tasks) {
  const rows = []; const missing = [];
  for (const setup of Object.keys(LABELS)) {
    const sub = join(dir, 'runs', setup);
    if (!existsSync(sub)) continue;
    for (const t of tasks) {
      const f = join(sub, `${t.id}.json`);
      if (!existsSync(f)) { missing.push(`${setup}/${t.id}`); continue; }
      rows.push(scoreRun(t, JSON.parse(readFileSync(f, 'utf8'))));
    }
  }
  return { rows, missing };
}

/** Per site: tasks and successes per setup (the per-site table on gobrowz.com/agent-benchmark). */
export function bySite(summary) {
  const sites = {};
  for (const t of summary.tasks) {
    const s = (sites[t.site] ??= { site: t.site, group: t.group, tasks: 0 });
    s.tasks++;
    for (const [k, r] of Object.entries(t.bySetup)) s[k] = (s[k] ?? 0) + (r.success ? 1 : 0);
  }
  return Object.values(sites);
}

export function score(dir) {
  const file = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const chosen = meta.tasks ? file.tasks.filter((t) => meta.tasks.includes(t.id)) : file.tasks;
  const { rows, missing } = loadRuns(dir, chosen);
  const summary = { taskCount: chosen.length, missing, ...summarise(rows) };
  return { meta, rows, summary, sites: bySite(summary) };
}

const n = (x, d = 0) => (x == null ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));

export function markdown({ meta, summary, sites }) {
  const s = summary.setups;
  const keys = Object.keys(LABELS).filter((k) => s[k]);
  const row = (label, f) => `| ${label} | ${keys.map((k) => f(s[k])).join(' | ')} |`;
  return [
    `Run started ${meta.startedAt?.slice(0, 10) ?? '?'}: ${summary.taskCount} tasks, model ${meta.model ?? '?'}, ${meta.headless === false ? 'headed' : 'headless'}.`,
    '',
    `| | ${keys.map((k) => LABELS[k]).join(' | ')} |`, `|---|${keys.map(() => '---:').join('|')}|`,
    row('Tasks succeeded', (x) => `${x.all.succeeded}/${x.all.tasks} (${n(x.all.successRate, 1)}%)`),
    row('…on open sites', (x) => `${x.groups.open?.succeeded ?? 0}/${x.groups.open?.tasks ?? 0}`),
    row('…on bot-protected sites', (x) => `${x.groups.protected?.succeeded ?? 0}/${x.groups.protected?.tasks ?? 0}`),
    row('Runs blocked or challenged out', (x) => `${x.all.blocked} (${n(x.all.blockRate, 1)}%)`),
    row('Median steps (tool calls)', (x) => n(x.all.medianSteps, 1)),
    row('Median tokens per task', (x) => n(x.all.medianTokens)),
    row('Median time per task', (x) => `${n(x.all.medianSeconds, 1)} s`),
    row('Total tokens', (x) => n(x.all.totalTokens)),
    row('API cost reported by Claude Code', (x) => `US$${n(x.all.costUsd, 2)}`),
    '',
    `| Site | Group | Tasks | ${keys.map((k) => LABELS[k]).join(' | ')} |`, `|---|---|---:|${keys.map(() => '---:').join('|')}|`,
    ...sites.map((x) => `| ${x.site} | ${x.group} | ${x.tasks} | ${keys.map((k) => x[k] ?? 0).join(' | ')} |`),
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: node score.mjs <run dir> [--json] [--write]'); process.exit(2); }
  const out = score(dir);
  if (args.includes('--write')) {
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(out.rows, null, 1));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ meta: out.meta, summary: out.summary }, null, 1));
  }
  console.log(args.includes('--json') ? JSON.stringify({ summary: out.summary, sites: out.sites }, null, 1) : markdown(out));
  if (out.summary.missing.length) console.error(`missing runs: ${out.summary.missing.join(', ')}`);
}
