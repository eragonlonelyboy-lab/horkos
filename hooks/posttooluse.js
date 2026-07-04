#!/usr/bin/env node
'use strict';
// HORKOS PostToolUse hook: record external writes + receipts to the session ledger.
// Fast path: non-write tools exit immediately. Never blocks, never throws.
const { recordFromHook } = require('../lib/ledger');
const { loadClassifier } = require('../lib/config');

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (process.env.HORKOS_DISABLED === '1') process.exit(0);
    recordFromHook(input, loadClassifier().scope_thresholds || { small_max_chars: 2000, sections_max_chars: 8000 });
  } catch { /* a ledger failure must never break the user's session */ }
  process.exit(0);
});
