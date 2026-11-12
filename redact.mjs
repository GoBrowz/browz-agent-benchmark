#!/usr/bin/env node
// Agent benchmark: take secrets and machine details out of run records before anyone shares them.
//   node redact.mjs <run dir>           redact every .json file in place, then scan; exits 1 if anything is left
//   node redact.mjs <run dir> --check   scan only
// Redacts: API keys and bearer tokens, OAuth client ids in URLs, email addresses, home and temp folder paths, host
// names (*.local and this machine's name), this account's user name, private and public IP addresses (public ones
// with the scorer's rule, so a version number such as 156.0.8078.48 stays). Used by export-kit.mjs for the published
// run and by the kit's bench.mjs for every new run record.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactPublicIps, isPublicIpv4 } from './scorer.mjs';

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** This machine's own names (its host name and the account's user name), as extra words to redact. */
export function localNames() {
  const out = [];
  try { const h = hostname().replace(/\.local$/i, ''); if (h.length >= 3) out.push(h); } catch { /* none */ }
  try { const u = userInfo().username; if (u.length >= 3) out.push(u); } catch { /* none */ }
  return out;
}

/** Redactions, in order: [category, pattern, replacement]. */
export const REDACTIONS = [
  ['secret', /sk-ant-[A-Za-z0-9_-]+/g, '<secret>'],
  ['secret', /\bsk-[A-Za-z0-9_-]{20,}/g, '<secret>'],
  ['secret', /\b(?:bmcp|blcl)_[A-Za-z0-9_-]+/g, '<secret>'],
  ['secret', /\bla_[0-9a-f]{10,}\b/g, '<secret>'],
  ['secret', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <secret>'],
  ['oauth-client-id', /\bclient_id=[^&"\\\s]+/g, 'client_id=<redacted>'],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>'],
  ['home-path', /(?:\/Users|\/home)\/[^/\s"\\]+/g, '<home>'],
  ['home-path', /[A-Za-z]:\\\\?Users\\\\?[^\\\s"]+/g, '<home>'],
  ['temp-path', /(?:\/private)?\/var\/folders\/[^\s"\\]+/g, '<tmp>'],
  ['temp-path', /-private-var-folders-[A-Za-z0-9_-]+/g, '-<tmp>'],
  ['host-name', /\b[A-Za-z0-9-]+\.local\b/g, '<host>'],
];

/** Redacts one text and adds per-category counts to `counts`. `names`: extra words (host and user names). */
export function sanitiseText(text, counts = {}, names = localNames()) {
  const bump = (cat) => { counts[cat] = (counts[cat] ?? 0) + 1; };
  let out = String(text);
  for (const [cat, re, rep] of REDACTIONS) out = out.replace(re, () => { bump(cat); return rep; });
  for (const n of names) out = out.replace(new RegExp(`\\b${esc(n)}\\b`, 'g'), () => { bump('host-or-user-name'); return '<name>'; });
  out = out.replace(IPV4, (m, ...g) => {
    if (isPublicIpv4(g.slice(0, 4)) !== false || /^(?:127|0)\./.test(m)) return m;
    bump('private-ip'); return '<private-ip>';
  });
  const marks = (s) => s.match(/<public-ip>/g)?.length ?? 0;
  const before = marks(out);
  out = redactPublicIps(out);
  for (let i = before; i < marks(out); i++) bump('public-ip');
  return out;
}

/** What must never be left after redaction: [category, pattern]. */
export const LEAKS = [
  ['secret', /sk-ant|\bsk-[A-Za-z0-9_-]{20,}|\bbmcp_|\bblcl_|\bla_[0-9a-f]{10,}|\bBearer\s+(?!<secret>)[A-Za-z0-9]/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['home-path', /\/Users\/|\/home\/|[A-Za-z]:\\+Users\\/],
  ['temp-path', /\/var\/folders\/|-private-var-folders-/],
  ['host-name', /\b[A-Za-z0-9-]+\.local\b/],
  ['private-ip', /(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/],
];

/** Every leak left in one text: [{ category, match }]. `extra`: more [category, RegExp] pairs; `names` as above. */
export function findLeaks(text, { extra = [], names = localNames() } = {}) {
  const hits = [];
  for (const [category, re] of [...LEAKS, ...extra, ...names.map((n) => ['host-or-user-name', new RegExp(`\\b${esc(n)}\\b`)])]) {
    const m = re.exec(text); if (m) hits.push({ category, match: m[0] });
  }
  if (redactPublicIps(text) !== text) hits.push({ category: 'public-ip', match: '(an address)' });
  return hits;
}

const jsonFiles = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => join(e.parentPath ?? e.path, e.name));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) { console.error('usage: node redact.mjs <run dir> [--check]'); process.exit(2); }
  const counts = {}; const leaks = [];
  for (const f of jsonFiles(dir)) {
    let text = readFileSync(f, 'utf8');
    if (flag !== '--check') { const next = sanitiseText(text, counts); if (next !== text) writeFileSync(f, next); text = next; }
    for (const h of findLeaks(text)) leaks.push(`${relative(dir, f).split(sep).join('/')}: ${h.category} (${h.match})`);
  }
  if (flag !== '--check') console.log(`redacted: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`);
  if (leaks.length) { console.error(`still there:\n${leaks.join('\n')}`); process.exit(1); }
  console.log('scan: clean (no keys or tokens, emails, home or temp paths, host or user names, IP addresses)');
}
