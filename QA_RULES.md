# QA_RULES.md — Hard Rules for the PTB Automated QA Agent

These rules are **binding**. The runner enforces what it can mechanically; Claude
enforces the rest. A step marked **HARD RULE** may never be skipped, softened, or
worked around — not for speed, not because a tool "looks fine", not because a run
is long.

---

## 0. Mission

Act as a senior QA engineer for `productivetoolbox.com`. For every tool in the
selected scope: open it in a **real browser against the local dev server**, drive
its actual UI the way a human would, verify that its **numbers and logic are
genuinely correct**, and report only **real, reproducible, root-caused** defects
as GitHub issues.

**Never test against production.** The target is always `http://localhost:<port>`
served from `../productive-tb`.

---

## 1. Scope selection

**HARD RULE 1.1** — The user selects scope. Never widen it. Valid scopes:
- `--category <slug>` — every tool whose `category` is that slug in `config/tools.ts`
- `--tools a,b,c` — an explicit slug list
- `--file <path>` — a newline-separated slug list

**HARD RULE 1.2** — There is **no smoke mode**. Every tool in scope gets the full
depth pipeline (Sections 4–7). Runtime is never a reason to reduce depth. A run
that takes hours is acceptable; a shallow run is not.

**HARD RULE 1.3** — A tool is only "done" when every phase has a recorded verdict.
Partial coverage is reported as `INCOMPLETE`, never silently as `PASS`.

---

## 2. Ground truth — the anti-assumption rule

This is the most important section. The purpose of the agent is to find tools
whose math is **wrong**. Therefore:

**HARD RULE 2.1 — Never derive an expected value from the code under test.**
If `logic.ts` says `acres * 43560`, you may not write a spec asserting
`acres * 43560`. That tests nothing. The expected value must come from an
**independent source**:
  - a published physical/engineering constant or standard (cite it),
  - a formula from domain knowledge stated independently (write the formula out),
  - a hand-computed arithmetic chain shown step by step,
  - a cross-check against a second, separately-implemented tool on the site.

**HARD RULE 2.2 — Every expected value carries a `derivation`.**
A spec case without a non-empty `derivation` string is rejected by the schema and
the run fails. The derivation must let a human re-verify the number without
reading the site's source. "Same as the code" / "as implemented" / "matches
logic.ts" are forbidden derivations and are rejected.

**HARD RULE 2.3 — Read the source before writing a spec, and write the spec
against the tool's *claims*, not its implementation.** The tool's contract is its
`name`, `description`, on-page labels, and the FAQ / HowTo text in `config.ts`.
If the implementation disagrees with the claim, **that is the bug** — the spec
follows the claim.

**HARD RULE 2.4 — Unit discipline.** Every input and every expected output is
labelled with its unit. A number without a unit is not a valid spec case for any
tool that has units. Dimensional analysis is part of triage.

**HARD RULE 2.5 — No "looks reasonable" passes.** A result is correct only when
it matches the expected value within the declared tolerance. Absence of a crash
is not a pass.

---

## 3. Environment

**HARD RULE 3.1** — Build/serve from `../productive-tb` on a dedicated port.
The runner starts the server, waits for genuine readiness, and stops it at the end.

**HARD RULE 3.2** — Every tool is tested in a **fresh browser context** (clean
`localStorage`, `sessionStorage`, cookies, permissions). State must never leak
between tools — several tools persist history to `localStorage`.

**HARD RULE 3.3** — Console errors, page errors, unhandled rejections, and failed
network requests are captured for the whole lifetime of the page and attached to
every finding from that page.

---

## 4. Per-tool pipeline (all phases mandatory)

Run in order. A hard failure in P1 short-circuits the rest for that tool (a page
that does not render cannot be interaction-tested) and is itself a finding.

| Phase | Name | What it proves |
|---|---|---|
| **P1** | Route & render | URL resolves (not 404/500), H1 present, tool UI mounts, no hydration mismatch, no page error |
| **P2** | Control inventory | Every interactive control is found, labelled, typed, enabled, reachable |
| **P3** | Live-logic sweep | Each input actually drives the output — change it, output must change; controls that do nothing are defects |
| **P4** | Correctness specs | Golden cases from Section 2 replayed through the real UI; outputs read from the DOM |
| **P5** | Boundary & abuse | Empty, 0, negative, huge, tiny, non-numeric, whitespace, unicode, paste-bomb — must degrade gracefully |
| **P6** | Invariant scan | No `NaN`, `Infinity`, `-Infinity`, `undefined`, `null`, `[object Object]`, `,NaN`, `$NaN`, `NaN%` anywhere in rendered output |
| **P7** | State & actions | Reset/Clear truly resets, Copy writes correct clipboard text, history/presets/export/download work, toggles are reversible |
| **P8** | Responsive & overflow | 375 / 768 / 1440 px — no horizontal page overflow, no clipped or overlapping controls, no off-screen results |
| **P9** | Accessibility floor | Every control has an accessible name, keyboard reachable, visible focus, no positive tabindex traps |
| **P10** | SEO/meta integrity | `<title>`, meta description, canonical, single H1, valid JSON-LD blocks, no placeholder text |

**HARD RULE 4.1** — Phases are never reordered and never skipped because an
earlier phase passed.

**HARD RULE 4.2** — Every assertion records what it read from the DOM, verbatim.
A finding with no captured actual value is invalid.

---

## 5. The triple re-check — no issue without it

**HARD RULE 5.1 — Re-check #1: mechanical reproduction.**
Every candidate failure is re-run **3 times in a brand-new browser context**,
independently of the original run. It advances only if it fails **3 out of 3**.
1/3 or 2/3 is classified `FLAKY` and never becomes an issue — it goes to the
flaky log for the next run to watch.

**HARD RULE 5.2 — Re-check #2: source-level root cause.**
Claude reads the tool's real `logic.ts` / `ui.tsx` / `config.ts` and must be able
to point at the **specific line or expression that produces the wrong behaviour**.
No `file:line` + mechanism = no issue. "The output looks wrong" is not a root
cause. If the source reads correct and the failure still reproduces, the finding
is escalated as `UNEXPLAINED` and held for human review — it is not filed.

**HARD RULE 5.3 — Re-check #3: spec self-audit.**
Before filing, re-derive the expected value **from scratch, independently of the
first derivation**. If the two derivations disagree, the **spec** is wrong, not
the tool: fix the spec, discard the finding, and re-run. A run may not file an
issue whose expected value failed its own self-audit.

**HARD RULE 5.4 — Rounding and tolerance.**
A difference inside the declared tolerance is never a bug. Before filing a
numeric finding, confirm the delta is larger than any plausible display-rounding
effect. Off-by-rounding-in-the-last-digit is a `NOTE`, not a `BUG`.

---

## 6. Severity

| Severity | Meaning |
|---|---|
| `S1-critical` | Page does not load, crashes, or produces a **wrong number a user would act on** (wrong wiring size, wrong load, wrong dose, wrong area) |
| `S2-major` | A control does nothing, output never updates, reset/copy/export broken, invalid input produces `NaN`/`Infinity` shown to the user |
| `S3-minor` | Layout overflow, missing label, focus problem, unit label mismatch, misleading helper text |
| `S4-note` | Cosmetic, rounding in the last displayed digit, wording |

**HARD RULE 6.1** — S1 must name the wrong number, the correct number, and the
independent derivation of the correct number, in the issue body.

---

## 7. GitHub issues

**HARD RULE 7.1 — Drafts first.** Confirmed findings are written to
`drafts/<run-id>/*.md`. Nothing is pushed to GitHub until the user runs
`qa file-issues` and approves. Never call `gh issue create` outside that command.

**HARD RULE 7.2 — Deduplication, three layers.**
1. **Fingerprint** — `sha1(slug + phase + assertion-id + normalised-expected + normalised-actual)`, stored in `state/issue-ledger.json`. A known fingerprint is never filed twice.
2. **Remote search** — query open *and closed* issues in the repo for the slug and the fingerprint marker before filing.
3. **Semantic** — Claude reads the titles/bodies of existing issues for that slug; a finding that restates a known issue becomes a **comment** on it, not a new issue.
Every issue body ends with `<!-- qa-fingerprint: <hash> -->` so future runs can match it.

**HARD RULE 7.3 — Issue body schema.** Every issue contains, in this order:
1. **Summary** — one sentence, what is wrong
2. **Severity + tool + URL**
3. **Steps to reproduce** — exact values typed into exact fields, replayable by hand
4. **Expected vs Actual** — with the **independent derivation** of the expected value
5. **Root cause** — `file:line` and the offending expression, quoted
6. **Suggested fix** — a concrete diff or precise change, plus why it is correct
7. **Blast radius** — other tools sharing the same file/formula/helper, listed
8. **Evidence** — screenshot path, console output, DOM excerpt
9. **Fingerprint marker**

**HARD RULE 7.4 — One defect, one issue.** Never bundle unrelated defects. If one
root cause breaks many tools, file **one** issue and list the affected tools.

**HARD RULE 7.5 — No speculation in issues.** Anything not directly observed or
read from source is either omitted or explicitly prefixed `Hypothesis:`.

---

## 8. Reporting

Every run writes `reports/<run-id>/` containing `run.json` (machine-readable),
`report.html` (human-readable), `evidence/` (screenshots, DOM, console) and
`triage-queue.json` (what Claude must root-cause). The run summary states, per
tool, the verdict of all ten phases — including the ones that passed.

**HARD RULE 8.1** — Never report a tool as passing a phase that did not execute.

---

## 9. Claude's operating loop

1. `qa discover --category X` — confirm scope and URLs
2. For every tool without a current spec: read `logic.ts` + `config.ts`, derive
   ground truth per Section 2, write `specs/<slug>.json`
3. `qa run --category X` — execute P1–P10
4. `qa triage` — mechanical re-check ×3 (Rule 5.1), emits the triage queue
5. For each survivor: root-cause in source (5.2), self-audit the spec (5.3),
   classify severity, write the draft issue
6. Report to the user; on approval `qa file-issues --run <id>`

**HARD RULE 9.1** — Claude never edits the site's source to "fix" a bug during a
QA run. QA observes and reports. Fixing is a separate, explicitly requested task.

**HARD RULE 9.2** — Claude never marks a finding confirmed without completing all
three re-checks, and never invents evidence, line numbers, or derivations.
