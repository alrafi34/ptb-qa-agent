import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";
import { discover } from "./discover.mjs";
import { ensureDir, writeJson, readJson, truncate } from "./util.mjs";

/**
 * Correctness specs are the only thing that makes P4 meaningful, and HARD RULE
 * 2.1 says they may not be derived from the code under test. So this module
 * never generates expected values — it assembles the briefing Claude needs
 * (the tool's stated contract, its controls, and its implementation, clearly
 * labelled as the thing being judged) and then validates what comes back.
 */

const SPEC_VERSION = 1;

function readIf(p, max = 20000) {
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, "utf8");
  return s.length > max ? `${s.slice(0, max)}\n/* ...truncated (${s.length} bytes total)... */` : s;
}

/** The tool's public promise, taken from its config — never from logic.ts. */
function extractContract(configSrc) {
  if (!configSrc) return null;
  const pick = (re) => { const m = configSrc.match(re); return m ? m[1] : null; };
  const faq = [...configSrc.matchAll(/\{\s*q:\s*"((?:[^"\\]|\\.)*)"\s*,\s*a:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => ({ q: m[1].replace(/\\"/g, '"'), a: truncate(m[2].replace(/\\"/g, '"'), 700) }));
  const steps = [...configSrc.matchAll(/\{\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*text:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => ({ name: m[1], text: truncate(m[2].replace(/\\"/g, '"'), 400) }));
  return {
    name: pick(/\bname:\s*"((?:[^"\\]|\\.)*)"/),
    description: pick(/\bdescription:\s*"((?:[^"\\]|\\.)*)"/),
    seoTitle: pick(/title:\s*"((?:[^"\\]|\\.)*)"/),
    howToSteps: steps.slice(0, 8),
    // FAQ answers often state the formula and the constants the tool claims to
    // use. That is a statement of intent, and a spec may test against it.
    faq: faq.slice(0, 12),
  };
}

export function buildWorklist({ category = null, tools: only = null, includeExisting = false, out = null }) {
  const d = discover({ category, tools: only });
  const targets = d.selected.filter((t) => includeExisting || !t.hasSpec);

  const items = targets.map((t) => {
    const dir = t.sourceDir ? path.join(PATHS.site, t.sourceDir) : null;
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      url: t.url,
      route: t.route,
      sourceDir: t.sourceDir,
      files: t.files,
      specPath: path.relative(PATHS.root, t.specPath),
      hasSpec: t.hasSpec,
      contract: dir ? extractContract(readIf(path.join(dir, "config.ts"), 60000)) : null,
      // Provided so the derivation can be checked against what the tool claims
      // to compute. HARD RULE 2.1 — expected values may NOT be copied from here.
      implementation: dir ? readIf(path.join(dir, "logic.ts")) ?? readIf(path.join(dir, "utils.ts")) ?? null : null,
      typesSource: dir ? readIf(path.join(dir, "types.ts"), 6000) : null,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    scope: { category, tools: only },
    specVersion: SPEC_VERSION,
    reminder: [
      "HARD RULE 2.1 — never copy an expected value out of `implementation`. Derive it independently.",
      "HARD RULE 2.2 — every case needs a `derivation` a human can re-verify without the source.",
      "HARD RULE 2.3 — when the implementation disagrees with `contract`, the contract wins and that IS the bug.",
      "HARD RULE 2.4 — label every input and expected output with its unit.",
    ],
    count: items.length,
    items,
  };

  const file = out ?? path.join(PATHS.reports, "_worklists", `specs-${category ?? "custom"}-${Date.now()}.json`);
  ensureDir(path.dirname(file));
  writeJson(file, payload);
  return { file: path.relative(PATHS.root, file), count: items.length, slugs: items.map((i) => i.slug) };
}

/* ------------------------------------------------------------ validation */

const EXPECT_TYPES = new Set(["contains", "notContains", "matches", "number", "numberAny", "noPoison"]);
const BAD_DERIVATION = /^(same as|as implemented|matches (the )?(logic|code|implementation)|from the code|per the code|what the tool (returns|outputs)|trust(ing)? the code)/i;

export function validateSpec(spec, slug) {
  const problems = [];
  if (!spec || typeof spec !== "object") return ["spec is not an object"];
  if (spec.slug && slug && spec.slug !== slug) problems.push(`slug mismatch: file says ${spec.slug}, expected ${slug}`);
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) problems.push("no cases");

  for (const [i, tc] of (spec.cases ?? []).entries()) {
    const id = tc.id ?? `case-${i + 1}`;
    if (!tc.inputs || typeof tc.inputs !== "object") problems.push(`${id}: no inputs object`);
    if (!Array.isArray(tc.expect) || !tc.expect.length) problems.push(`${id}: no expectations`);

    const der = String(tc.derivation ?? "").trim();
    if (!der) problems.push(`${id}: missing derivation (HARD RULE 2.2)`);
    else if (BAD_DERIVATION.test(der)) problems.push(`${id}: derivation restates the implementation — "${truncate(der, 60)}" (HARD RULE 2.1)`);
    else if (der.length < 25) problems.push(`${id}: derivation too thin to re-verify — "${der}"`);

    for (const [j, e] of (tc.expect ?? []).entries()) {
      if (!EXPECT_TYPES.has(e.type)) problems.push(`${id}/expect[${j}]: unknown type ${JSON.stringify(e.type)}`);
      if ((e.type === "number" || e.type === "numberAny")) {
        if (typeof e.value !== "number" || !Number.isFinite(e.value)) problems.push(`${id}/expect[${j}]: number expectation needs a finite \`value\``);
        if (!e.unit && !/count|ratio|index|score|percent|%/i.test(String(e.label ?? e.near ?? ""))) {
          problems.push(`${id}/expect[${j}]: numeric expectation has no \`unit\` (HARD RULE 2.4)`);
        }
        if (e.type === "number" && e.near == null && e.index == null) {
          problems.push(`${id}/expect[${j}]: \`number\` needs \`near\` (a label on the page) or \`index\``);
        }
      }
      if ((e.type === "contains" || e.type === "notContains" || e.type === "matches") && e.value == null) {
        problems.push(`${id}/expect[${j}]: needs a \`value\``);
      }
    }
  }
  return problems;
}

export function validateAllSpecs({ category = null, tools: only = null } = {}) {
  const d = discover({ category, tools: only });
  const out = [];
  for (const t of d.selected) {
    if (!t.hasSpec) { out.push({ slug: t.slug, status: "missing" }); continue; }
    const spec = readJson(t.specPath);
    const problems = validateSpec(spec, t.slug);
    out.push({
      slug: t.slug,
      status: problems.length ? "invalid" : "ok",
      cases: spec?.cases?.length ?? 0,
      problems,
    });
  }
  return out;
}

export const SPEC_TEMPLATE = {
  $schema: "./_schema.md",
  slug: "<tool-slug>",
  version: SPEC_VERSION,
  authoredAt: "<ISO date>",
  contractSource: "What the tool promises, quoted from its name/description/FAQ.",
  cases: [
    {
      id: "nominal",
      note: "Plain, everyday use of the tool.",
      derivation:
        "REQUIRED. Where the expected number comes from, independent of the site's code. " +
        "Example: '1 international acre is defined as 43,560 square feet (US survey / international " +
        "agreement). 5 x 43,560 = 217,800.'",
      inputs: { "<field label, placeholder, or input:0>": "5" },
      click: [],
      waitMs: 450,
      expect: [
        { type: "number", near: "Square Feet", value: 217800, unit: "sq ft", tolerance: { rel: 0.0001 }, severity: "S1-critical" },
        { type: "noPoison" },
      ],
    },
  ],
};
