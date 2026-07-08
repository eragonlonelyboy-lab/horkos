'use strict';
// coverage.js - the fidelity check.
//
// HORKOS asks "did the write happen". It answered that correctly on 2026-07-08
// while an agent claimed six products had absorbed 145 source prompts. Every file
// existed. Every write was truthful. The lie was SEMANTIC: the artifacts did not
// contain what their sources demanded, and a tracker said ABSORBED anyway.
//
// A coverage claim is a factual claim about a file's CONTENTS. It is checkable.
// So HORKOS now refuses to let one stand without a passing coverage gate.
// Deterministic, zero-LLM: it shells out to the gate and reads the exit code.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Where the coverage gate lives. config wins; then a sibling checkout; then none.
function resolveGate(config) {
  const cfg = (config && config.coverage) || {};
  if (cfg.gate && fs.existsSync(cfg.gate)) return cfg.gate;
  // horkos sits at .../products/horkos; the gate at .../tools/coverage
  const sibling = path.join(__dirname, '..', '..', '..', 'tools', 'coverage', 'bin', 'coverage.js');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

// runner is injectable so the bench can drive it without spawning node.
function defaultRunner(gate) {
  try {
    const out = execFileSync(process.execPath, [gate, 'all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
}

// Called only when the transcript actually asserts coverage.
// `runner` and `resolver` are injectable so the bench can drive both branches
// without spawning node and without depending on whether a sibling checkout
// happens to exist. A test that cannot force the no-gate path passes vacuously.
function verifyCoverage(config, runner, resolver) {
  const cfg = (config && config.coverage) || {};
  if (cfg.enabled === false) {
    return { status: 'skip', detail: 'coverage check disabled in config' };
  }
  const gate = (resolver || resolveGate)(config);
  if (!gate) {
    // CHI-R108: a coverage claim without a passing gate is an opinion. An
    // unbacked claim fails; it does not pass by default because a tool is absent.
    return {
      status: 'fail',
      detail: 'You claimed coverage, but no coverage gate is installed or configured. A coverage claim without a passing gate is an opinion. Install the gate, or set coverage.enabled=false in ~/.horkos/config.json if you never make coverage claims.',
    };
  }
  const run = (runner || defaultRunner)(gate);
  if (run.code === 0) {
    return { status: 'pass', detail: `coverage gate passed (${path.basename(gate)})`, gate };
  }
  const tail = String(run.out || '').trim().split('\n').slice(-6).join('\n');
  return {
    status: 'fail',
    detail: `You claimed coverage, but the coverage gate FAILED. The artifact does not contain what its source demanded:\n${tail}`,
    gate,
  };
}

module.exports = { verifyCoverage, resolveGate, defaultRunner };
