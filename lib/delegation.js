'use strict';

function auditDelegation(input = {}) {
  const findings = [];
  const risk = input.risk || 'standard';
  const authority = input.authority || 'scoped-write';
  const writeCapable = authority !== 'read-only';
  const add = (id, detail) => findings.push({ id, detail, blocking: true });

  if (input.resumeMode === 'last' || input.resumeMode === 'implicit' || (input.resuming && !input.sessionId)) add('implicit-session-resume', 'Concurrent work requires an explicit stable session id.');
  if (writeCapable && input.cleanTree !== true) add('dirty-or-unverified-tree', 'Write-capable delegation requires a verified clean tree or an isolated disposable worktree.');
  if (['standard', 'high-stakes'].includes(risk) && !String(input.proofCommand || '').trim()) add('missing-proof-command', 'Standard and high-stakes work requires an exact proof command.');
  if (risk === 'high-stakes') {
    if (!input.reviewer || !input.implementor) add('missing-independent-reviewer', 'High-stakes work records implementor and reviewer identities.');
    else if (sameIdentity(input.implementor, input.reviewer)) add('self-review-only', 'The high-stakes implementor cannot be the sole reviewer.');
  }
  if (authority === 'isolated-full-write' && !(input.isolated === true && input.authorized === true)) add('uncontained-full-write', 'Full write authority requires isolation and explicit authorization.');
  return { ok: findings.length === 0, findings, risk, authority };
}

function sameIdentity(a, b) {
  const key = v => [v.provider, v.model, v.sessionId].map(x => String(x || '').toLowerCase()).join('|');
  return key(a) === key(b);
}

module.exports = { auditDelegation, sameIdentity };
