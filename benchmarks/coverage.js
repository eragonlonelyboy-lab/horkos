'use strict';
// Coverage-claim benchmarks. HORKOS answered "did the write happen" correctly on
// 2026-07-08 while an agent claimed six products had absorbed 145 source prompts.
// Every file existed. The lie was semantic. These pin the new check, in BOTH
// directions: a real claim without a passing gate must block, and merely writing
// about the discipline must never block.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractCoverageClaims } = require('../lib/claims');
const { verifyCoverage } = require('../lib/coverage');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

// Build a minimal transcript whose FINAL assistant message is `text`.
function transcriptWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cov-'));
  const p = path.join(dir, 'transcript.jsonl');
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  fs.writeFileSync(p, line + '\n');
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
  const row = '| prompts ABSORBED | **0 / 17** | **17 / 17** |';
  assert.strictEqual(claimsIn(row).length, 1, 'a table row asserting 17/17 is a coverage claim');
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
t('a quoted or fenced span is not this agent\'s claim', () => {
  assert.strictEqual(claimsIn('The tracker wrongly said `17/17 ABSORBED` before the audit.').length, 0);
});
t('an ordinary sentence with no coverage assertion is not a claim', () => {
  assert.strictEqual(claimsIn('I restored the reference files and committed them.').length, 0);
});

// --- the verifier (runner injected, no spawning) ---
const gateCfg = (gate) => ({ coverage: { gate } });
function fakeGate(exitCode, out) { return () => ({ code: exitCode, out: out || '' }); }

t('a passing gate verifies the claim', () => {
  const tmp = path.join(os.tmpdir(), 'fake-gate.js'); fs.writeFileSync(tmp, '');
  const r = verifyCoverage(gateCfg(tmp), fakeGate(0, 'COVERAGE GATE: PASS'));
  assert.strictEqual(r.status, 'pass');
});
t('a FAILING gate fails the claim, and the detail names the shortfall', () => {
  const tmp = path.join(os.tmpdir(), 'fake-gate.js'); fs.writeFileSync(tmp, '');
  const r = verifyCoverage(gateCfg(tmp), fakeGate(1, 'ABSENT ELEMENTS:\n  [#15] ranked hypotheses\nCOVERAGE GATE: FAIL'));
  assert.strictEqual(r.status, 'fail');
  assert(/does not contain what its source demanded/.test(r.detail));
  assert(/ranked hypotheses/.test(r.detail), 'the block message must name what is absent');
});
t('a coverage claim with NO gate installed FAILS: an unbacked claim is an opinion', () => {
  // Force the no-gate branch by injecting a resolver. Without this the sibling
  // checkout resolves and the test would pass vacuously, proving nothing.
  const noGate = () => null;
  const r = verifyCoverage({}, fakeGate(0), noGate);
  assert.strictEqual(r.status, 'fail', 'an unbacked coverage claim must fail, not pass because a tool is absent');
  assert(/without a passing gate is an opinion/.test(r.detail));
});
t('the no-gate test is not vacuous: with a gate present the same call passes', () => {
  const tmp = path.join(os.tmpdir(), 'fake-gate.js'); fs.writeFileSync(tmp, '');
  const r = verifyCoverage({}, fakeGate(0), () => tmp);
  assert.strictEqual(r.status, 'pass', 'the control must behave differently, or the test above proves nothing');
});
t('coverage.enabled=false skips the check (never trapped)', () => {
  const r = verifyCoverage({ coverage: { enabled: false } }, fakeGate(1));
  assert.strictEqual(r.status, 'skip');
});
t('the real sibling gate resolves from the horkos checkout', () => {
  const { resolveGate } = require('../lib/coverage');
  const g = resolveGate({});
  assert(g && fs.existsSync(g), 'the coverage gate should be discoverable at ../../tools/coverage');
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
