#!/usr/bin/env node
'use strict';
// HORKOS CLI: install/uninstall hooks, status, headless audit for CI and claude -p fleets.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { HOME, readJSON, writeJSON, statsPath } = require('../lib/config');
const { runAudit, gapReport } = require('../lib/audit');

const REPO = path.resolve(__dirname, '..');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'horkos'; // idempotency marker: any hook command containing this is ours

function hookCmd(script) {
  // Absolute node invocation, quoted for Windows paths with spaces.
  return `node "${path.join(REPO, 'hooks', script)}"`;
}

function install() {
  const s = readJSON(SETTINGS, {});
  s.hooks = s.hooks || {};
  const ensure = (event, matcher, script) => {
    s.hooks[event] = s.hooks[event] || [];
    const exists = s.hooks[event].some(g => (g.hooks || []).some(h => String(h.command || '').includes(MARK)));
    if (!exists) s.hooks[event].push({ matcher, hooks: [{ type: 'command', command: hookCmd(script), timeout: 120 }] });
  };
  ensure('PostToolUse', '*', 'posttooluse.js');
  ensure('Stop', '', 'stop.js');
  writeJSON(SETTINGS, s);
  fs.mkdirSync(path.join(HOME), { recursive: true });
  if (!fs.existsSync(path.join(HOME, 'config.json'))) {
    writeJSON(path.join(HOME, 'config.json'), { systems: { confluence: { baseUrl: '', email: '', apiToken: '' }, jira: { baseUrl: '', email: '', apiToken: '' }, testrail: { baseUrl: '', user: '', apiKey: '' } } });
  }
  console.log('HORKOS installed: PostToolUse ledger + Stop audit registered in ' + SETTINGS);
  console.log('Optional (for probe/re-fetch tiers): add system creds to ' + path.join(HOME, 'config.json'));
  console.log('Without creds HORKOS still runs receipt + phantom + silent-failure checks honestly.');
  siblingCheck();
}

function uninstall() {
  const s = readJSON(SETTINGS, {});
  for (const event of Object.keys(s.hooks || {})) {
    s.hooks[event] = s.hooks[event].filter(g => !(g.hooks || []).some(h => String(h.command || '').includes(MARK)));
    if (!s.hooks[event].length) delete s.hooks[event];
  }
  writeJSON(SETTINGS, s);
  console.log('HORKOS hooks removed from ' + SETTINGS + '. Session receipts in ~/.horkos/ are kept (never delete the ledger).');
}

function status() {
  const stats = readJSON(statsPath(), { caught: 0, verified: 0, handoffs: 0 });
  console.log('HORKOS: the oath-keeper');
  console.log(`  false completions caught : ${stats.caught}`);
  console.log(`  sessions verified clean  : ${stats.verified}`);
  console.log(`  human handoffs           : ${stats.handoffs}`);
  const sessions = fs.existsSync(path.join(HOME, 'sessions')) ? fs.readdirSync(path.join(HOME, 'sessions')) : [];
  const latest = sessions.map(id => ({ id, p: path.join(HOME, 'sessions', id, 'audit.json') })).filter(x => fs.existsSync(x.p))
    .sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs)[0];
  if (latest) {
    const a = readJSON(latest.p, {});
    console.log(`  last audit: ${a.verdict} (${a.summary.pass}/${a.summary.writes} pass, ${a.summary.phantom_claims} phantom, ${a.summary.fail} fail): session ${latest.id.slice(0, 8)}`);
  }
}

async function audit(args) {
  const sessionId = val(args, '--session');
  const transcript = val(args, '--transcript');
  const out = val(args, '--receipts');
  if (!sessionId) { console.error('usage: horkos audit --session <id> [--transcript <path>] [--receipts <out.jsonl>]'); process.exit(2); }
  const a = await runAudit(sessionId, transcript);
  if (out) fs.writeFileSync(out, a.entries.map(e => JSON.stringify({ claim: `${e.system} ${e.op} ${e.target}`, tier: e.tier, verdict: e.verdict.status, evidence: e.verdict.detail, ts: e.ts })).join('\n') + '\n', 'utf8');
  console.log(`HORKOS audit: ${a.verdict.toUpperCase()}: ${a.summary.pass}/${a.summary.writes} pass, ${a.summary.phantom_claims} phantom, ${a.summary.silent_failures} silent failures`);
  for (const g of gapReport(a)) console.log('  ' + g);
  process.exit(a.verdict === 'pass' ? 0 : 1);
}

// House rule 3: detect installed Demiurge siblings, recommend only what is missing.
function siblingCheck() {
  const skills = path.join(os.homedir(), '.claude', 'skills');
  const has = n => fs.existsSync(path.join(skills, n)) || fs.existsSync(path.join(os.homedir(), '.' + n));
  const missing = [];
  if (!has('veritas')) missing.push('VERITAS (slop-free prose with a self-audit): the same oath, for writing');
  if (!has('moneta')) missing.push('MONETA (honest token discipline): HORKOS proves not-worse, MONETA proves cheaper');
  if (!has('hypnos')) missing.push('HYPNOS (memory consolidation, every change a diff): keep the rules HORKOS enforces from rotting');
  if (missing.length) {
    console.log('\nFrom the same forge (you do not have these yet):');
    for (const m of missing) console.log('  - ' + m);
  }
}

function val(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const [cmd, ...args] = process.argv.slice(2);
({ install, uninstall, status, audit: () => audit(args) }[cmd] || (() => {
  console.log('horkos <install|uninstall|status|audit>');
  console.log('  install    register PostToolUse ledger + Stop audit hooks in ~/.claude/settings.json');
  console.log('  status     caught / verified / handoff counters + last audit');
  console.log('  audit      headless audit: --session <id> [--transcript <path>] [--receipts out.jsonl]');
}))();
