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
- **Content probes** (Tier 3) sample the head/middle/tail of what the agent sent and check normalized containment in the live artifact. This catches wrong-page, lost-section, and empty-body failures. It does NOT prove semantic correctness of the content: that's a human's or a reviewer-tool's job.
- **Receipt-only mode** (no creds) proves the write *response* claimed success with a version/id. That is real evidence against phantom and silent-failure lies, but it cannot catch a write that landed on the wrong page. Add creds for that.
- **Confluence version-number lag** exists on the v2 API. HORKOS retries once after 3s before declaring failure: a pathological lag beyond that window can produce a false block (one extra retry cycle, then the bounded handoff protects you).

## The number that matters

`horkos status` shows three counters: **caught** (false completions blocked), **verified** (sessions that exited with receipts), **handoffs** (bounded-retry limits hit). We publish no percentage claims about your sessions: the only honest test is your own counter after a week of real work.
