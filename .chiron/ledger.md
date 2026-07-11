# CHIRON Ledger

Rules distilled from corrections. Managed by CHIRON; edit by hand only if you keep the structure.

## CHI-R001 | active | 2026-07-11
**Mistake:** 
**Rule:** A runtime-output claim (what code renders, returns, or displays) is verified only by execution; source-reading gives a prediction that must be labeled as derived until run
**Apply:** 
**Detail:**
HORKOS phantom FP class 14 (session 87c3d7b3, 2026-07-11): CLAIM_RE treats finished/done as write verbs and 'ticket' as a Jira hint, so a UI-state description like 'a fully finished ticket shows as 6 out of 9 done' audited as a phantom Jira write. Fixed in lib/claims.js (DESCRIPTIVE_SUBJECT_RE masks system-noun+descriptive-verb subjects); bench 53/53 with FP-clean + TP-guard scenarios. Deeper lesson: I stated the 6/9 rendering as fact from source-reading before executing it; the executed run then confirmed it, but the order was wrong.
- source: manual
- type: gotcha
- projects: horkos
- occurrences: 1
- updated: 2026-07-11
