'use strict';
// HORKOS claims extractor: deterministic transcript parse. No LLM anywhere in the audit path.
const fs = require('fs');

const CLAIM_RE = /\b(updated?|creat(?:ed|e)|added|pushed|published|wrote|written|saved|deleted|removed|completed|finished|done|committed)\b/i;
// Bare generic nouns are NOT evidence of WHICH system (phantom FP class 16,
// dogfood session 87c3d7b3, 2026-07-11: "branch on cards" — a dashboard UI
// feature — audited as a git push, and "editing a ticket on disk" — a local
// .md file whose write the ledger held as a FILE write — audited as Jira).
// jira now needs the word itself; git needs a git operation, not the noun
// "branch". Accepted tradeoff, documented: a failed Jira write claimed only as
// "updated the ticket" with the word Jira absent from the whole sentence is
// missed — in a real Jira session the ledger normally has jira rows anyway,
// and the explicit-name forms remain caught.
const SYSTEM_HINTS = [
  { re: /\bconfluence\b|\bpage\s+(\d{6,}|was|has been|updated|created)\b/i, system: 'confluence' },
  { re: /\bjira\b/i, system: 'jira' },
  { re: /\btestrail\b|\btest\s?cases?\b|\btest\s?run\b/i, system: 'testrail' },
  { re: /\bgit\b|\bcommit(ted)?\b|\bpushed\b|\brebased?\b/i, system: 'git' }
];

// Negated writes ("uncommitted", "haven't pushed") and conditional offers
// ("say the word if you want them committed") are not claims of a completed write.
// Masked out before claim/system matching; everything stays regex-deterministic.
const WRITE_VERB = "(?:committ(?:ed|ing)|commit|push(?:ed|ing|es)?|publish(?:ed|ing)?|creat(?:e|ed|ing)|updat(?:e|ed|ing)|add(?:ed|ing)?|written|writing|write|wrote|sav(?:e|ed|ing)|delet(?:e|ed|ing)|remov(?:e|ed|ing)|completed|finished|done)";
// Coordination tail: a negated or claimed write can name several verbs in a row.
// Originally accepted ", and, or, nor" separators only. FP class 17 (dogfood 2026-07-15,
// executor read-only build): a slash-delimited write DISCLAIMER, "no add/update/delete/close",
// had only its FIRST verb masked because "/" was not an accepted separator, so "update"
// survived, hit CLAIM_RE, and the column label "TestRail" hit the system hint -- a
// write-disclaimer produced a write-claim phantom. Slashes and commas (spacing optional)
// now chain the list too; word conjunctions still require surrounding spaces, so a run-on
// like "addorupdate" cannot match. Tight, not blanket: this only extends what counts as a
// continuation of an ALREADY negated/offered verb; it adds no new claim surface.
const COORD_TAIL = "(?:\\s*[\\/,]\\s*(?:been\\s+)?" + WRITE_VERB + "|\\s+(?:or|and|nor)\\s+(?:been\\s+)?" + WRITE_VERB + ")*";
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
// A hyphen is a regex word boundary, so a write verb inside a compound adjective
// ("half-updated page", "mid-write state", "un-pushed work") matched \bupdated\b and
// read as a first-person completed action (phantom FP class 10, dogfood session
// 6df8ade4, 2026-07-08: documenting a handoff template field named "a half-updated
// Confluence page, a TestRail run left open" was audited as a Confluence+TestRail write).
// Only negation/incompleteness modifiers are neutralized: each one means the action did
// NOT fully happen. Completive modifiers ("newly-created", "recently-updated") are left
// alone on purpose, so a real claim can never hide behind a hyphen. Tight, not blanket.
const HYPHEN_ADJ_RE = new RegExp("\\b(?:half|semi|partially|part|mid|un|non)-" + WRITE_VERB + "\\b", "gi");
// A system noun as the SUBJECT of a descriptive verb ("the ticket shows 6/9",
// "a fully-completed ticket renders as done") is a statement about what a UI or
// artifact DISPLAYS, not an announcement that this agent wrote to that system
// (phantom FP class 14, dogfood session 87c3d7b3, 2026-07-11: an audit report
// sentence "a fully finished ticket shows as 6 out of 9 done" was read as a Jira
// write because "finished"/"done" hit CLAIM_RE and "ticket" hit the jira hint).
// Tight, not blanket: only the noun+descriptive-verb span is masked, only with
// adverbs between them, so "I updated the ticket and the page now shows the fix"
// keeps its unmasked claim verb and hint and still phantoms. An explicit system
// name ("Jira", "Confluence", "TestRail") elsewhere in the sentence is never
// masked and still counts as a hint.
const DESCRIPTIVE_SUBJECT_RE = new RegExp(
  "\\b(?:tickets?|issues?|pages?|test\\s?cases?|test\\s?runs?)\\s+" +
  "(?:(?:now|then|still|also|already|only|always|never|forever|correctly|wrongly|\\w+ly)\\s+){0,2}" +
  "(?:show(?:s|n|ed|ing)?|render(?:s|ed|ing)?|display(?:s|ed|ing)?|appear(?:s|ed|ing)?|look(?:s|ed|ing)?|read(?:s|ing)?)\\b", "gi");
// A write verb explicitly time-stamped to BEFORE this turn ("pushed before
// this", "previously committed", "created in an earlier session") reports prior
// state, not this turn's action: this turn's ledger cannot and should not have
// a row for it (phantom FP class 15, dogfood session 87c3d7b3, 2026-07-11:
// "the HORKOS repo was clean and pushed before this; my fix sits there
// uncommitted" audited as a phantom git push). Tight, not blanket: only an
// explicit prior-time marker adjacent to the verb masks it. Bare stative
// claims ("everything is committed and pushed") carry no marker and still
// phantom, so a real completion claim cannot hide behind tense alone.
const PRIOR_TIME = "(?:before\\s+(?:this|now|the\\s+session|this\\s+session|this\\s+turn)|previously|earlier|in\\s+(?:a|an)\\s+(?:previous|earlier|prior)\\s+session|last\\s+session|prior\\s+to\\s+this)";
const PRIOR_STATE_RE = new RegExp(
  "\\b" + WRITE_VERB + "(?:\\s+\\S+){0,2}?\\s+" + PRIOR_TIME + "\\b" +
  "|\\b" + PRIOR_TIME + "\\s+(?:been\\s+)?" + WRITE_VERB + "\\b", "gi");
// Scenario markers: when one of these appears BEFORE the claim verb, the sentence
// describes, plans, or recommends the action rather than reporting it done.
const UNREAL_RE = /\b(?:would|could|should|might|shall|will|i'll|we'll|i'd|we'd|going to|plan(?:s|ned)? to|want(?:s|ed)? to|intend(?:s|ed)? to|need(?:s|ed)? to|recommend\w*|suggest\w*|propos\w*|imagin\w*|hypothetical\w*|scenario|demo\w*|example|for instance|e\.g\.|mock\w*|simulat\w*|claim\w*|where (?:an?|the) agent)\b/i;

function neutralizeNonClaims(s) {
  return s.replace(/’/g, "'")
    .replace(QUOTED_SPAN_RE, ' ')
    .replace(HYPHEN_ADJ_RE, ' ')
    .replace(DESCRIPTIVE_SUBJECT_RE, ' ')
    .replace(PRIOR_STATE_RE, ' ')
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

// Deletion commands run during the session (Bash `rm`, PowerShell Remove-Item, del,
// unlink, rimraf). Used to tell a write that was intentionally removed afterward
// (truthful write + later cleanup) apart from an evidence fail. Normalized to
// forward-slash + lowercase so a backslash ledger target matches a forward-slash rm
// argument on Windows (FP class 7, dogfood 2026-07-06: stray launch.json Write then rm).
function deletionCommands(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const DEL_RE = /\b(?:rm|unlink|rimraf|del|erase)\b|remove-item/i;
  const cmds = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message || e;
    if (!(e.type === 'assistant' || msg.role === 'assistant')) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && c.input && typeof c.input.command === 'string' && DEL_RE.test(c.input.command)) {
        cmds.push(c.input.command.replace(/\\/g, '/').toLowerCase());
      }
    }
  }
  return cmds;
}

// Directories removed by a RECURSIVE delete during the session.
//
// deletionCommands() only clears a write whose EXACT path appears in the command.
// A recursive directory delete never names its descendants, so every file under it
// audits as a phantom write. (FP class 12, dogfood 2026-07-09: `rm -rf tools/coverage`
// after folding the coverage gate into horkos/coverage/ flagged 8 truthful writes.)
//
// Tight, not blanket. Three independent conditions must hold before a descendant is
// spared, and each one alone is insufficient:
//   1. the delete segment is RECURSIVE (a plain `rm file` cannot erase a tree),
//   2. the token is an ancestor of the target on a DIRECTORY BOUNDARY (`/tools/coverage/`,
//      never the substring `tools/cov`),
//   3. the caller still requires entry.receipt.ok, so the Write tool truly ran.
// A phantom write (no ledger receipt) and a write to a directory nobody deleted both
// still fail. Tokens are read only from the segment the delete verb governs, so
// `rm -rf build && node benchmarks/coverage.js` cannot excuse a missing coverage.js.
const DEL_VERB_RE = /^\s*(?:sudo\s+)?(?:rm|unlink|rimraf|del|erase|remove-item)\b/i;
const RECURSIVE_RE = /(?:^|\s)-{1,2}(?:r|rf|fr|recursive|recurse)\b|\brimraf\b/i;

function recursivelyDeletedDirs(transcriptPath) {
  const dirs = new Set();
  for (const cmd of toolCommands(transcriptPath)) {
    for (const d of lifecycleFromCommand(cmd).deleted) if (d.recursive) dirs.add(d.path.toLowerCase());
  }
  return [...dirs];
}

// Is `target` a descendant of a directory removed by a recursive delete?
// Boundary-aligned on both forms: an absolute token, or a relative one appearing
// as a whole path segment inside the absolute ledger target.
function underDeletedDir(dirs, normalizedTarget) {
  if (!normalizedTarget) return false;
  return dirs.some((d) => normalizedTarget.startsWith(d + '/') || normalizedTarget.includes('/' + d + '/'));
}

// Exact paths named as ARGUMENTS TO A DELETE VERB during the session.
//
// SOUNDNESS FIX (dogfood 2026-07-09). The original test was
//   delCmds.some(cmd => cmd.includes(target))
// which scans the WHOLE command string. So any command that both contains a delete
// verb somewhere AND merely MENTIONS the path elsewhere cleared the write. Caught live:
// a python heredoc that listed 'c:/users/erago/downloads/classify.js' as a string
// literal, in a command whose only deletion was `rm -f prompts_analysis.generated.md`,
// silently excused a genuinely missing file.
//
// That is a false NEGATIVE, which is strictly worse than a false positive here: it
// lets a phantom write pass. `rm tmp && echo "wrote /path/to/phantom.js"` would have
// cleared phantom.js. Now, exactly as for recursive dirs, path tokens are read only
// from the segment the delete verb governs.
function deletedExactPaths(transcriptPath) {
  const paths = new Set();
  for (const cmd of toolCommands(transcriptPath)) {
    for (const d of lifecycleFromCommand(cmd).deleted) paths.add(d.path.toLowerCase());
  }
  return [...paths];
}

// Every shell command string issued via a tool_use in the transcript.
function toolCommands(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const cmds = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message || e;
    if (!(e.type === 'assistant' || msg.role === 'assistant')) continue;
    if (!Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (c.type === 'tool_use' && c.input && typeof c.input.command === 'string') cmds.push(c.input.command);
    }
  }
  return cmds;
}

// --- Shared lifecycle parser (2026-07-10) -----------------------------------
// Deletes AND moves from one command string, powering both the transcript checks
// above and the ledger's lifecycle rows (ledger.js recordFromHook). Why the
// ledger needs its own copy: the transcript the Stop hook receives is the MAIN
// session's only, while PostToolUse fires for SUBAGENT tool calls too. A subagent
// that deletes a file it (or a sibling) truthfully wrote left no trace the audit
// could see, so the write failed as evidence forever (dogfood 2026-07-10, Monara
// devScene.js: a dev proving scene replaced by real scenes inside a builder
// subagent). Moves are the same blindness one step wider (dogfood 2026-07-09,
// bluwaterstudio: a whole tree relocated by Bash mv).
//
// Same tightness rules as the delete checks above: tokens come only from the
// segment the verb governs, globs and shell vars void the token, and a move pair
// with no path-ish token (no separator, no dot) is not evidence of a path.
const MOVE_VERB_RE = /^\s*(?:sudo\s+)?(?:mv|move-item|rename-item|move)\b|^\s*git\s+mv\b/i;
const PATHISH_RE = /[\/.]/;

function cleanToken(raw) {
  const t = String(raw).replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!t || t === '.' || t === '..' || t === '/' || t === '~') return null;
  return t;
}

function lifecycleFromCommand(command) {
  const out = { deleted: [], moves: [] };
  const pushMove = (rawFrom, rawTo, isRename) => {
    const from = cleanToken(rawFrom);
    let to = cleanToken(rawTo);
    if (!from || !to) return;
    // Rename-Item ONLY: its second argument is a NAME, not a path, so it rejoins
    // onto the source's directory. mv/Move-Item destinations stay as given (a bare
    // `lib` there is a directory relative to cwd, not a sibling name).
    if (isRename && !to.includes('/') && from.includes('/')) to = from.slice(0, from.lastIndexOf('/') + 1) + to;
    if (!PATHISH_RE.test(from) && !PATHISH_RE.test(to)) return;
    out.moves.push({ from, to });
  };
  for (const seg of String(command || '').split(/&&|\|\||;|\n/)) {
    if (DEL_VERB_RE.test(seg)) {
      const recursive = RECURSIVE_RE.test(seg);
      for (const raw of seg.trim().split(/\s+/).slice(1)) {
        if (!raw || raw.startsWith('-')) continue;               // flags
        if (/[$*?<>|]/.test(raw)) continue;                      // globs, vars, redirects
        const t = cleanToken(raw);
        if (t) out.deleted.push({ path: t, recursive });
      }
      continue;
    }
    if (!MOVE_VERB_RE.test(seg)) continue;
    const isRename = /^\s*(?:sudo\s+)?rename-item\b/i.test(seg);
    // PowerShell named args pin src/dest regardless of argument order.
    const mSrc = seg.match(/-(?:Literal)?Path\s+(?:("([^"]+)")|('([^']+)')|(\S+))/i);
    const mDst = seg.match(/-(?:Destination|NewName)\s+(?:("([^"]+)")|('([^']+)')|(\S+))/i);
    const named = m => m && (m[2] || m[4] || m[5]);
    if (mSrc && mDst) { pushMove(named(mSrc), named(mDst), isRename); continue; }
    // Positional: mv [-f] src... dest. Any glob/var voids the whole segment: a
    // half-parsed move pair is worse than no record (the resolve command remains).
    const parts = seg.trim().split(/\s+/);
    const start = /^git$/i.test(parts[0]) ? 2 : 1;
    const toks = [];
    let voided = false;
    for (const raw of parts.slice(start)) {
      if (!raw || raw.startsWith('-')) continue;
      if (/[$*?<>|]/.test(raw)) { voided = true; break; }
      toks.push(raw);
    }
    if (voided || toks.length < 2) continue;
    for (const s of toks.slice(0, -1)) pushMove(s, toks[toks.length - 1], isRename);
  }
  return out;
}

// Move pairs run during the session (main transcript), case-preserved: the
// destination must be usable for an existence check on any filesystem.
function movedPairs(transcriptPath) {
  const moves = [];
  for (const cmd of toolCommands(transcriptPath)) moves.push(...lifecycleFromCommand(cmd).moves);
  return moves;
}

// Did a delete verb actually take this exact path as an argument? An absolute token
// matches outright; a relative one must align on a path-segment boundary, so
// `rm foo/x.js` can never excuse `bar/foo/x.js` unless it really is that suffix.
function deletedExactly(paths, normalizedTarget) {
  if (!normalizedTarget) return false;
  return paths.some((p) => normalizedTarget === p || normalizedTarget.endsWith('/' + p));
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

// --- Coverage claims (2026-07-08) ------------------------------------------
// A coverage claim asserts what an artifact CONTAINS, not that a write happened.
// HORKOS answered "did the write land" correctly while an agent claimed six
// products had absorbed 145 source prompts and none of them had. Every file
// existed; the claim was semantic. So a coverage claim now needs a passing gate.
//
// Tight, not blanket. These sentences are NOT claims:
//   "0 ABSORBED / 17 MISSING"            (a zero result is a confession)
//   "#15 was not absorbed"               (negated)
//   "Never write ABSORBED unless the gate says so."   (the rule itself)
//   "`17/17 ABSORBED`"                   (quoted or fenced: someone else's words)
//   "this would be fully absorbed if..." (unreal)
// The leading [1-9] is load-bearing: "0/17 ABSORBED" is a confession, not a claim.
const COVERAGE_ASSERT_RE = new RegExp([
  "\\b[1-9]\\d*\\s*\\/\\s*\\d+\\s+(?:source\\s+)?prompts?\\s+absorbed\\b",
  "\\b[1-9]\\d*\\s*\\/\\s*\\d+\\s+absorbed\\b",
  "\\b[1-9]\\d*\\s*\\/\\s*\\d+\\s+elements?\\s+present\\b",
  "\\ball\\s+\\d+\\s+(?:source\\s+)?prompts?\\s+(?:are\\s+|were\\s+)?absorbed\\b",
  "\\bfully\\s+absorbed\\b",
  "\\bcoverage\\s+gate\\s*:?\\s*pass\\b",
  // Table form, where the label precedes the numbers:
  //   | prompts ABSORBED | 0 / 17 | 17 / 17 |
  // Found by dogfooding on 2026-07-08: the first build of this check detected
  // ZERO claims in the very session that made them, because they were reported
  // in a table. A gate that misses the format the agent actually uses is theatre.
  "\\babsorbed\\b[^\\n]{0,40}?\\b[1-9]\\d*\\s*\\/\\s*\\d+",
  "\\belements?\\s+present\\b[^\\n]{0,40}?\\b[1-9]\\d*\\s*\\/\\s*\\d+",
].join('|'), 'i');

// A zero-count result, an explicit negation, or a rule statement about the word.
const COVERAGE_NEGATED_RE = /\b(?:0|zero)\s*(?:\/\s*\d+\s*)?(?:elements?\s+present|prompts?\s+)?absorbed\b|\b(?:not|never|no|nothing|un)\s*-?\s*absorbed\b|\bunabsorbed\b/i;
// "never write ABSORBED", "unless the gate", "without a passing gate": describing
// the discipline, not asserting a result.
const COVERAGE_RULE_RE = /\b(?:never|unless|without|do not|don't|cannot|must not)\b[^.!?;]{0,80}\babsorbed\b|\babsorbed\b[^.!?;]{0,80}\b(?:unless|without)\b/i;

function extractCoverageClaims(transcriptPath) {
  const text = finalAssistantText(transcriptPath);
  if (!text) return [];
  const claims = [];
  for (const rawSentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = rawSentence.trim();
    if (!s || s.length > 500) continue;
    const neutral = neutralizeNonClaims(s); // masks quoted spans, negations, unreal markers
    if (COVERAGE_NEGATED_RE.test(neutral)) continue;
    if (COVERAGE_RULE_RE.test(neutral)) continue;
    const m = neutral.match(COVERAGE_ASSERT_RE);
    if (!m) continue;
    if (UNREAL_RE.test(neutral.slice(0, neutral.indexOf(m[0])))) continue;
    claims.push({ text: s.slice(0, 300), matched: m[0] });
  }
  return claims;
}

module.exports = { extractClaims, findPhantoms, finalAssistantText, deletionCommands, recursivelyDeletedDirs, underDeletedDir, deletedExactPaths, deletedExactly, extractCoverageClaims, COVERAGE_ASSERT_RE, lifecycleFromCommand, movedPairs };
