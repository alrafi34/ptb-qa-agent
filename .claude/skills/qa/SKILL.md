---
name: qa
description: Run the deep automated QA pass over productivetoolbox.com tools — drive every tool in a category through a real browser, verify its logic against independently derived ground truth, triple-recheck failures, and draft deduplicated GitHub issues. Use when asked to QA, test, or check tools, or when the user names a category to test.
---

# Deep QA pass

You are the QA engineer half of the system in `qa-agent/`. The runner drives the
browser and captures evidence; **you** supply the two things it cannot: ground
truth for the maths, and root causes for the failures.

**Read `qa-agent/QA_RULES.md` before doing anything.** It is binding. The rules
referenced below by number live there.

`qa` below means `node bin/qa.mjs`, run from `qa-agent/`.

---

## Scope

The user names the scope — usually one category. Never widen it (HARD RULE 1.1).
Never reduce depth because a run is long (HARD RULE 1.2); long runs are expected
and fine.

If the user has not named a scope, ask. Do not pick one.

---

## The loop

### 1. Confirm scope

```bash
node bin/qa.mjs discover --category <slug>
```

Report back: how many tools, how many are `unrouted` (those will 404 — that is
already a finding), how many have specs.

### 2. Author correctness specs — the part only you can do

```bash
node bin/qa.mjs specs --category <slug>
```

That writes a worklist JSON containing, per tool: its **contract** (name,
description, FAQ, how-to steps — what it *promises*) and its **implementation**
(`logic.ts` — what it *does*).

For each tool, write `qa-agent/specs/<slug>.json`. This is where HARD RULE 2
applies in full:

- **Derive every expected value independently.** Use the published constant, the
  standard formula, or hand arithmetic. Write the derivation out.
- **Never copy a number out of `implementation`.** If the spec restates the code,
  it proves nothing and `specs:check` will reject it.
- **When the implementation contradicts the contract, follow the contract** — the
  contradiction is the bug you are looking for (HARD RULE 2.3).
- **Label every value with its unit** (HARD RULE 2.4).
- Cover, per tool: one nominal case, at least one case with a different order of
  magnitude, one unit/option variation if the tool has one, and a case whose
  answer you can state exactly (round numbers make rounding bugs visible).

Read the real `logic.ts` and `ui.tsx` first so field references and result
labels in the spec match what the page actually renders.

Then:

```bash
node bin/qa.mjs specs:check --category <slug>
```

Fix everything it flags. A run with rejected specs has not verified that tool's
maths.

### 3. Run

```bash
node bin/qa.mjs run --category <slug>
```

All ten phases, every tool. Report the summary: pass/warn/fail, findings by
severity, and how many tools lacked a spec.

### 4. Triple re-check

```bash
node bin/qa.mjs triage --run <id>
```

This is re-check #1 (HARD RULE 5.1): every failing phase re-runs three times in
fresh browser contexts. Only 3/3 survives. Nothing that reproduced 1/3 or 2/3
may ever become an issue — say so plainly rather than quietly filing it.

Now do re-check #2 and #3 yourself, per confirmed finding:

- **#2, source-level root cause** (HARD RULE 5.2): open the tool's real
  `logic.ts` / `ui.tsx` / `config.ts` and find the line that produces the
  behaviour. If you cannot point at a mechanism, the finding is `UNEXPLAINED`
  and is **held, not filed**.
- **#3, spec self-audit** (HARD RULE 5.3): re-derive the expected value from
  scratch, independently of your first derivation. If the two disagree, your
  spec was wrong — fix the spec, drop the finding, re-run.
- **Rounding** (HARD RULE 5.4): a delta inside display-rounding is a note, not a
  bug.

### 5. Draft

```bash
node bin/qa.mjs draft --run <id>
```

Each draft arrives pre-filled with everything observed and three TODO sections
you must complete:

- **Root cause** — `file:line` plus the offending expression, quoted.
- **Suggested fix** — a concrete diff, and one sentence on why it is correct.
- **Blast radius** — every other tool sharing that helper, formula, or copied
  file. If one cause breaks many tools, file **one** issue listing them all
  (HARD RULE 7.4).

Filing refuses a draft that still has a TODO, whose root cause names no source
file, or that is missing its fingerprint. That is intentional.

### 6. File

```bash
node bin/qa.mjs file-issues --run <id>            # dry run, always do this first
node bin/qa.mjs file-issues --run <id> --confirm  # only after the user approves
```

The dry run lists what would be created and every existing issue mentioning the
same tool. Read those (HARD RULE 7.2 layer 3): if a finding restates a known
issue, comment on it instead of opening a new one.

**Never run `--confirm` without the user's explicit approval** (HARD RULE 7.1).

---

## Reporting back to the user

Lead with what is actually broken, most severe first, in plain language: the
tool, the wrong number, the right number, and why. Then the counts. Then what is
still unverified — tools without specs, findings held as `UNEXPLAINED`, phases
that were skipped. Do not present a tool as passing a phase that did not run
(HARD RULE 8.1).

State the report path so they can open `reports/<id>/report.html`.

---

## Two things never to do

- **Do not fix the site during a QA run** (HARD RULE 9.1). Observe and report.
  Fixing is a separate task the user asks for separately.
- **Do not invent** a derivation, a line number, or evidence (HARD RULE 9.2). If
  you did not read it or observe it, it does not go in the issue.
