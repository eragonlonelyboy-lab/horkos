'use strict';
// HORKOS deterministic tier classifier. Mechanical inputs only; agent confidence is not an input.
const { loadClassifier } = require('./config');

function matches(when, facts) {
  return Object.entries(when).every(([k, v]) => facts[k] === v);
}

// facts: {op, novelty, scope, system, conflict}
function classify(facts, table) {
  const t = table || loadClassifier();
  let tier = null;
  let why = '';
  for (const rule of t.critical_overrides || []) {
    if (matches(rule.when, facts)) { tier = rule.tier; why = 'critical override: ' + (rule.why || ''); break; }
  }
  if (tier === null) {
    for (const rule of t.base_rules || []) {
      if (matches(rule.when, facts)) { tier = rule.tier; why = rule.why || 'base rule'; break; }
    }
  }
  if (tier === null) { tier = 2; why = 'fallback default'; }
  let escalated = false;
  for (const rule of t.escalators || []) {
    if (matches(rule.when, facts)) { tier = Math.min(3, tier + (rule.bump || 1)); escalated = true; why += ' + escalated: ' + (rule.why || ''); }
  }
  return { tier, why, escalated };
}

function factsFromEntry(entry) {
  return {
    op: entry.op === 'create-or-overwrite' ? 'edit' : entry.op,
    novelty: entry.novelty,
    scope: entry.scope,
    system: entry.system,
    conflict: !!entry.conflict
  };
}

module.exports = { classify, factsFromEntry };
