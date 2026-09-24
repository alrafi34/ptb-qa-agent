# PTB QA Agent

An automated QA engineer for `productivetoolbox.com`. It opens every tool in the
selected scope in a real browser against a **local** server, drives the actual
UI, checks the numbers against independently derived ground truth, re-runs every
failure three times, and — once Claude has root-caused it in the source — files
a deduplicated GitHub issue.

The behavioural contract lives in [`QA_RULES.md`](./QA_RULES.md). That file is
the spec; this README is the manual.

---

## Where this lives

This is its **own repository**, kept beside the site it tests rather than inside
it:

```
ptb/
├── productive-tb/     the site — its own repo
└── qa-agent/          this — a separate repo
    └── .claude/skills/qa/   the /qa skill, versioned with the agent
```

It stays separate on purpose: the QA agent has its own dependencies
(Playwright), its own release cycle, and nothing it ships belongs in the site's
bundle. The `/qa` skill lives in here too, because it is the agent's own
operating procedure — **open Claude Code in `qa-agent/` for `/qa` to be
available.**

The agent finds the site at `../productive-tb`. If the two are ever checked out
somewhere else, point it with `QA_SITE`:

```bash
QA_SITE=/path/to/productive-tb node bin/qa.mjs doctor
```

Issues are still filed against the **site's** repo (`alrafi34/productive-tb`),
since that is where the bugs are. Override with `QA_REPO` or `--repo`.

---

## The two halves

The system deliberately splits into a **deterministic runner** and **Claude**,
because they are good at different things.

| | Runner (this code) | Claude |
|---|---|---|
| Drives the browser, reads the DOM, captures evidence | yes | no |
| Decides whether `217,800 sq ft` is the right answer for 5 acres | no | yes |
| Replays the same test identically every run | yes | no |
| Reads `logic.ts` and explains *why* a number is wrong | no | yes |

So the expensive, judgement-heavy work (authoring ground truth, root-causing)
happens once and is **cached as files** — spec JSON and issue drafts. Every
later run replays them for free.

---

## Install

```bash
cd qa-agent
npm install
npx playwright install chromium
node bin/qa.mjs doctor
```

`doctor` must be all green before a real run. It checks the site directory,
tool discovery, the browser, `gh` auth against the target repo, and how many
specs exist.

---

## The workflow

Scope is always explicit and always deep — there is no smoke mode
(HARD RULE 1.2). A typical session covers one category.

```bash
qa categories                        # what is available
qa discover --category electrical    # 81 tools, their URLs, routing, spec status
qa specs    --category electrical    # briefing file for Claude to author specs from
#   -> Claude writes specs/<slug>.json for each tool
qa specs:check --category electrical # refuse specs that restate the implementation
qa run      --category electrical    # P1-P10 on every tool
qa triage   --run <id>               # re-run every failure 3x in fresh contexts
#   -> Claude root-causes each survivor in the source
qa draft    --run <id>               # scaffold one issue draft per confirmed finding
#   -> Claude fills Root cause / Suggested fix / Blast radius
qa file-issues --run <id>            # dry run: shows exactly what would be filed
qa file-issues --run <id> --confirm  # actually creates them
```

`qa` here is `node bin/qa.mjs`.

---

## What "deep" means — the ten phases

Every tool in scope goes through all ten. None is skipped because an earlier one
passed.

| Phase | Checks |
|---|---|
| **P1** Route & render | URL resolves, page is not the 404 page, no uncaught exception, no hydration mismatch, no `console.error`, exactly one `<h1>` |
| **P2** Control inventory | Every control found, typed, named, enabled; a tool that mounts no controls is critical |
| **P3** Live-logic sweep | Each input is changed one at a time and the output **must** move. A control that changes nothing is a defect |
| **P4** Correctness specs | Golden cases replayed through the real UI, outputs read from the DOM, compared against independently derived values |
| **P5** Boundary & abuse | empty, 0, negative, 10<sup>12</sup>, 10<sup>-7</sup>, `abc`, whitespace, `007`, `1e10`, `1,5`, unicode, HTML injection, 10k-char paste |
| **P6** Invariant scan | No `NaN`, `Infinity`, `undefined`, `null`, `[object Object]` may reach the screen for ordinary input |
| **P7** State & actions | Reset truly resets, Copy writes the right text to the clipboard, Download produces a file, toggles are reversible |
| **P8** Responsive | 375 / 768 / 1440 px — no horizontal overflow, no collapsed controls |
| **P9** Accessibility floor | Accessible name on every control, no positive tabindex, focusable primary input, `alt` on images |
| **P10** SEO / meta | title, description, canonical points at itself, JSON-LD parses, `<h1>` matches the registry |

---

## Ground truth, and why specs are written by hand

P4 is the only phase that can catch a **wrong answer**. It is also the only one
that can be faked into uselessness, so HARD RULE 2.1 is the centre of the whole
design:

> Never derive an expected value from the code under test.

If a spec for the acre converter said `expect: acres * 43560` it would pass
whatever the code did — it would be testing that the code equals itself. So
every case carries a `derivation` explaining where the number came from, and
`qa specs:check` rejects derivations like "same as logic.ts".

A spec looks like this:

```jsonc
{
  "slug": "acre-to-square-feet-converter",
  "version": 1,
  "contractSource": "Tool description: 'Convert acres to square feet'.",
  "cases": [
    {
      "id": "one-acre",
      "derivation": "The international acre is defined as exactly 43,560 square feet (1 chain x 1 furlong = 66 ft x 660 ft). So 1 acre -> 43,560 sq ft.",
      "inputs": { "Acres": "1" },
      "expect": [
        { "type": "number", "near": "Square Feet", "value": 43560, "unit": "sq ft", "tolerance": { "rel": 0.0001 }, "severity": "S1-critical" },
        { "type": "noPoison" }
      ]
    }
  ]
}
```

**Field references** (`"Acres"`) are matched against the control's accessible
name, its text, its placeholder, its exact CSS path, or an index form such as
`"input:0"` / `"select:1"`.

**Expectation types**: `number` (with `near` label or `index`, plus `unit` and
`tolerance`), `numberAny`, `contains`, `notContains`, `matches` (regex),
`noPoison`.

Tools with no spec still run all ten phases — but the report marks them
`no correctness spec`, because their arithmetic was never checked.

---

## The triple re-check

No issue is ever filed off a single observation.

1. **Mechanical** — `qa triage` re-runs the failing phases **three times in
   brand-new browser contexts**. Only 3/3 advances. 1/3 or 2/3 is `FLAKY` and
   goes to `state/flaky-log.json`, never to GitHub.
2. **Source-level** — Claude must find the line that causes it. `qa file-issues`
   refuses any draft whose *Root cause* section is thin or names no source file.
3. **Spec self-audit** — the expected value is re-derived from scratch. If the
   two derivations disagree, the spec was wrong, not the tool.

---

## Deduplication

Three layers, all enforced at filing time:

1. **Fingerprint** — `sha1(slug + phase + assertion + expected + actual)`, kept
   in `state/issue-ledger.json`, and stamped into every issue body as
   `<!-- qa-fingerprint: … -->`.
2. **Remote search** — `gh issue list --state all --search "qa-fingerprint: …"`
   before creating anything, so a re-clone or a fresh machine still dedupes.
3. **Semantic** — the dry run lists every existing issue that mentions the same
   tool so Claude can comment on one instead of opening a near-duplicate.

---

## Output

```
reports/<run-id>/
  run.json             every phase verdict, every finding, machine-readable
  report.html          the human view — phase matrix, findings, flaky list
  triage-queue.json    confirmed / flaky / not-reproduced
  evidence/*.png       screenshot of each tool in its exercised state
  evidence/*.html      full DOM dump, written only for tools that failed
  filing-result.json   what was filed, skipped, or rejected
drafts/<run-id>/*.md   one issue draft per confirmed finding
state/issue-ledger.json  fingerprint -> issue URL
state/flaky-log.json     findings that did not reproduce 3/3
```

`run.json` is written after **every tool**, so a run that is interrupted after
four hours still has four hours of results.

---

## Flags

| Flag | Effect |
|---|---|
| `--category <slug>` / `--tools a,b,c` / `--file <path>` | scope (one is required) |
| `--headed` | watch the browser work |
| `--prod` | test a production build instead of dev (run `next build` first) |
| `--port <n>` | server port (default 4333) |
| `--keep-server` | leave the server up after the command |
| `--verbose` | stream the Next server log |
| `--confirm` | on `file-issues`, actually create them |
| `--repo <owner/name>` | override the target repo |
| `--only <substring>` | file just the drafts whose filename matches |

Environment: `QA_SITE` (where the site is checked out), `QA_PORT`, `QA_REPO`,
`QA_GH_BIN`, `QA_DEBUG`.

---

## Notes on this codebase

- **Dev server by default.** React's development build surfaces hydration
  mismatches and the site's own `RelatedTools` warning about unresolved slugs.
  `--prod` exists for checking what users actually get.
- **A fresh browser context per tool.** Several tools persist history to
  `localStorage`; without isolation one tool's state would leak into the next.
- **No test ids required.** Controls are located structurally, so nothing in the
  site has to change to make it testable.
- **The runner never edits the site.** HARD RULE 9.1 — QA observes and reports;
  fixing is a separate, explicitly requested task.
