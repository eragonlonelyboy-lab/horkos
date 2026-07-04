# HORKOS

**Your agent swore it was done. HORKOS checks.**

HORKOS is the Greek god of oaths: the one who punishes oath-breakers. Your coding agent swears an oath every time it says "✅ Done." HORKOS makes the artifact testify before the session is allowed to end.

## The lie, caught

An agent is told to update a Confluence page. The MCP write silently fails. The agent announces success anyway: a documented, common failure mode. Here is what HORKOS does with that:

**The agent said:**
> I updated the Confluence page with the Q3 section. ✅ Done.

**HORKOS answered:**
```
HORKOS evidence audit FAILED (attempt 1/3). The artifact does not match your claims.
PHANTOM CLAIM: you said "I updated the Confluence page with the Q3 section." but the
ledger shows ZERO writes to confluence. The write never happened. Do it for real.
```

The session does not end. The agent redoes the write, the real one this time, and only exits when the re-fetched page carries the new version and the new content. Every check is a script. The agent cannot sweet-talk a bash loop.

## Why every other loop lets the lie through

Every shipped agent loop exits on one of three things:

| Exit condition | Who ships it | The hole |
|---|---|---|
| Self-report ("DONE" string, exit signal) | ralph-wiggum, ralph runners, taskmaster | The agent grades its own homework |
| Tests pass | /goal-style conditions, CI loops | Great for code. Useless for Confluence pages, Jira tickets, test suites, docs, CMS content |
| Judge-LLM reads the transcript | /goal evaluator, adversarial review panels | The judge "does not call tools: it can only judge what Claude has already surfaced in the conversation." It grades the *story* |

HORKOS is the fourth exit condition: **the artifact itself.** Re-fetched, hashed, compared. It is the loop for work that has no test suite.

## How it works

1. **Write ledger** (PostToolUse hook): every external write (Confluence, Jira, TestRail, files, git) is recorded live with the receipt its own response carried (version number, id, SHA). Zero extra API calls.
2. **Claims extractor** (Stop hook): when the agent tries to finish, its claims are parsed from the transcript and cross-checked against the ledger. A claim with no write behind it = phantom. A write that errored and was reported as success = silent failure.
3. **Tier classifier**: proportional evidence, shipped as data ([classifier.json](classifier.json), edit it, PR it):
   - **Tier 1: receipt:** small targeted edit → the version bump in the write response is proof enough.
   - **Tier 2: probe:** multi-section edit → one targeted API GET confirms it landed.
   - **Tier 3: re-fetch:** full rewrite, **any net-new creation, any delete** → the whole artifact is re-fetched and compared, normalized, section by section. No exceptions, regardless of how confident the diff looked.
   - Inputs are mechanical facts only (operation, novelty, size, system, conflict signals). Agent confidence is deliberately not an input.
4. **Bounded loop:** audit fails → exit blocked, the exact gaps fed back. Three strikes → HORKOS writes a `HANDOFF.md` (claims vs. evidence vs. what remains) and lets the human take over. It never claims unconditional termination and never traps you in an unwinnable loop.
5. **Receipts:** every audit is an append-only JSONL trail (claim, evidence, hash, verdict), re-executable offline.

## Install

Windows (PowerShell):
```powershell
git clone https://github.com/eragonlonelyboy-lab/horkos; cd horkos; node bin/horkos.js install
```
macOS / Linux:
```bash
git clone https://github.com/eragonlonelyboy-lab/horkos && cd horkos && node bin/horkos.js install
```
Node 18+, zero dependencies. Registers two hooks in `~/.claude/settings.json`. Re-run safe. Broke something? Open your agent in this repo and say: *read the README and fix my HORKOS install.*

Optional but recommended: API creds in `~/.horkos/config.json` unlock the probe and re-fetch tiers for Confluence / Jira / TestRail. Without creds, HORKOS still runs receipt checks, phantom detection, and silent-failure detection: and honestly labels the difference.

## Benchmarks

Reproducible, in-repo, deterministic: `npm test`

| scenario | expected | caught |
|---|---|---|
| phantom-confluence-claim | fail/phantom | YES |
| silent-409-failure | fail/silent | YES |
| fs-file-missing | fail/fail | YES |
| fs-content-mismatch | fail/fail | YES |
| receipt-only-honest-pass | pass/clean | YES |
| clean-fs-write | pass/clean | YES |

6/6. When it wins, it shows you the receipt. When it can't verify, it says so: read [docs/HONEST-NUMBERS.md](docs/HONEST-NUMBERS.md) for exactly where HORKOS loses.

## CLI

```
horkos status                      # caught / verified / handoff counters + last audit
horkos audit --session <id> [--transcript <p>] [--receipts out.jsonl]   # headless (CI, claude -p)
horkos uninstall                   # removes hooks; receipts are kept: the ledger is never deleted
```

## From the same forge

HORKOS is a Demiurge product. Siblings (each standalone, each recommends the others only if you don't have them):

| Product | Oath |
|---|---|
| **VERITAS** | Slop-free prose that audits its own output |
| **MONETA** | Honest token discipline: MONETA proves cheaper, HORKOS proves not-worse |
| **HYPNOS** | Memory consolidation in your agents' sleep: every change a diff, nothing deleted |
| **MAAT** | Multi-agent attention terminal: receipts across every session |

## The fair trade

If HORKOS catches one lie before it reaches your boss, the star costs you nothing. ⭐

MIT: see [LICENSE](LICENSE). An oath sworn is cheap. An oath kept is evidence.
