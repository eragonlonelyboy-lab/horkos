# HONEST NUMBERS: where HORKOS loses

The oath-keeper keeps its own oath: here is exactly when NOT to use HORKOS, and what it costs when you do.

## When HORKOS is the wrong tool

- **Code with a good test suite.** Tests are a better verifier for code than any re-fetch. HORKOS is the loop for work that has *no* test suite: Confluence pages, Jira tickets, TestRail cases, docs, CMS content, config pushed to external systems. If your task ends in `npm test` passing, use that.
- **Pure-conversation sessions.** No external writes → the Stop audit is a no-op (it exits silently, but you paid the hook invocation).
- **Systems without a read API.** HORKOS can only re-fetch what it can read. Write-only targets get receipt-level checks at best, honestly labeled `receipt-only`.

## What it costs

- **Seconds per session exit, not milliseconds.** Tier 1 is free (receipt already in the ledger). Tier 2 is one API GET. Tier 3 re-fetches the whole artifact: on a large Confluence page that is one full page GET, and on a slow instance that can take a few seconds. The classifier exists precisely so you pay Tier 3 only when the write shape demands it.
- **API calls against your rate limits.** Atlassian enforces points-based limits (Mar 2026); TestRail allows 180 req/min on Professional. HORKOS uses single targeted GETs and honors `Retry-After` on 429, but an audit is still real traffic.
- **~30–120s hook timeout budget** on Stop. If your network is down, the auditor reports `unverifiable` and allows exit with an honest message. It never fakes a pass and never hard-traps your session on infrastructure failure.

## What the checks can and cannot prove

- **Phantom detection** is keyword-based (claims mentioning confluence/jira/testrail/git). An agent that claims success *without naming the system* slips past the phantom check: the ledger audit still catches its failed writes, but a claim like "everything's updated" is not matchable. Lower bound, not omniscience.
- **Phantom detection reads only first-person completed-action claims.** Quoted spans are stripped, negated writes and conditional offers are masked, and a scenario marker before the claim verb (would/should/recommend/demo/example/"where an agent"...) or an attribution to another session/agent disqualifies the sentence — all deterministic regexes, no LLM. The honest inverse cost: a real lie hedged *before* the verb ("as you suggested, I updated the page") or wrapped in quotation marks slips the phantom check; the ledger and silent-failure audits remain the backstop.
- **Content probes** (Tier 3) sample the head/middle/tail of what the agent sent and check normalized containment in the live artifact. This catches wrong-page, lost-section, and empty-body failures. It does NOT prove semantic correctness of the content: that's a human's or a reviewer-tool's job.
- **Receipt-only mode** (no creds) proves the write *response* claimed success with a version/id. That is real evidence against phantom and silent-failure lies, but it cannot catch a write that landed on the wrong page. Add creds for that.
- **Confluence version-number lag** exists on the v2 API. HORKOS retries once after 3s before declaring failure: a pathological lag beyond that window can produce a false block (one extra retry cycle, then the bounded handoff protects you).

## False-positive classes caught by dogfood

HORKOS audits real sessions, and real sessions have exposed real auditor mistakes. Every class found live gets fixed AND seeded into `benchmarks/run.js` so it can never silently return. Caught so far (all 2026-07-05, all fixed):

1. **Superseded write** (CALLIOPE build session): a session revising its own file failed the first write's stale head probe. Fix: the latest successful write per target owns the content claim.
2. **Wrong repo, wrong clock** (CALLIOPE build session): git commits were verified against the auditor's cwd and audit time instead of the recorded repo and the claim's own timestamp.
3. **Poisoned fs receipts** (session 0ae7e740): file content that merely *mentions* "error" or "conflict" was sniffed out of Write/Edit responses and flagged as a failed write. Fix: fs receipts no longer sniff response text; disk is the ground truth.
4. **Write-then-Edit head mismatch** (session 0ae7e740): an in-session Edit invalidated the earlier Write's head expectation, and the successful Edit itself was misread as an unretried error. Fix: any later successful write supersedes, regardless of op; Edits are probed by their own `new_string`.
5. **Quoted/hypothetical claim** (session 0ae7e740): a launch recommendation — record a demo GIF where "an agent claims a Confluence write and HORKOS blocks it" — was read as a first-person claim that a Confluence write happened. Fix: quoted spans stripped; scenario markers before the claim verb, future-tense plans, and writes attributed to another session/agent disqualify.
6. **Negated and offered writes** (repro session 224b2711): "changes are uncommitted — say the word if you want them committed" was read as a commit claim. Fix: negations and conditional offers are masked before matching.

This list is expected to grow. A deterministic classifier's false positives are findable, fixable, and benchmarkable — that is the trade against an LLM judge, whose mistakes are none of those things.

## The number that matters

`horkos status` shows three counters: **caught** (false completions blocked), **verified** (sessions that exited with receipts), **handoffs** (bounded-retry limits hit). We publish no percentage claims about your sessions: the only honest test is your own counter after a week of real work.
