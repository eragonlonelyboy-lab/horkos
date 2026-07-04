'use strict';
// HORKOS claims extractor: deterministic transcript parse. No LLM anywhere in the audit path.
const fs = require('fs');

const CLAIM_RE = /\b(updated?|creat(?:ed|e)|added|pushed|published|wrote|written|saved|deleted|removed|completed|finished|done|committed)\b/i;
const SYSTEM_HINTS = [
  { re: /\bconfluence\b|\bpage\s+(\d{6,}|was|has been|updated|created)\b/i, system: 'confluence' },
  { re: /\bjira\b|\bissue\b|\bticket\b/i, system: 'jira' },
  { re: /\btestrail\b|\btest\s?cases?\b|\btest\s?run\b/i, system: 'testrail' },
  { re: /\bcommit(ted)?\b|\bpushed\b|\bbranch\b/i, system: 'git' }
];

// Read assistant text emitted since the last real user message.
function finalAssistantText(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch { return ''; }
  const texts = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message || e;
    if (e.type === 'user' || msg.role === 'user') {
      // tool_result-only user entries are not a human turn boundary
      const content = msg.content;
      const isToolResult = Array.isArray(content) && content.length && content.every(c => c.type === 'tool_result');
      if (!isToolResult) texts.length = 0;
      continue;
    }
    if (e.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) for (const c of content) if (c.type === 'text' && c.text) texts.push(c.text);
    }
  }
  return texts.join('\n');
}

// Extract completion claims that reference a system we can audit.
function extractClaims(transcriptPath) {
  const text = finalAssistantText(transcriptPath);
  if (!text) return [];
  const claims = [];
  for (const rawSentence of text.split(/(?<=[.!?✅])\s+|\n+/)) {
    const s = rawSentence.trim();
    if (!s || s.length > 500) continue;
    if (!CLAIM_RE.test(s) && !s.includes('✅')) continue;
    const systems = SYSTEM_HINTS.filter(h => h.re.test(s)).map(h => h.system);
    if (systems.length) claims.push({ text: s.slice(0, 300), systems });
  }
  return claims;
}

// Phantom writes: claimed systems with ZERO ledger writes. The documented failure mode:
// MCP write errors, agent announces success anyway.
function findPhantoms(claims, ledger) {
  const written = new Set(ledger.map(e => e.system));
  const phantoms = [];
  for (const c of claims) {
    const missing = c.systems.filter(s => !written.has(s));
    if (missing.length === c.systems.length && missing.length > 0) {
      phantoms.push({ claim: c.text, systems: missing });
    }
  }
  return phantoms;
}

module.exports = { extractClaims, findPhantoms, finalAssistantText };
