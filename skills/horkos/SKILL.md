---
name: horkos
description: Use when a HORKOS evidence audit blocks session completion, when the user asks about HORKOS receipts/audits/handoffs, or when finishing work that wrote to external systems (Confluence, Jira, TestRail, files, git). Explains how to respond to a failed oath check.
---

# HORKOS: the oath-keeper

HORKOS audits your writes when you try to finish. It re-checks the actual artifacts: version numbers, live content, file bytes: against what you claimed. It is deterministic code; it cannot be argued with, only satisfied.

## When HORKOS blocks you

The block reason lists exact gaps. Each gap is one of:

- **PHANTOM CLAIM**: you announced a write that never happened (the ledger has no record). The tool call failed or was never made. **Redo the write for real.** Do not soften the claim; make it true.
- **SILENT FAILURE**: your write returned an error (409/403/timeout) and you reported success. **Retry the write**, resolve the conflict (re-fetch the page, re-apply on the current version), and confirm the new receipt.
- **EVIDENCE FAIL**: the artifact was re-fetched and does not contain what you sent (wrong version, missing sections, empty file). **Fix the artifact**, not the description of it.

Rules for the redo:
1. Redo the WRITE, never just the wording. HORKOS re-audits the artifact, not your prose.
2. After a 409 conflict: GET the current version first, then PUT against it.
3. You get a bounded number of attempts (default 3). After that HORKOS writes a HANDOFF file and lets the session end: the human takes over. Leaving an honest handoff is success, not failure.

## Commands

- `horkos status`: caught/verified/handoff counters and the last audit.
- `horkos audit --session <id> [--transcript <path>] [--receipts out.jsonl]`: headless audit (CI, `claude -p`).
- Receipts live at `~/.horkos/sessions/<session_id>/audit.json`. The ledger is append-only; never delete it.

## Honest limits

- Without API creds in `~/.horkos/config.json`, external systems get receipt-level checks only (write-response version/id) plus phantom and silent-failure detection. That is still real evidence; say "receipt-verified" not "content-verified" in that case.
- Code with a good test suite should be verified by tests. HORKOS is the loop for work that has no test suite.
