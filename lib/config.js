'use strict';
// HORKOS shared config + state paths. Zero deps, Node >= 18, Windows-first.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HORKOS_HOME || path.join(os.homedir(), '.horkos');
const REPO_ROOT = path.join(__dirname, '..');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } // strip UTF-8 BOM (Windows PowerShell writes it)
  catch { return fallback; }
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function appendJSONL(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function readJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// User config: ~/.horkos/config.json
// { "systems": { "confluence": {"baseUrl","email","apiToken"}, "jira": {...same auth...},
//   "testrail": {"baseUrl","user","apiKey"}, "github": {"token"} }, "maxRetries": 3 }
function loadConfig() {
  const cfg = readJSON(path.join(HOME, 'config.json'), {});
  cfg.systems = cfg.systems || {};
  return cfg;
}

// Classifier: user override wins, else the shipped table.
function loadClassifier() {
  return readJSON(path.join(HOME, 'classifier.json'), null) ||
         readJSON(path.join(REPO_ROOT, 'classifier.json'), null) ||
         { critical_overrides: [], escalators: [], base_rules: [{ when: {}, tier: 2 }], scope_thresholds: { small_max_chars: 2000, sections_max_chars: 8000 }, max_retries: 3 };
}

function sessionDir(sessionId) { return ensureDir(path.join(HOME, 'sessions', sessionId || 'unknown')); }
function ledgerPath(sessionId) { return path.join(sessionDir(sessionId), 'ledger.jsonl'); }
function statePath(sessionId) { return path.join(sessionDir(sessionId), 'state.json'); }
function auditPath(sessionId) { return path.join(sessionDir(sessionId), 'audit.json'); }
function handoffPath(sessionId) { return path.join(sessionDir(sessionId), 'HANDOFF.md'); }
function statsPath() { return path.join(HOME, 'stats.json'); }

module.exports = {
  HOME, REPO_ROOT, ensureDir, readJSON, writeJSON, appendJSONL, readJSONL,
  loadConfig, loadClassifier, sessionDir, ledgerPath, statePath, auditPath, handoffPath, statsPath
};
