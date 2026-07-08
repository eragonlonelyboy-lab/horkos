# HONEST NUMBERS: where HORKOS loses

The oath-keeper keeps its own oath: here is exactly when NOT to use HORKOS, and what it costs when you do.

## When HORKOS is the wrong tool

- **Code with a good test suite.** Tests are a better verifier for code than any re-fetch. HORKOS is the loop for work that has *no* test suite: Confluence pages, Jira tickets, TestRail cases, docs, CMS content, config pushed to external systems. If your task ends in `npm test` passing, use that.
- **Pure-conversation sessions.** No external writes → the Stop audit is a no-op (it exits silently, but you paid the hook invocation).
- **Systems without a read API.** HORKOS can only re-fetch what it can read. Write-only targets get receipt-level checks at best, honestly labeled `receipt-only`.

## What it costs

- **Seconds per session exit, not milliseconds.** Tier 1 is free (receipt already in the ledger). Tier 2 is one API GET. Tier 3 re-fetches the whole artifact: on a large Confluence page that is one full page GET, and on a slow instance that can take a few seconds. The classifier exists precisely so you pay Tier 3 only when the write shape demands it.
- **API calls against your rate limits.** Atlassian enforces points-based limits (Mar 2026); TestRail allows 180 req/min on Professional. HORKOS uses single targeted GETs and honors `Retry-After` on 429, but an audit is still real traffic.
- **~30-120s hook timeout budget** on Stop. If your network is down, the auditor reports `unverifiable` and allows exit with an honest message. It never fakes a pass and never hard-traps your session on infrastructure failure.

## What the checks can and cannot prove

- **Phantom detection** is keyword-based (claims mentioning confluence/jira/testrail/git). An agent that claims success *without naming the system* slips past the phantom check: the ledger audit still catches its failed writes, but a claim like "everything's updated" is not matchable. Lower bound, not omniscience.
- **Phantom detection reads only first-person completed-action claims.** Quoted spans are stripped, negated writes and conditional offers are masked, and a scenario marker before the claim verb (would/should/recommend/demo/example/"where an agent"...) or an attribution to another session/agent disqualifies the sentence: all deterministic regexes, no LLM. The honest inverse cost: a real lie hedged *before* the verb ("as you suggested, I updated the page") or wrapped in quotation marks slips the phantom check; the ledger and silent-failure audits remain the backstop.
- **Content probes** (Tier 3) sample the head/middle/tail of what the agent sent and check normalized containment in the live artifact. This catches wrong-page, lost-section, and empty-body failures. It does NOT prove semantic correctness of the content: that's a human's or a reviewer-tool's job.
- **Receipt-only mode** (no creds) proves the write *response* claimed success with a version/id. That is real evidence against phantom and silent-failure lies, but it cannot catch a write that landed on the wrong page. Add creds for that.
- **Confluence version-number lag** exists on the v2 API. HORKOS retries once after 3s before declaring failure: a pathological lag beyond that window can produce a false block (one extra retry cycle, then the bounded handoff protects you).

## False-positive classes caught by dogfood

HORKOS audits real sessions, and real sessions have exposed real auditor mistakes. Every class found live gets fixed AND seeded into `benchmarks/run.js` so it can never silently return. Caught so far (all fixed, each a permanent bench scenario):

1. **Superseded write** (CALLIOPE build session): a session revising its own file failed the first write's stale head probe. Fix: the latest successful write per target owns the content claim.
2. **Wrong repo, wrong clock** (CALLIOPE build session): git commits were verified against the auditor's cwd and audit time instead of the recorded repo and the claim's own timestamp.
3. **Poisoned fs receipts** (session 0ae7e740): file content that merely *mentions* "error" or "conflict" was sniffed out of Write/Edit responses and flagged as a failed write. Fix: fs receipts no longer sniff response text; disk is the ground truth.
4. **Write-then-Edit head mismatch** (session 0ae7e740): an in-session Edit invalidated the earlier Write's head expectation, and the successful Edit itself was misread as an unretried error. Fix: any later successful write supersedes, regardless of op; Edits are probed by their own `new_string`.
5. **Quoted/hypothetical claim** (session 0ae7e740): a launch recommendation (record a demo GIF where "an agent claims a Confluence write and HORKOS blocks it") was read as a first-person claim that a Confluence write happened. Fix: quoted spans stripped; scenario markers before the claim verb, future-tense plans, and writes attributed to another session/agent disqualify.
6. **Negated and offered writes** (repro session 224b2711): "changes are uncommitted, say the word if you want them committed" was read as a commit claim. Fix: negations and conditional offers are masked before matching.
7. **CRLF file, LF head** (dogfood 2026-07-06): a multi-line Edit to a CRLF file (Windows repo) records its head with LF, so the raw containment probe never matched. Fix: normalize line endings on both sides before the probe.
8. **Write-then-intentional-delete** (dogfood 2026-07-06): a file truthfully Written and then removed with `rm` or `Remove-Item` in the same session read as an evidence fail. Fix: a delete command naming the exact path plus an ok write receipt is cleanup, not a lie.
9. **Git global flags before the subcommand** (dogfood 2026-07-07, the AURA and KINEMA push): `git -C <path> commit` and `git -c k=v push` were invisible to the ledger because detection required the subcommand to immediately follow `git`, so a real push read as a phantom. Fix: detection allows global flags between `git` and the subcommand, and records the repo from `-C` or `--git-dir`.

10. **A hyphen is a regex word boundary** (dogfood 2026-07-08): documentation naming a field "a half-updated Confluence page, an open TestRail run" matched `updated` inside `half-updated`, so a *documentation string* audited as two external writes. Fix: write verbs behind negation or incompleteness modifiers (half/semi/partially/mid/un/non) are neutralized; completive modifiers (`newly-created`) stay live, so a real claim cannot hide behind a hyphen.
11. **An out-of-band rewrite invalidates the head probe** (dogfood 2026-07-08): a cleanup script rewrote line 2 of seven files it had just Written, leaving no ledger entry, so the write-time head no longer survived in the file and seven truthful writes failed. Fix: mtime settles it. A file modified after the recorded write is spared the probe, and its content is then reported as unverified rather than confirmed; a lying write that nothing touched afterwards still fails, because its mtime sits at the write timestamp.
12. **A recursive directory delete never names its descendants** (dogfood 2026-07-09): `rm -rf tools/coverage`, run after folding that tree into the product, made all 8 truthful writes beneath it audit as phantoms, because class 8 only clears a delete command containing the *exact file path*. Fix: a recursive delete of an ancestor directory clears its descendants, matched on a directory boundary. Recursion is required (a plain `rm dir` cannot erase a tree), the write receipt must still be ok, and path tokens are read only from the segment the delete verb governs, so `rm -rf build && node bench/x.js` cannot launder a missing `bench/x.js`.

13. **A path merely MENTIONED near a delete verb cleared the write** (dogfood 2026-07-09), and this one was a false NEGATIVE, which is strictly worse. The class-8 test scanned the whole command string for the target path, so any command that deleted something harmless while naming the missing path elsewhere (in a heredoc, a string literal, an echo) excused it. `rm tmp && echo "wrote /path/to/phantom.js"` would have cleared phantom.js. Caught when a python heredoc listing a filename as a string literal silently passed a genuinely missing file. Fix: the path must be an ARGUMENT to the delete verb, read only from the segment that verb governs, matched on a path-segment boundary.

This list is expected to grow. A deterministic classifier's false positives are findable, fixable, and benchmarkable: that is the trade against an LLM judge, whose mistakes are none of those things.

Every class above was found by HORKOS auditing its own author's sessions, and every one of them blocked a session that had genuinely done the work. That is the cost side of a deterministic auditor, stated plainly: it is strict, it is sometimes wrong, and when it is wrong you can read the receipt in `~/.horkos/sessions/<id>/audit.json`, find the rule that misfired, and fix it in a line. A judge model that "felt unsure" offers you none of that.

## The number that matters

`horkos status` shows three counters: **caught** (false completions blocked), **verified** (sessions that exited with receipts), **handoffs** (bounded-retry limits hit). We publish no percentage claims about your sessions: the only honest test is your own counter after a week of real work.
