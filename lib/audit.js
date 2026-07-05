'use strict';
// HORKOS audit engine: ledger -> classify -> verify via adapter -> verdict.
// Deterministic end to end. The agent's story is not an input; the artifact is.
const { loadConfig, loadClassifier, readJSON, writeJSON, auditPath, statePath, handoffPath, statsPath } = require('./config');
const { readLedger } = require('./ledger');
const { extractClaims, findPhantoms } = require('./claims');
const { classify, factsFromEntry } = require('./classifier');

const ADAPTERS = {
  fs: require('./adapters/fsgit'),
  git: require('./adapters/fsgit'),
  confluence: require('./adapters/confluence'),
  jira: require('./adapters/jira'),
  testrail: require('./adapters/testrail')
};

async function runAudit(sessionId, transcriptPath) {
  const config = loadConfig();
  const table = loadClassifier();
  const ledger = readLedger(sessionId);
  const claims = transcriptPath ? extractClaims(transcriptPath) : [];
  const phantoms = findPhantoms(claims, ledger);

  const results = [];
  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i];
    // Writes whose response was an error and were never followed by a successful retry
    // to the same target are audited hardest.
    const { tier, why } = classify(factsFromEntry(entry), table);
    const adapter = ADAPTERS[entry.system];
    // A later successful ledgered write of the same op to the same target supersedes
    // this entry's content claim: the final artifact is audited on the latest entry.
    // Same precedent as the silent-failure retry check below. Without this, any
    // session that legitimately revises its own file can never pass (false positive
    // found in production dogfood, 2026-07-05: CALLIOPE build, brief_back.md).
    const superseded = entry.receipt && entry.receipt.ok &&
      ledger.slice(i + 1).some(later => later.system === entry.system &&
        String(later.target) === String(entry.target) && later.op === entry.op &&
        later.receipt && later.receipt.ok);
    let verdict;
    if (!adapter) verdict = { status: 'unverifiable', detail: `no adapter for system "${entry.system}"` };
    else if (superseded) verdict = { status: 'pass', detail: 'superseded by a later ledgered write to the same target; content audited on the latest entry' };
    else verdict = await adapter.verify(entry, tier, config);
    results.push({ ...entry, tier, tier_why: why, verdict });
  }

  // Error-writes with no later successful write to the same target = silent failures.
  const silentFailures = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.receipt && r.receipt.error) {
      const retried = results.slice(i + 1).some(later => later.system === r.system && String(later.target) === String(r.target) && later.receipt && later.receipt.ok);
      if (!retried && r.verdict.status !== 'pass') silentFailures.push(r);
    }
  }

  const fails = results.filter(r => r.verdict.status === 'fail');
  const summary = {
    writes: results.length,
    pass: results.filter(r => r.verdict.status === 'pass').length,
    fail: fails.length,
    receipt_only: results.filter(r => r.verdict.status === 'receipt-only').length,
    unverifiable: results.filter(r => r.verdict.status === 'unverifiable').length,
    phantom_claims: phantoms.length,
    silent_failures: silentFailures.length
  };
  const verdict = (fails.length || phantoms.length || silentFailures.length) ? 'fail' : 'pass';
  const audit = { ts: new Date().toISOString(), sessionId, verdict, summary, phantoms, silent_failures: silentFailures.map(s => ({ system: s.system, target: s.target, error: s.receipt.error })), entries: results };
  writeJSON(auditPath(sessionId), audit);
  return audit;
}

function gapReport(audit) {
  const lines = [];
  for (const p of audit.phantoms) lines.push(`PHANTOM CLAIM: you said "${p.claim}" but the ledger shows ZERO writes to ${p.systems.join('/')}. The write never happened. Do it for real.`);
  for (const s of audit.silent_failures) lines.push(`SILENT FAILURE: the write to ${s.system} (${s.target}) returned an error (${s.error}) and was never retried. Redo the write.`);
  for (const e of audit.entries) {
    if (e.verdict.status === 'fail') lines.push(`EVIDENCE FAIL [Tier ${e.tier}] ${e.system} ${e.op} ${e.target || ''}: ${e.verdict.detail}`);
  }
  return lines;
}

function bumpStats(field) {
  const s = readJSON(statsPath(), { caught: 0, verified: 0, handoffs: 0 });
  s[field] = (s[field] || 0) + 1;
  writeJSON(statsPath(), s);
  return s;
}

function writeHandoff(sessionId, audit, attempts) {
  const gaps = gapReport(audit);
  const md = [
    `# HORKOS HANDOFF: human decision required`,
    ``,
    `Session \`${sessionId}\` hit the bounded-retry limit (${attempts} audit failures). HORKOS does not claim`,
    `unconditional termination: this is the explicit human handoff.`,
    ``,
    `## What the agent claimed`,
    ...(audit.phantoms.length ? audit.phantoms.map(p => `- "${p.claim}"`) : ['- (see transcript final messages)']),
    ``,
    `## What the evidence shows`,
    ...gaps.map(g => `- ${g}`),
    ``,
    `## What remains`,
    `- ${audit.summary.fail} failed verification(s), ${audit.summary.phantom_claims} phantom claim(s), ${audit.summary.silent_failures} silent failure(s)`,
    ``,
    `## Suggested next action`,
    `- Inspect the targets above directly, then either redo the writes yourself or re-run the agent with this file as context.`,
    ``,
    `Receipts: \`~/.horkos/sessions/${sessionId}/audit.json\``
  ].join('\n');
  require('fs').writeFileSync(handoffPath(sessionId), md, 'utf8');
  return handoffPath(sessionId);
}

// Stop-hook entry: decide block / allow / handoff. Bounded, never unwinnable.
async function stopDecision(sessionId, transcriptPath) {
  const state = readJSON(statePath(sessionId), { attempts: 0 });
  const maxRetries = loadClassifier().max_retries || 3;
  const audit = await runAudit(sessionId, transcriptPath);

  if (audit.verdict === 'pass') {
    state.attempts = 0; writeJSON(statePath(sessionId), state);
    if (audit.summary.writes > 0) bumpStats('verified');
    return { action: 'allow', audit };
  }
  state.attempts += 1; writeJSON(statePath(sessionId), state);

  if (state.attempts >= maxRetries) {
    const p = writeHandoff(sessionId, audit, state.attempts);
    bumpStats('handoffs');
    return { action: 'handoff', audit, handoffPath: p };
  }
  bumpStats('caught');
  return { action: 'block', audit, attempt: state.attempts, maxRetries, gaps: gapReport(audit) };
}

module.exports = { runAudit, stopDecision, gapReport };
