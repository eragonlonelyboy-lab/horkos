#!/usr/bin/env node
'use strict';
// HORKOS Stop hook: the oath check. The session may only end when the artifact testifies.
// Bounded: after max_retries failed audits it allows exit WITH a human-handoff artifact.
const { stopDecision } = require('../lib/audit');

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (process.env.HORKOS_DISABLED === '1') process.exit(0);
  try {
    const result = await stopDecision(input.session_id, input.transcript_path);

    if (result.action === 'allow') {
      if (result.audit.summary.writes > 0) {
        console.log(JSON.stringify({ systemMessage: `HORKOS: oath kept: ${result.audit.summary.pass}/${result.audit.summary.writes} writes verified (${result.audit.summary.receipt_only} receipt-only). Receipts: ~/.horkos/sessions/${input.session_id}/audit.json` }));
      }
      process.exit(0);
    }
    if (result.action === 'handoff') {
      console.log(JSON.stringify({ systemMessage: `HORKOS: audit failed ${result.audit.summary.fail + result.audit.summary.phantom_claims} check(s) after max retries. HUMAN HANDOFF written: ${result.handoffPath}` }));
      process.exit(0); // bounded exit: never an unwinnable loop
    }
    // block: feed the exact gaps back so the redo is actionable, not vibes.
    const reason = [
      `HORKOS evidence audit FAILED (attempt ${result.attempt}/${result.maxRetries}). The artifact does not match your claims.`,
      ...result.gaps.slice(0, 8),
      `Fix the actual artifacts, then finish again. Do not re-describe the work: redo it. (Receipts: ~/.horkos/sessions/${input.session_id}/audit.json)`
    ].join('\n');
    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  } catch (e) {
    // An auditor crash must never trap the user: allow exit, say why honestly.
    console.log(JSON.stringify({ systemMessage: 'HORKOS: auditor error (allowed exit, honest failure): ' + e.message }));
    process.exit(0);
  }
});
