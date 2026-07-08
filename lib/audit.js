'use strict';
// HORKOS audit engine: ledger -> classify -> verify via adapter -> verdict.
// Deterministic end to end. The agent's story is not an input; the artifact is.
const { loadConfig, loadClassifier, readJSON, writeJSON, auditPath, statePath, handoffPath, statsPath } = require('./config');
const { readLedger } = require('./ledger');
const { extractClaims, findPhantoms, deletionCommands, recursivelyDeletedDirs, underDeletedDir, deletedExactPaths, deletedExactly, extractCoverageClaims } = require('./claims');
const { verifyCoverage } = require('./coverage');
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
  // Deletion commands from the transcript: a write whose file is gone but which was
  // explicitly deleted (rm/Remove-Item naming that exact path) is a truthful write
  // that was cleaned up, not an evidence fail. Normalized to match the ledger target.
  const delCmds = transcriptPath ? deletionCommands(transcriptPath) : [];
  const deletedDirs = transcriptPath ? recursivelyDeletedDirs(transcriptPath) : [];
  const deletedPaths = transcriptPath ? deletedExactPaths(transcriptPath) : [];

  const results = [];
  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i];
    // Writes whose response was an error and were never followed by a successful retry
    // to the same target are audited hardest.
    const { tier, why } = classify(factsFromEntry(entry), table);
    const adapter = ADAPTERS[entry.system];
    // A later successful ledgered write to the same target supersedes this entry's
    // content claim: the final artifact is audited on the latest entry, regardless
    // of op (a Write revised by an Edit is the same artifact, op-equality here
    // false-positived the Write's head probe, dogfood session 0ae7e740, 2026-07-05).
    // Same precedent as the silent-failure retry check below. Without this, any
    // session that legitimately revises its own file can never pass (false positive
    // found in production dogfood, 2026-07-05: CALLIOPE build, brief_back.md).
    // Null targets never match: two unrelated id-less writes are not the same artifact.
    // The EARLIER entry's receipt state is irrelevant to supersession: a write whose
    // receipt was misparsed as an error (pre-fix ledger entries, dogfood 0ae7e740)
    // is still replaced by a later write to the same target. For fs, ANY later write
    // supersedes (disk is ground truth and the latest entry gets the content probe);
    // for remote systems the later write must itself carry an ok receipt.
    const superseded = entry.target != null &&
      ledger.slice(i + 1).some(later => later.system === entry.system &&
        String(later.target) === String(entry.target) &&
        (entry.system === 'fs' || (later.receipt && later.receipt.ok)));
    // A later intentional delete of the same path (rm in the transcript) means the
    // write truthfully landed and was then cleaned up: not a phantom, not an evidence
    // fail. Two shapes count: the delete command names the exact path, OR a recursive
    // delete removed an ancestor directory of it (FP class 12). Both still require the
    // write's own receipt to be ok, which fsgit.js enforces.
    const nt = entry.target ? String(entry.target).replace(/\\/g, '/').toLowerCase() : null;
    const intentionallyDeleted = nt != null &&
      (deletedExactly(deletedPaths, nt) || underDeletedDir(deletedDirs, nt));
    let verdict;
    if (!adapter) verdict = { status: 'unverifiable', detail: `no adapter for system "${entry.system}"` };
    else if (superseded) verdict = { status: 'pass', detail: 'superseded by a later ledgered write to the same target; content audited on the latest entry' };
    else verdict = await adapter.verify(entry, tier, config, { intentionallyDeleted });
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

  // Coverage claims: a claim about what an artifact CONTAINS, not that a write
  // landed. HORKOS answered "did the write happen" correctly on 2026-07-08 while
  // an agent claimed six products had absorbed 145 source prompts and none had.
  // Every file existed. The lie was semantic. A coverage claim is checkable, so
  // it does not stand without a passing gate (CHI-R108). Only runs when claimed.
  const coverageClaims = transcriptPath ? extractCoverageClaims(transcriptPath) : [];
  const coverage = coverageClaims.length
    ? { ...verifyCoverage(config), claims: coverageClaims.map(c => c.text) }
    : { status: 'none', detail: 'no coverage claim made' };
  summary.coverage_claims = coverageClaims.length;
  summary.coverage = coverage.status;

  const verdict = (fails.length || phantoms.length || silentFailures.length || coverage.status === 'fail') ? 'fail' : 'pass';
  const audit = { ts: new Date().toISOString(), sessionId, verdict, summary, phantoms, coverage, silent_failures: silentFailures.map(s => ({ system: s.system, target: s.target, error: s.receipt.error })), entries: results };
  writeJSON(auditPath(sessionId), audit);
  return audit;
}

function gapReport(audit) {
  const lines = [];
  for (const p of audit.phantoms) lines.push(`PHANTOM CLAIM: you said "${p.claim}" but the ledger shows ZERO writes to ${p.systems.join('/')}. The write never happened. Do it for real.`);
  if (audit.coverage && audit.coverage.status === 'fail') lines.push(`COVERAGE FAIL: ${audit.coverage.detail}`);
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
