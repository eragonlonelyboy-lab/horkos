# coverage: the fidelity gate

**HORKOS** proves a write happened. **ZOILUS** proves the work is good.
Neither asks the question that broke the 145-prompt harvest:

> Does the artifact actually contain what its SOURCE demanded?

A coverage claim is a factual claim about a file. This makes it machine-checked
instead of remembered. Zero-LLM, deterministic, fails closed.

## Use

```powershell
node bin/coverage.js all                     # the gate, exit 1 if anything is absent
node bin/coverage.js explain manifests/zoilus.json   # per-prompt verdicts + every absent element
node benchmarks/run.js                       # 13/13, the gate checks itself
```

## Manifest

```json
{ "destination": "ZOILUS (7 source prompts)",
  "root": "../../products/zoilus",
  "artifacts": ["SKILL.md", "references", "lib"],
  "elements": [ { "prompt": 15, "name": "ranked hypotheses", "pattern": "hypotheses, ranked" } ] }
```

A prompt is **ABSORBED** only when every one of its elements is present. One
absent element makes it **PARTIAL** and fails the gate. Zero present makes it
**MISSING**. A missing artifact file fails the gate even if every element matched
elsewhere: an empty `references/` cannot pass.

## Why it fails loudly on a corrupted pattern

A pattern carrying a control character is a mangled escape, not a missing element.
The gate says so explicitly rather than reporting a false ABSENT. The tool built to
catch false claims must not make one.

## The rule
Never write ABSORBED in a tracker unless this gate says so.
