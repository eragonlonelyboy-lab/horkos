---
name: horkos
description: Use when a HORKOS evidence audit blocks session completion, when the user asks about HORKOS receipts/audits/handoffs, or when finishing work that wrote to external systems (Confluence, Jira, TestRail, files, git). Explains how to respond to a failed oath check.
---

# HORKOS: the oath-keeper

HORKOS audits your writes when you try to finish. It re-checks the actual artifacts (version numbers, live content, file bytes) against what you claimed. It is deterministic code; it cannot be argued with, only satisfied.

## Multi-model delegation oath

Before a write-capable agent begins a standard or high-stakes work unit, run `horkos delegation --file <work-unit.json>`. It fails closed on an implicit or missing resume id, an unverified dirty tree, a missing proof command, self-review-only high-stakes work, or full write authority without isolation and explicit authorization. The audit records authority and verifier identity; it does not choose the model.

## When HORKOS blocks you

The block reason lists exact gaps. Each gap is one of:

- **PHANTOM CLAIM**: you announced a write that never happened (the ledger has no record). The tool call failed or was never made. **Redo the write for real.** Do not soften the claim; make it true.
- **SILENT FAILURE**: your write returned an error (409/403/timeout) and you reported success. **Retry the write**, resolve the conflict (re-fetch the page, re-apply on the current version), and confirm the new receipt.
- **EVIDENCE FAIL**: the artifact was re-fetched and does not contain what you sent (wrong version, missing sections, empty file). **Fix the artifact**, not the description of it.

**The legitimate-lifecycle exception.** A truthful write whose file was later deliberately deleted or moved is NOT a gap to "fix": recreating the file to satisfy the audit is manufacturing evidence, and that is a firing offense. HORKOS clears these itself when it can see them: deletes and moves run through Bash/PowerShell are recorded as ledger lifecycle rows (subagent calls included), and a recorded move redirects verification to the destination, which must itself pass. If the lifecycle happened where no hook could see it (another session, a file manager, rows that predate this feature), reconcile it explicitly with `horkos resolve`. Resolve is evidence-gated: it verifies the current ground truth itself (the file must actually be absent, or the destination must actually carry what was written), refuses what it cannot prove, refuses paths that were never truthfully written, and appends an append-only row that future audits cite. It is a truth-recorder, not an override.

Rules for the redo:
1. Redo the WRITE, never just the wording. HORKOS re-audits the artifact, not your prose.
2. After a 409 conflict: GET the current version first, then PUT against it.
3. You get a bounded number of attempts (default 3). After that HORKOS writes a HANDOFF file and lets the session end: the human takes over. Leaving an honest handoff is success, not failure.

## Commands

- `horkos status`: caught/verified/handoff counters and the last audit.
- `horkos audit --session <id> [--transcript <path>] [--receipts out.jsonl]`: headless audit (CI, `claude -p`).
- `horkos resolve --session <id> --path <p> --reason "<why>" [--moved-to <newpath>]`: reconcile a truthful write whose artifact was legitimately deleted or moved out of band. Verifies ground truth before accepting; appends, never edits.
- Receipts live at `~/.horkos/sessions/<session_id>/audit.json`. The ledger is append-only; never delete it.

## Honest limits

- Without API creds in `~/.horkos/config.json`, external systems get receipt-level checks only (write-response version/id) plus phantom and silent-failure detection. That is still real evidence; say "receipt-verified" not "content-verified" in that case.
- Code with a good test suite should be verified by tests. HORKOS is the loop for work that has no test suite.
