'use strict';
// coverage.js - the fidelity check.
//
// HORKOS asks "did the write happen". It answered that correctly on 2026-07-08
// while an agent claimed six products had absorbed 145 source prompts. Every file
// existed. Every write was truthful. The lie was SEMANTIC: the artifacts did not
// contain what their sources demanded, and a tracker said ABSORBED anyway.
//
// A coverage claim is a factual claim about a file's CONTENTS. It is checkable.
// So HORKOS refuses to let one stand without a passing coverage gate. The gate is
// BUNDLED (coverage/), so "gate not installed" can never happen. Zero-LLM: it
// shells out to a deterministic grep-based checker and reads the exit code.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = path.join(os.homedir(), '.horkos');

// The gate ships inside HORKOS. Config may override for a checkout elsewhere.
function resolveGate(config) {
  const cfg = (config && config.coverage) || {};
  if (cfg.gate && fs.existsSync(cfg.gate)) return cfg.gate;
  const bundled = path.join(__dirname, '..', 'coverage', 'bin', 'coverage.js');
  return fs.existsSync(bundled) ? bundled : null;
}

// A manifest says: "this source demanded these named elements." They belong to the
// USER, not to HORKOS, so they live in ~/.horkos/manifests, never in the repo.
function resolveManifests(config) {
  const cfg = (config && config.coverage) || {};
  const dir = cfg.manifests || path.join(HOME, 'manifests');
  if (!fs.existsSync(dir)) return { dir, count: 0 };
  const count = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  return { dir, count };
}

function defaultRunner(gate, dir) {
  try {
    const out = execFileSync(process.execPath, [gate, 'all', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
}

// Called only when the transcript actually asserts coverage.
// `runner`, `gateResolver` and `manifestResolver` are injectable so the bench can
// drive every branch. A test that cannot force a branch passes vacuously.
function verifyCoverage(config, runner, gateResolver, manifestResolver) {
  const cfg = (config && config.coverage) || {};
  if (cfg.enabled === false) {
    return { status: 'skip', detail: 'coverage check disabled in config' };
  }

  const { dir, count } = (manifestResolver || resolveManifests)(config);
  if (count === 0) {
    // NEVER TRAPPED. A stranger who writes "fully absorbed" in a summary, and has
    // never authored a manifest, must not have their session blocked for a check
    // they never opted into. HORKOS reports the claim as unverified and moves on.
    // Strictness is opt-in: author a manifest and the claim becomes enforceable.
    return {
      status: 'unverifiable',
      detail: `You made a coverage claim, but there are no manifests in ${dir}, so it cannot be checked. This is not a failure. To make coverage claims enforceable, write a manifest naming the elements your source demanded. See coverage/README.md.`,
    };
  }

  const gate = (gateResolver || resolveGate)(config);
  if (!gate) {
    return { status: 'unverifiable', detail: 'coverage manifests exist but the bundled gate is missing from this HORKOS install' };
  }

  const run = (runner || defaultRunner)(gate, dir);
  if (run.code === 0) {
    return { status: 'pass', detail: `coverage gate passed over ${count} manifest(s)`, gate, manifests: count };
  }
  const tail = String(run.out || '').trim().split('\n').slice(-8).join('\n');
  return {
    status: 'fail',
    detail: `You claimed coverage, but the coverage gate FAILED. The artifact does not contain what its source demanded:\n${tail}`,
    gate,
    manifests: count,
  };
}

module.exports = { verifyCoverage, resolveGate, resolveManifests, defaultRunner };
