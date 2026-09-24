# Spec file reference

One file per tool: `specs/<slug>.json`. It is the only thing that lets phase P4
catch a **wrong answer**, so the rules in `QA_RULES.md` Section 2 apply to every
line of it.

## Shape

```jsonc
{
  "slug": "acre-to-square-feet-converter",
  "version": 1,
  "authoredAt": "2026-09-24",

  // What the tool promises, quoted from its name/description/on-page copy/FAQ.
  // The contract is what you test against, not the implementation.
  "contractSource": "…",

  // Optional: the constant or formula the whole file rests on, stated once.
  "groundTruth": "…",

  "cases": [ /* see below */ ]
}
```

## A case

```jsonc
{
  "id": "five-acres",
  "note": "Why this case exists.",

  // REQUIRED. Where the expected value comes from, independent of the site's
  // code. A human must be able to re-verify it without reading logic.ts.
  // Rejected automatically: "same as logic.ts", "as implemented", anything
  // under 25 characters.
  "derivation": "Area scales linearly: 5 x 43,560 sq ft = 217,800 sq ft.",

  // Field reference -> value. See "Naming a field" below.
  "inputs": { "Acre value": "5" },

  // Buttons to press after filling, by label. Omit for live-updating tools.
  "click": ["Calculate"],

  // Extra settle time in ms when a tool animates or debounces slowly.
  "waitMs": 450,

  "expect": [ /* see below */ ]
}
```

## Naming a field

`inputs` keys and `click` entries are resolved against the live control
inventory, in this order:

1. the exact CSS path (what the runner prints in evidence)
2. the control's accessible name, exactly
3. its visible text, exactly
4. its placeholder, exactly
5. a unique substring of its name or text
6. an index form: `"input:0"`, `"select:1"`, `"number:2"`, `"button:0"`

Prefer the accessible name. Run `qa run --tools <slug>` once and read
`run.json` → `phases.P2.evidence.inventory` to see exactly what the page
exposes.

## Expectations

| type | fields | use |
|---|---|---|
| `number` | `near` **or** `index`, `value`, `unit`, `tolerance`, `window`, `occurrence` | the main tool — assert a labelled result |
| `numberAny` | `value`, `unit`, `tolerance` | the value appears somewhere in the output |
| `contains` | `value` | a string must be present |
| `notContains` | `value` | a string must be absent — **almost always wants `"scope": "produced"`** |
| `matches` | `value` (regex), `flags` | shape of an output, e.g. a hex colour |
| `noPoison` | — | no `NaN` / `Infinity` / `undefined` / `[object Object]` |

Every expectation also takes `severity` (default `S1-critical`), `what` (a
human phrasing), and `scope`.

### `scope`

| value | haystack |
|---|---|
| `live` (default) | the tool's interactive region |
| `page` | the whole `<main>`, including SEO copy |
| `produced` | only text this case's input actually created |

`produced` matters because many tools on this site print a **static reference
table** inside the tool region. A `notContains` against `live` will see that
table and fail for reasons that have nothing to do with the tool's logic.

### `near`, and why it is careful

`near` finds the number that belongs to a label. Labels repeat — "Square Feet"
appears in the `<h1>`, in the info banner, and on the result card — so the
matcher walks **every** occurrence and takes the first one with a number within
`window` characters (default 40). Use `occurrence: 1` to pin the second labelled
result when a tool genuinely shows two.

### Tolerance

```jsonc
"tolerance": { "abs": 0.01 }   // absolute
"tolerance": { "rel": 0.005 }  // relative, the default at 0.5%
```

Set it to what the tool's own display precision can express. A delta inside
display rounding is a note, not a bug (HARD RULE 5.4).

## What to cover per tool

At minimum:

1. **Nominal** — everyday use, a value whose answer you can state exactly.
2. **Different magnitude** — two or three orders of magnitude away, where comma
   grouping and float precision both show up.
3. **Fractional input** — proves the tool does not truncate before computing.
4. **Each unit or mode** — if the tool has a unit selector or a formula toggle,
   one case per branch.
5. **Zero or another meaningful edge** — legitimate input, not an error.

Round numbers are worth choosing deliberately: `1`, `5`, `100` make an incorrect
conversion factor visible at a glance, where `37.428` hides it.

## Validate before running

```bash
node bin/qa.mjs specs:check --category <slug>
```

It rejects a missing derivation, a derivation that restates the implementation,
a numeric expectation with no unit, and a `number` with neither `near` nor
`index`.
