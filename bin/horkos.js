#!/usr/bin/env node
'use strict';
// HORKOS CLI: install/uninstall hooks, status, headless audit for CI and claude -p fleets.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { HOME, readJSON, writeJSON, statsPath, loadConfig } = require('../lib/config');
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

// Reconciliation: a truthful write whose artifact was later legitimately deleted or
// moved OUT OF BAND (another session, a file manager, a delete/move the lifecycle
// rows predate) fails the audit forever with no honest redo. `resolve` closes that
// gap WITHOUT weakening the oath: it verifies the CURRENT ground truth itself,
// refuses anything it cannot prove, and appends an append-only reconciliation row
// (never edits the ledger). It cannot manufacture a write that never happened: the
// path must have a ledgered ok-receipt write, and a still-existing file is refused
// outright (the audit judges those directly).
async function resolveCmd(args) {
  const sessionId = val(args, '--session');
  const target = val(args, '--path');
  const movedTo = val(args, '--moved-to');
  const reason = val(args, '--reason');
  if (!sessionId || !target || !reason || !reason.trim()) {
    console.error('usage: horkos resolve --session <id> --path <path> --reason "<why the artifact legitimately moved or went away>" [--moved-to <newpath>]');
    process.exit(2);
  }
  const { readLedger } = require('../lib/ledger');
  const { appendJSONL, ledgerPath } = require('../lib/config');
  const norm = s => String(s).replace(/\\/g, '/').toLowerCase();
  const nt = norm(target);
  const ledger = readLedger(sessionId);
  const writes = ledger.filter(e => !e.lifecycle && e.system === 'fs' && e.target && norm(e.target) === nt);
  const refuse = (msg) => { console.error('REFUSED: ' + msg); process.exit(1); };
  if (!writes.length) refuse(`no ledgered write to this path in session ${sessionId}: resolve cannot manufacture a write that never happened.`);
  if (!writes.some(e => e.receipt && e.receipt.ok)) refuse('the ledgered write(s) to this path did not succeed: resolve only reconciles truthful writes.');

  let evidence;
  if (movedTo) {
    let p = movedTo;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const inside = path.join(p, path.basename(target));
      if (fs.existsSync(inside)) p = inside;
    }
    if (!fs.existsSync(p)) refuse(`destination does not exist: ${p}. A move claim needs a live destination.`);
    const last = writes[writes.length - 1];
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      evidence = `destination directory exists: ${p}`;
    } else {
      const clean = s => String(s).replace(/\r\n/g, '\n');
      const probe = clean(last.sent_head || '').slice(0, 120).trim();
      const content = clean(fs.readFileSync(p, 'utf8'));
      if (probe && content.includes(probe)) evidence = `destination exists and contains the head of what was written: ${p}`;
      else if (!probe) evidence = `destination exists (${stat.size} bytes; no head recorded to probe): ${p}`;
      else if (Number.isFinite(Date.parse(last.ts)) && stat.mtimeMs > Date.parse(last.ts) + 2000) evidence = `destination exists, modified after the recorded write (content unverified): ${p}`;
      else refuse(`destination ${p} does not contain the head of what was written and was not modified since. That is not this write's artifact.`);
    }
  } else {
    if (fs.existsSync(target)) refuse('the file exists: the audit judges it directly; there is nothing to reconcile.');
    evidence = 'file absent at resolve time; the ledgered write carried an ok receipt (it truly ran)';
  }

  const row = { ts: new Date().toISOString(), tool: 'horkos-resolve', system: 'fs', op: 'resolve', target, moved_to: movedTo || null, reason: reason.trim(), evidence, lifecycle: true, receipt: { ok: true } };
  appendJSONL(ledgerPath(sessionId), row);
  console.log('RECONCILED (append-only row added; the ledger is never edited):');
  console.log(`  path     : ${target}`);
  if (movedTo) console.log(`  moved to : ${movedTo}`);
  console.log(`  reason   : ${row.reason}`);
  console.log(`  evidence : ${evidence}`);
  console.log('The next audit reports this entry as reconciled, citing this row. Receipts keep the full trail.');
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

function delegationCmd(args) {
  const file = val(args, '--file');
  if (!file || !fs.existsSync(file)) {
    console.error('usage: horkos delegation --file <work-unit.json>');
    process.exit(2);
  }
  const input = readJSON(path.resolve(file), null);
  if (!input) { console.error('invalid delegation JSON: ' + file); process.exit(2); }
  const result = require('../lib/delegation').auditDelegation(input);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

// Guided setup: state-aware, explains every step in plain language, safe to re-run.
// Zero-config is the default path; every optional step says what it adds and what you lose without it.
function setup() {
  const ok = m => console.log('  [done] ' + m);
  const todo = m => console.log('  [next] ' + m);
  const info = m => console.log('         ' + m);
  console.log('HORKOS guided setup (re-run this any time; it only reads, never changes)\n');

  // Step 1: hooks
  const s = readJSON(SETTINGS, {});
  const hooked = ['PostToolUse', 'Stop'].every(ev => (s.hooks && s.hooks[ev] || []).some(g => (g.hooks || []).some(h => String(h.command || '').includes(MARK))));
  console.log('Step 1 of 3: the hooks (required, one command, automatic forever after)');
  if (hooked) ok('Registered. Every session now records writes and audits claims at exit, by itself.');
  else {
    todo('Run: horkos install');
    info('What it does: adds two entries to ~/.claude/settings.json. One records every external');
    info('write your agent makes (with its receipt). One checks the evidence when the agent says');
    info('"done". Both run automatically in every future session. Nothing to start manually.');
  }

  // Step 2: first evidence
  const sess = fs.existsSync(path.join(HOME, 'sessions')) ? fs.readdirSync(path.join(HOME, 'sessions')).length : 0;
  console.log('\nStep 2 of 3: first evidence (nothing to do, just work)');
  if (sess > 0) ok(`${sess} session(s) recorded. HORKOS is watching.`);
  else info('Work one normal session after installing. HORKOS records by itself; check back with horkos status.');

  // Step 3: optional deep audit
  console.log('\nStep 3 of 3: deep audit credentials (OPTIONAL: skip freely)');
  info('Out of the box HORKOS already verifies files and git, and catches phantom claims and');
  info('silent failures everywhere. Credentials add one thing: re-fetching what your agent wrote');
  info('in external systems to prove the content actually landed.');
  const cfg = loadConfig().systems || {};
  const sys = [
    ['confluence', 'you write Confluence pages', 'your Atlassian email + an API token (id.atlassian.com > Security > API tokens)'],
    ['jira', 'you write Jira issues', 'same Atlassian email + API token as Confluence'],
    ['testrail', 'you write TestRail cases', 'your TestRail user + API key (TestRail > My Settings > API Keys)']
  ];
  for (const [k, when, need] of sys) {
    const c = cfg[k] || {};
    const filled = c.baseUrl && (c.apiToken || c.apiKey);
    if (filled) ok(`${k}: configured. Writes there get probe + re-fetch verification.`);
    else info(`${k}: not set. Add it only if ${when}. Needs: ${need}. File: ~/.horkos/config.json`);
  }
  console.log('\nPrefer a guided conversation? Open your agent in this repo and say: "set up HORKOS for me".');
  console.log(hooked ? '\nSetup state: READY. The oath-keeper is on duty.' : '\nSetup state: one command away (horkos install).');
}

const [cmd, ...args] = process.argv.slice(2);
({ install, uninstall, status, setup, audit: () => audit(args), resolve: () => resolveCmd(args), delegation: () => delegationCmd(args) }[cmd] || (() => {
  console.log('horkos <setup|install|uninstall|status|audit|resolve|delegation>');
  console.log('  setup      guided, state-aware walkthrough: explains every step, safe to re-run');
  console.log('  install    register PostToolUse ledger + Stop audit hooks in ~/.claude/settings.json');
  console.log('  status     caught / verified / handoff counters + last audit');
  console.log('  audit      headless audit: --session <id> [--transcript <path>] [--receipts out.jsonl]');
  console.log('  resolve    reconcile a truthful write whose file was legitimately moved/deleted out of band:');
  console.log('             --session <id> --path <p> --reason "<why>" [--moved-to <newpath>] (evidence-gated, append-only)');
  console.log('  delegation audit a work-unit authority/review contract: --file <work-unit.json>');
}))();
