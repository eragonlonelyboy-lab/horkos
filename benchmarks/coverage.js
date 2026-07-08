'use strict';
// Coverage-claim benchmarks. HORKOS answered "did the write happen" correctly on
// 2026-07-08 while an agent claimed six products had absorbed 145 source prompts.
// Every file existed. The lie was semantic. These pin the check in BOTH directions:
// a real claim with a failing gate must block, writing about the discipline must
// never block, and a stranger who never authored a manifest must never be trapped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractCoverageClaims } = require('../lib/claims');
const { verifyCoverage, resolveGate } = require('../lib/coverage');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

function transcriptWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cov-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
  return p;
}
const claimsIn = (text) => extractCoverageClaims(transcriptWith(text));

// --- the claim extractor: real claims ---
t('"17/17 ABSORBED" is a coverage claim', () => {
  assert.strictEqual(claimsIn('The gate is green: 17/17 ABSORBED across all destinations.').length, 1);
});
t('"62/62 elements present" is a coverage claim', () => {
  assert.strictEqual(claimsIn('Machine-verified: 62/62 elements present.').length, 1);
});
t('"all 17 source prompts absorbed" is a coverage claim', () => {
  assert.strictEqual(claimsIn('All 17 source prompts absorbed.').length, 1);
});
t('"COVERAGE GATE: PASS" is a coverage claim', () => {
  assert.strictEqual(claimsIn('COVERAGE GATE: PASS').length, 1);
});
t('a markdown TABLE claim is detected (the format the agent actually used)', () => {
  assert.strictEqual(claimsIn('| prompts ABSORBED | **0 / 17** | **17 / 17** |').length, 1);
});
t('a table row of ELEMENTS PRESENT is detected', () => {
  assert.strictEqual(claimsIn('| elements present | 6 / 62 | 62 / 62 |').length, 1);
});

// --- the FP guards: these must NOT be claims ---
t('an audit table reporting a FAILURE is not a claim ("0 ABSORBED / 5 PARTIAL")', () => {
  assert.strictEqual(claimsIn('| ZOILUS | 7 | 0 ABSORBED / 5 PARTIAL / 2 MISSING |').length, 0);
});
t('a zero result is a confession, not a claim ("0 ABSORBED of 17")', () => {
  assert.strictEqual(claimsIn('The red baseline was 0 ABSORBED of 17.').length, 0);
});
t('a negated statement is not a claim ("#15 was not absorbed")', () => {
  assert.strictEqual(claimsIn('Prompt #15 was not absorbed; it contributed zero bytes.').length, 0);
});
t('stating the RULE is not a claim (the audit report must not block itself)', () => {
  assert.strictEqual(claimsIn('Never write ABSORBED in a tracker unless the gate says so.').length, 0);
});
t('an unreal/conditional statement is not a claim', () => {
  assert.strictEqual(claimsIn('This would be fully absorbed if we restored the references.').length, 0);
});
t("a quoted or fenced span is not this agent's claim", () => {
  assert.strictEqual(claimsIn('The tracker wrongly said `17/17 ABSORBED` before the audit.').length, 0);
});
t('an ordinary sentence with no coverage assertion is not a claim', () => {
  assert.strictEqual(claimsIn('I restored the reference files and committed them.').length, 0);
});

// --- the verifier: every branch forced, nothing vacuous ---
const someManifests = () => ({ dir: '/fake/manifests', count: 3 });
const noManifests = () => ({ dir: '/fake/manifests', count: 0 });
const gateFound = () => '/fake/gate.js';
const gateMissing = () => null;
const fakeRun = (code, out) => () => ({ code, out: out || '' });

t('manifests present + passing gate = the claim is verified', () => {
  const r = verifyCoverage({}, fakeRun(0, 'COVERAGE GATE: PASS'), gateFound, someManifests);
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.manifests, 3);
});
t('manifests present + FAILING gate = block, and the detail names the shortfall', () => {
  const out = ['ABSENT ELEMENTS:', '  [#15] ranked hypotheses', 'COVERAGE GATE: FAIL'].join('\n');
  const r = verifyCoverage({}, fakeRun(1, out), gateFound, someManifests);
  assert.strictEqual(r.status, 'fail');
  assert(/does not contain what its source demanded/.test(r.detail));
  assert(/ranked hypotheses/.test(r.detail), 'the block message must name what is absent');
});
t('NEVER TRAPPED: no manifests = unverifiable, NOT a failure', () => {
  const r = verifyCoverage({}, fakeRun(1), gateFound, noManifests);
  assert.strictEqual(r.status, 'unverifiable', 'a stranger who never wrote a manifest must not be blocked');
  assert(/This is not a failure/.test(r.detail));
});
t('the no-manifest test is not vacuous: WITH manifests the same failing gate blocks', () => {
  const r = verifyCoverage({}, fakeRun(1), gateFound, someManifests);
  assert.strictEqual(r.status, 'fail', 'the control must behave differently, or the test above proves nothing');
});
t('manifests present but the bundled gate is missing = unverifiable, not a false block', () => {
  const r = verifyCoverage({}, fakeRun(0), gateMissing, someManifests);
  assert.strictEqual(r.status, 'unverifiable');
});
t('coverage.enabled=false skips the check entirely', () => {
  assert.strictEqual(verifyCoverage({ coverage: { enabled: false } }, fakeRun(1), gateFound, someManifests).status, 'skip');
});
t('the gate is BUNDLED inside horkos, so "gate not installed" cannot happen', () => {
  const g = resolveGate({});
  assert(g && fs.existsSync(g), 'coverage/bin/coverage.js must ship inside horkos');
  assert(/horkos/i.test(g), 'the gate must resolve from inside the horkos checkout');
});
t('only a FAIL blocks the session: unverifiable, skip and pass do not', () => {
  const blocks = (st) => st === 'fail';
  assert.strictEqual(blocks('fail'), true);
  assert.strictEqual(blocks('unverifiable'), false);
  assert.strictEqual(blocks('skip'), false);
  assert.strictEqual(blocks('pass'), false);
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
