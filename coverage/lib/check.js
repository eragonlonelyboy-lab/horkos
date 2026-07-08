'use strict';
// check.js - the fidelity gate.
//
// HORKOS proves a write happened. ZOILUS proves the work is good. Neither asks
// the question that broke the 145-prompt harvest: does the artifact actually
// contain what its SOURCE demanded? A coverage claim is a factual claim about a
// file. This makes it machine-checked instead of remembered.
//
// Zero-LLM. Deterministic. A missing required element is a FAIL, not a nuance.
const fs = require('fs');
const path = require('path');

// Read every artifact once, concatenate. An element may live in any of them.
function loadCorpus(artifacts, root) {
  const parts = [];
  const missingFiles = [];
  for (const rel of artifacts) {
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(p)) { missingFiles.push(rel); continue; }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of walk(p)) parts.push(fs.readFileSync(f, 'utf8'));
    } else {
      parts.push(fs.readFileSync(p, 'utf8'));
    }
  }
  return { corpus: parts.join('\n\n'), missingFiles };
}

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(md|js|json|txt)$/i.test(name)) out.push(p);
  }
  return out;
}

// An element is present if its pattern matches the corpus, case-insensitively.
// `pattern` is a regex source string. Keep patterns tight enough that a passing
// match means the content is really there, not merely a word that resembles it.
// A pattern carrying a control character is almost always a corrupted escape:
// a shell or a serialiser turned `\b` (word boundary) into U+0008 (backspace).
// Such a pattern matches nothing and would silently report every element ABSENT,
// which is a FALSE NEGATIVE from the very tool built to catch false claims.
// Fail loudly instead. (Found by dogfooding, 2026-07-08: `\bALWAYS\b` became
// `\x08ALWAYS\x08` and reported present content as missing.)
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function checkElement(corpus, el) {
  if (CONTROL_CHAR.test(el.pattern || '')) {
    return { name: el.name, prompt: el.prompt, pattern: JSON.stringify(el.pattern), present: false,
      error: 'CORRUPTED PATTERN: contains a control character, almost certainly an escape mangled in transit. This is a tool bug, not a missing element. Fix the manifest.' };
  }
  let re;
  try { re = new RegExp(el.pattern, 'i'); }
  catch (e) { return { name: el.name, prompt: el.prompt, pattern: el.pattern, present: false, error: `bad pattern: ${e.message}` }; }
  const m = corpus.match(re);
  return { name: el.name, prompt: el.prompt, pattern: el.pattern, present: !!m, matched: m ? m[0].slice(0, 60) : null };
}

// manifest: { destination, root, artifacts:[...], elements:[{prompt,name,pattern}] }
function checkManifest(manifest, rootOverride) {
  const root = rootOverride || manifest.root || '.';
  const { corpus, missingFiles } = loadCorpus(manifest.artifacts || [], root);
  const results = (manifest.elements || []).map((el) => checkElement(corpus, el));
  const present = results.filter((r) => r.present).length;
  const absent = results.filter((r) => !r.present);

  // Per-prompt roll-up: a prompt is ABSORBED only if every one of its elements is present.
  const byPrompt = {};
  for (const r of results) {
    const k = String(r.prompt);
    byPrompt[k] = byPrompt[k] || { prompt: k, total: 0, present: 0 };
    byPrompt[k].total += 1;
    if (r.present) byPrompt[k].present += 1;
  }
  const prompts = Object.values(byPrompt).map((p) => ({
    ...p,
    verdict: p.present === p.total ? 'ABSORBED' : (p.present === 0 ? 'MISSING' : 'PARTIAL'),
  }));

  return {
    destination: manifest.destination,
    ok: absent.length === 0 && missingFiles.length === 0,
    total: results.length,
    present,
    absentCount: absent.length,
    absent,
    missingFiles,
    prompts,
    summary: {
      absorbed: prompts.filter((p) => p.verdict === 'ABSORBED').length,
      partial: prompts.filter((p) => p.verdict === 'PARTIAL').length,
      missing: prompts.filter((p) => p.verdict === 'MISSING').length,
      totalPrompts: prompts.length,
    },
  };
}

module.exports = { checkManifest, checkElement, loadCorpus };
