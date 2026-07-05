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

// Negated writes ("uncommitted", "haven't pushed") and conditional offers
// ("say the word if you want them committed") are not claims of a completed write.
// Masked out before claim/system matching; everything stays regex-deterministic.
const WRITE_VERB = "(?:committ(?:ed|ing)|commit|push(?:ed|ing|es)?|publish(?:ed|ing)?|creat(?:e|ed|ing)|updat(?:e|ed|ing)|add(?:ed|ing)?|written|writing|write|wrote|sav(?:e|ed|ing)|delet(?:e|ed|ing)|remov(?:e|ed|ing)|completed|finished|done)";
const COORD_TAIL = "(?:\\s*(?:,|or|and|nor)\\s+(?:been\\s+)?" + WRITE_VERB + ")*";
const NEGATED_WRITE_RE = new RegExp("\\b(?:not|never|no|nothing|without|haven't|hasn't|hadn't|don't|doesn't|didn't|won't|wasn't|weren't|isn't|aren't|yet\\s+to\\s+be)(?:\\s+\\w+){0,2}?\\s+" + WRITE_VERB + COORD_TAIL + "\\b", "gi");
const OFFERED_WRITE_RE = new RegExp("\\b(?:if\\s+you(?:'d)?\\s+(?:want|like|prefer|approve|say\\s+so)|say\\s+the\\s+word|let\\s+me\\s+know|once\\s+you\\s+(?:approve|confirm|say)|when(?:ever)?\\s+you're\\s+ready)\\b[^.!?;]*?\\b" + WRITE_VERB + COORD_TAIL + "\\b", "gi");
const OFFER_TO_WRITE_RE = new RegExp("\\b(?:shall\\s+i|should\\s+i|want\\s+me\\s+to|would\\s+you\\s+like(?:\\s+me)?\\s+to|i\\s+can|i\\s+could|i'll|i\\s+will|happy\\s+to|glad\\s+to|ready\\s+to|offer(?:ing)?\\s+to)\\s+(?:go\\s+ahead\\s+and\\s+|just\\s+|also\\s+)?" + WRITE_VERB + COORD_TAIL + "\\b", "gi");

// Quoted, hypothetical, future, or attributed scenarios are not first-person
// completed-action claims (phantom FP, dogfood session 0ae7e740, 2026-07-05:
// 'record the real demo GIF (agent claims a Confluence write, HORKOS blocks
// "done")' was read as a claim that a Confluence write happened).
// Quoted spans are someone else's words or an example, never this agent's own
// completed action. A write verb attributed to another session/agent/user is a
// report about someone else's write, not a claim of this session's.
const QUOTED_SPAN_RE = /"[^"\n]{0,300}"|“[^”\n]{0,300}”|`[^`\n]{0,300}`/g;
const ATTRIBUTED_WRITE_RE = new RegExp("\\b" + WRITE_VERB + "[^.!?;]{0,30}?\\bby\\s+(?:a|an|the|another|that|this|some)\\s+(?:\\w+\\s+)?(?:session|agent|run|process|user|human|teammate|bot)\\b", "gi");
// Scenario markers: when one of these appears BEFORE the claim verb, the sentence
// describes, plans, or recommends the action rather than reporting it done.
const UNREAL_RE = /\b(?:would|could|should|might|shall|will|i'll|we'll|i'd|we'd|going to|plan(?:s|ned)? to|want(?:s|ed)? to|intend(?:s|ed)? to|need(?:s|ed)? to|recommend\w*|suggest\w*|propos\w*|imagin\w*|hypothetical\w*|scenario|demo\w*|example|for instance|e\.g\.|mock\w*|simulat\w*|claim\w*|where (?:an?|the) agent)\b/i;

function neutralizeNonClaims(s) {
  return s.replace(/’/g, "'")
    .replace(QUOTED_SPAN_RE, ' ')
    .replace(NEGATED_WRITE_RE, ' ')
    .replace(OFFERED_WRITE_RE, ' ')
    .replace(OFFER_TO_WRITE_RE, ' ')
    .replace(ATTRIBUTED_WRITE_RE, ' ');
}

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
    const neutral = neutralizeNonClaims(s);
    const verbAt = neutral.search(CLAIM_RE);
    const at = verbAt >= 0 ? verbAt : neutral.indexOf('✅');
    if (at < 0) continue;
    // First-person completed-action claims only: a scenario marker before the
    // claim verb means the sentence describes a hypothetical, plan, or
    // recommendation, not a result (dogfood session 0ae7e740, 2026-07-05).
    if (UNREAL_RE.test(neutral.slice(0, at))) continue;
    const systems = SYSTEM_HINTS.filter(h => h.re.test(neutral)).map(h => h.system);
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
