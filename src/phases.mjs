import { POISON_PATTERNS, VIEWPORTS, LIMITS } from "./config.mjs";
import { hardErrors, hydrationErrors, openTool } from "./browser.mjs";
import {
  inventory, snapshot, liveText, pageMeta, overflowReport, a11yReport, addedText,
} from "./dom.mjs";
import {
  setControl, clickControl, readControl, probeValueFor, boundaryCasesFor, classifyAction,
} from "./interact.mjs";
import { normaliseText, parseNumber, parseAllNumbers, withinTolerance, truncate, sleep } from "./util.mjs";

/**
 * The ten phases from QA_RULES.md Section 4. Every phase always runs and always
 * records a verdict; HARD RULE 8.1 forbids reporting a phase that did not
 * execute as a pass.
 */

const PASS = "pass";
const FAIL = "fail";
const WARN = "warn";
const SKIP = "skipped";

function finding(o) {
  return {
    id: o.id,
    phase: o.phase,
    severity: o.severity,
    summary: o.summary,
    assertion: o.assertion ?? null,
    expected: o.expected ?? null,
    actual: o.actual ?? null,
    derivation: o.derivation ?? null,
    steps: o.steps ?? [],
    detail: o.detail ?? null,
    control: o.control ?? null,
  };
}

/* ------------------------------------------------------------------ P1 */

export async function p1_render(ctx) {
  const { session, tool } = ctx;
  const findings = [];
  const { status, navError, diagnostics } = session;

  if (navError) {
    findings.push(finding({
      id: "P1/navigation", phase: "P1", severity: "S1-critical",
      summary: `Navigation to ${tool.url} failed: ${navError}`,
      expected: "page loads", actual: navError,
      steps: [`Open ${tool.url}`],
    }));
    return { phase: "P1", verdict: FAIL, findings, blocking: true, evidence: { status, navError } };
  }

  if (status == null || status >= 400) {
    findings.push(finding({
      id: "P1/status", phase: "P1", severity: "S1-critical",
      summary: `${tool.url} returned HTTP ${status}`,
      expected: "HTTP 200", actual: `HTTP ${status}`,
      detail: tool.route === "unrouted"
        ? "This slug is listed in config/tools.ts but has neither a dedicated route directory nor an entry in the dynamic route's TOOLS array, so no page can be produced for it."
        : null,
      steps: [`Open ${tool.url}`],
    }));
    return { phase: "P1", verdict: FAIL, findings, blocking: true, evidence: { status } };
  }

  const meta = await pageMeta(session.page);
  if (meta.is404) {
    findings.push(finding({
      id: "P1/notfound", phase: "P1", severity: "S1-critical",
      summary: `${tool.url} renders the not-found page despite HTTP ${status}`,
      expected: `an <h1> naming "${tool.name}"`, actual: `h1: ${JSON.stringify(meta.h1)}`,
      steps: [`Open ${tool.url}`],
    }));
    return { phase: "P1", verdict: FAIL, findings, blocking: true, evidence: { status, meta } };
  }

  const pageErrs = diagnostics.pageErrors;
  for (const e of pageErrs) {
    findings.push(finding({
      id: `P1/pageerror/${e.message.slice(0, 40)}`, phase: "P1", severity: "S1-critical",
      summary: `Uncaught exception on load: ${e.message}`,
      expected: "no uncaught exceptions", actual: e.message, detail: e.stack,
      steps: [`Open ${tool.url}`, "Watch the browser console"],
    }));
  }

  const hyd = hydrationErrors(diagnostics);
  for (const h of hyd) {
    findings.push(finding({
      id: `P1/hydration/${h.slice(0, 40)}`, phase: "P1", severity: "S2-major",
      summary: "React hydration mismatch between server and client render",
      expected: "server HTML matches client render", actual: truncate(h, 400),
      steps: [`Open ${tool.url}`, "Watch the browser console during hydration"],
    }));
  }

  for (const ce of diagnostics.console.filter((x) => x.type === "error")) {
    findings.push(finding({
      id: `P1/console/${ce.text.slice(0, 40)}`, phase: "P1", severity: "S2-major",
      summary: `console.error on load: ${truncate(ce.text, 160)}`,
      expected: "a clean console", actual: truncate(ce.text, 400),
      detail: ce.location ? `${ce.location.url}:${ce.location.lineNumber}` : null,
      steps: [`Open ${tool.url}`],
    }));
  }

  for (const rf of diagnostics.responses.filter((r) => !/favicon|\/og\?/.test(r.url))) {
    findings.push(finding({
      id: `P1/subresource/${rf.status}/${rf.url.slice(-30)}`, phase: "P1", severity: "S3-minor",
      summary: `Sub-resource returned HTTP ${rf.status}`,
      expected: "all sub-resources load", actual: `${rf.status} ${rf.url}`,
      steps: [`Open ${tool.url}`, "Check the network panel"],
    }));
  }

  const h1ok = meta.h1.length === 1;
  if (!h1ok) {
    findings.push(finding({
      id: "P1/h1", phase: "P1", severity: "S3-minor",
      summary: meta.h1.length === 0 ? "Page has no <h1>" : `Page has ${meta.h1.length} <h1> elements`,
      expected: "exactly one <h1>", actual: JSON.stringify(meta.h1),
      steps: [`Open ${tool.url}`],
    }));
  }

  return {
    phase: "P1",
    verdict: findings.some((f) => f.severity === "S1-critical") ? FAIL : findings.length ? WARN : PASS,
    findings,
    blocking: false,
    evidence: { status, meta },
  };
}

/* ------------------------------------------------------------------ P2 */

export async function p2_controls(ctx) {
  const { session, tool } = ctx;
  const findings = [];
  const controls = await inventory(session.page);
  const inputs = controls.filter((c) => c.kind === "input" && c.visible && !c.disabled && !c.readOnly);
  const actions = controls.filter((c) => c.kind === "action" && c.visible);

  if (controls.length === 0) {
    findings.push(finding({
      id: "P2/no-controls", phase: "P2", severity: "S1-critical",
      summary: "No interactive controls found on the page — the tool UI did not mount",
      expected: "at least one input or button", actual: "0 controls in <main>",
      steps: [`Open ${tool.url}`, "Look for the tool UI below the heading"],
    }));
  } else if (inputs.length === 0 && actions.filter((a) => classifyAction(a) !== "other").length === 0) {
    findings.push(finding({
      id: "P2/no-inputs", phase: "P2", severity: "S2-major",
      summary: "Tool renders but exposes no usable input control",
      expected: "at least one enabled input", actual: `${controls.length} controls, none enabled/usable`,
      detail: JSON.stringify(controls.slice(0, 8).map((c) => ({ tag: c.tag, type: c.type, name: c.name, disabled: c.disabled })), null, 2),
      steps: [`Open ${tool.url}`],
    }));
  }

  for (const c of controls.filter((c) => c.visible && c.disabled && c.kind === "input")) {
    findings.push(finding({
      id: `P2/disabled/${c.selector}`, phase: "P2", severity: "S3-minor",
      summary: `Input "${c.name || c.type}" is rendered disabled with no obvious reason`,
      expected: "input is usable on load", actual: "disabled",
      control: c, steps: [`Open ${tool.url}`],
    }));
  }

  return {
    phase: "P2",
    verdict: findings.some((f) => f.severity === "S1-critical") ? FAIL : findings.length ? WARN : PASS,
    findings,
    controls,
    evidence: {
      total: controls.length,
      inputs: inputs.length,
      actions: actions.length,
      inventory: controls.map((c) => ({
        selector: c.selector, tag: c.tag, type: c.type, name: c.name,
        kind: c.kind, min: c.min, max: c.max, step: c.step, disabled: c.disabled,
        options: c.options ? c.options.length : null,
      })),
    },
  };
}

/* ------------------------------------------------------------------ P3 */

/** Every input must demonstrably move the output. A dead control is a defect. */
export async function p3_liveLogic(ctx, controls) {
  const { session, tool } = ctx;
  const findings = [];
  const page = session.page;
  const inputs = controls.filter((c) => c.kind === "input" && c.visible && !c.disabled && !c.readOnly && c.type !== "file");
  const computeButtons = controls.filter((c) => c.kind === "action" && c.visible && classifyAction(c) === "compute");
  const results = [];

  if (!inputs.length) {
    return { phase: "P3", verdict: SKIP, findings, evidence: { reason: "no drivable inputs" } };
  }

  // Fill every input once so the tool has a complete, valid state to work from.
  for (const c of inputs) {
    const v = probeValueFor(c, 0);
    if (v === null) continue;
    await setControl(page, c, v);
  }
  for (const b of computeButtons) await clickControl(page, b);
  await sleep(LIMITS.settleMs);

  const baseline = await snapshot(page);
  if (!normaliseText(baseline.live)) {
    findings.push(finding({
      id: "P3/empty-output", phase: "P3", severity: "S2-major",
      summary: "Tool produced no visible output after every input was filled with a valid value",
      expected: "a result region with content", actual: "(empty)",
      steps: [`Open ${tool.url}`, ...inputs.map((c) => `Set "${c.name || c.type}" to ${probeValueFor(c, 0)}`)],
    }));
  }

  // Now change one input at a time and require the output to move.
  for (const c of inputs) {
    const before = await snapshot(page);
    const v1 = probeValueFor(c, 1);
    if (v1 === null) continue;
    const prevValue = await readControl(page, c.selector);
    const set = await setControl(page, c, v1);
    if (!set.ok) {
      findings.push(finding({
        id: `P3/unsettable/${c.selector}`, phase: "P3", severity: "S2-major",
        summary: `Could not enter a value into "${c.name || c.type}": ${set.error ?? set.skipped}`,
        expected: `field accepts ${JSON.stringify(v1)}`, actual: set.error ?? set.skipped,
        control: c, steps: [`Open ${tool.url}`, `Type ${JSON.stringify(v1)} into "${c.name || c.type}"`],
      }));
      continue;
    }
    const actualValue = await readControl(page, c.selector);
    if (c.type !== "checkbox" && c.type !== "radio" && c.tag !== "select" &&
        normaliseText(actualValue) === normaliseText(prevValue) && String(v1) !== String(prevValue)) {
      findings.push(finding({
        id: `P3/value-rejected/${c.selector}`, phase: "P3", severity: "S2-major",
        summary: `Field "${c.name || c.type}" silently discarded the typed value`,
        expected: `field holds ${JSON.stringify(String(v1))}`, actual: JSON.stringify(actualValue),
        control: c, steps: [`Open ${tool.url}`, `Type ${JSON.stringify(v1)} into "${c.name || c.type}"`, "Read the field back"],
      }));
    }
    for (const b of computeButtons) await clickControl(page, b);
    const after = await snapshot(page);

    const changed = normaliseText(before.live) !== normaliseText(after.live) ||
                    normaliseText(before.main) !== normaliseText(after.main) ||
                    before.canvasCount !== after.canvasCount ||
                    before.imgCount !== after.imgCount ||
                    JSON.stringify(before.downloadHrefs) !== JSON.stringify(after.downloadHrefs);

    results.push({ control: c.name || c.selector, from: prevValue, to: String(v1), changed });

    if (!changed) {
      findings.push(finding({
        id: `P3/dead-control/${c.selector}`, phase: "P3", severity: "S2-major",
        summary: `Changing "${c.name || c.type}" from ${JSON.stringify(prevValue)} to ${JSON.stringify(String(v1))} produced no change anywhere in the output`,
        expected: "output reflects the new input", actual: "output byte-identical before and after",
        control: c,
        detail: `Output region after change (first 400 chars):\n${truncate(after.live, 400)}`,
        steps: [
          `Open ${tool.url}`,
          `Note the current result`,
          `Change "${c.name || c.type}" to ${JSON.stringify(String(v1))}`,
          computeButtons.length ? `Press "${computeButtons[0].name || computeButtons[0].text}"` : "Wait for the result to update",
          "The result is unchanged",
        ],
      }));
    }
  }

  return {
    phase: "P3",
    verdict: findings.some((f) => f.severity === "S1-critical" || f.severity === "S2-major") ? FAIL : findings.length ? WARN : PASS,
    findings,
    evidence: { probed: results, baselineOutput: truncate(baseline.live, 1200) },
  };
}

/* ------------------------------------------------------------------ P4 */

/**
 * Golden-case replay. Expected values come only from spec files, which carry an
 * independent derivation per HARD RULE 2.2 — nothing here consults the site's
 * own logic.
 */
export async function p4_specs(ctx, controls) {
  const { session, tool, spec } = ctx;
  const page = session.page;
  const findings = [];
  const caseResults = [];

  if (!spec || !Array.isArray(spec.cases) || spec.cases.length === 0) {
    return {
      phase: "P4", verdict: SKIP, findings,
      evidence: { reason: `no spec file at specs/${tool.slug}.json — correctness was NOT verified` },
    };
  }

  for (const [i, tc] of spec.cases.entries()) {
    const caseId = tc.id ?? `case-${i + 1}`;

    // HARD RULE 2.2 — a case with no derivation is rejected, not run.
    if (!tc.derivation || !String(tc.derivation).trim() ||
        /^(same as|as implemented|matches logic|from the code|per the code)/i.test(String(tc.derivation).trim())) {
      findings.push(finding({
        id: `P4/invalid-spec/${caseId}`, phase: "P4", severity: "S4-note",
        summary: `Spec case "${caseId}" has no independent derivation and was rejected before running`,
        expected: "a derivation citing a standard, formula, or hand computation",
        actual: JSON.stringify(tc.derivation ?? null),
        detail: "QA_RULES.md HARD RULE 2.2 — a spec that restates the implementation proves nothing.",
      }));
      caseResults.push({ caseId, verdict: "rejected-spec" });
      continue;
    }

    // Reset to a clean page state so cases cannot contaminate each other.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(LIMITS.settleMs);
    // Baseline before any input. Several tools print a static reference table
    // inside the tool region, so the only text that is certainly this case's
    // own output is the text that was not there beforehand.
    const baselineText = normaliseText(await liveText(page));
    let fresh = await inventory(page);

    const steps = [`Open ${tool.url}`];
    let setupOk = true;

    for (const [field, value] of Object.entries(tc.inputs ?? {})) {
      let ctl = resolveControl(fresh, field);
      if (!ctl) {
        // A field that only mounts after an earlier input (a mode select, a
        // unit toggle) is not in the inventory taken before filling began.
        await sleep(LIMITS.settleMs);
        fresh = await inventory(page);
        ctl = resolveControl(fresh, field);
      }
      if (!ctl) {
        findings.push(finding({
          id: `P4/missing-field/${caseId}/${field}`, phase: "P4", severity: "S2-major",
          summary: `Spec case "${caseId}" targets a field the page does not expose: ${JSON.stringify(field)}`,
          expected: `a control matching ${JSON.stringify(field)}`,
          actual: `available: ${fresh.filter((c) => c.kind === "input").map((c) => c.name || c.type).join(" | ") || "(none)"}`,
          steps,
        }));
        setupOk = false;
        break;
      }
      const r = await setControl(page, ctl, value);
      if (!r.ok) {
        findings.push(finding({
          id: `P4/unsettable/${caseId}/${field}`, phase: "P4", severity: "S2-major",
          summary: `Could not set ${JSON.stringify(field)} to ${JSON.stringify(value)}: ${r.error ?? r.skipped}`,
          expected: "field accepts the value", actual: r.error ?? r.skipped, steps,
        }));
        setupOk = false;
        break;
      }
      steps.push(`Set "${ctl.name || field}" to ${JSON.stringify(String(value))}`);
    }
    if (!setupOk) { caseResults.push({ caseId, verdict: "setup-failed" }); continue; }

    for (const label of tc.click ?? []) {
      let btn = resolveControl(fresh, label, "action");
      if (!btn) {
        fresh = await inventory(page);
        btn = resolveControl(fresh, label, "action");
      }
      if (btn) { await clickControl(page, btn); steps.push(`Click "${btn.name || btn.text}"`); }
    }
    await sleep(tc.waitMs ?? LIMITS.settleMs);

    const out = await liveText(page);
    const full = await snapshot(page);
    const haystack = normaliseText(`${out} ${full.main}`);
    const produced = addedText(baselineText, normaliseText(out));
    const caseFindings = [];

    for (const exp of tc.expect ?? []) {
      const res = evaluateExpectation(exp, { live: normaliseText(out), full: haystack, produced });
      if (!res.ok) {
        caseFindings.push(finding({
          id: `P4/${caseId}/${exp.id ?? exp.type}`, phase: "P4",
          severity: exp.severity ?? "S1-critical",
          summary: `${tool.name}: ${exp.what ?? res.what}`,
          assertion: `${caseId} / ${exp.type}`,
          expected: res.expected, actual: res.actual,
          derivation: tc.derivation,
          detail: `Rendered output read from the page:\n${truncate(out, 900)}`,
          steps: [...steps, `Read "${exp.what ?? exp.type}" from the result area`],
        }));
      }
    }
    findings.push(...caseFindings);
    caseResults.push({
      caseId,
      verdict: caseFindings.length ? "fail" : "pass",
      inputs: tc.inputs,
      derivation: tc.derivation,
      output: truncate(out, 500),
    });
  }

  const failed = findings.some((f) => f.severity === "S1-critical" || f.severity === "S2-major");
  return {
    phase: "P4",
    verdict: failed ? FAIL : findings.length ? WARN : PASS,
    findings,
    evidence: { specVersion: spec.version ?? null, cases: caseResults },
  };
}

/** Match a spec's field reference against the live control inventory. */
function resolveControl(controls, ref, kind = null) {
  const pool = kind ? controls.filter((c) => c.kind === kind) : controls;
  const wanted = String(ref).toLowerCase().trim();

  const bySelector = pool.find((c) => c.selector === ref);
  if (bySelector) return bySelector;

  const exact = pool.find((c) => (c.name || "").toLowerCase().trim() === wanted);
  if (exact) return exact;

  const exactText = pool.find((c) => (c.text || "").toLowerCase().trim() === wanted);
  if (exactText) return exactText;

  const byPlaceholder = pool.find((c) => (c.placeholder || "").toLowerCase().trim() === wanted);
  if (byPlaceholder) return byPlaceholder;

  const partial = pool.filter((c) =>
    (c.name || "").toLowerCase().includes(wanted) || (c.text || "").toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return partial.find((c) => c.kind === "input") ?? partial[0];

  // index form: "input:0", "select:1"
  const m = wanted.match(/^(input|select|textarea|number|text|range|checkbox|button):(\d+)$/);
  if (m) {
    const [, what, idxStr] = m;
    const idx = Number(idxStr);
    const filtered = what === "input"
      ? controls.filter((c) => c.kind === "input")
      : what === "button"
        ? controls.filter((c) => c.kind === "action")
        : controls.filter((c) => c.tag === what || c.type === what);
    return filtered[idx] ?? null;
  }
  return null;
}

/**
 * One expectation from a spec case, evaluated against what the page rendered.
 *
 * `scope` picks the haystack:
 *   "live"     (default) the tool's interactive region
 *   "page"     the whole <main>, for things like SEO copy
 *   "produced" only text this case's input actually created — use it for
 *              notContains, where a static reference table in the tool region
 *              would otherwise make the assertion unsatisfiable
 */
function evaluateExpectation(exp, text) {
  const hay = exp.scope === "page" ? text.full
    : exp.scope === "produced" ? (text.produced ?? "")
    : text.live;

  switch (exp.type) {
    case "contains": {
      const ok = hay.toLowerCase().includes(String(exp.value).toLowerCase());
      return { ok, what: `output should contain ${JSON.stringify(exp.value)}`, expected: exp.value, actual: ok ? exp.value : truncate(hay, 400) };
    }
    case "notContains": {
      const ok = !hay.toLowerCase().includes(String(exp.value).toLowerCase());
      return { ok, what: `output should not contain ${JSON.stringify(exp.value)}`, expected: `absent: ${exp.value}`, actual: ok ? "absent" : `present in: ${truncate(hay, 300)}` };
    }
    case "matches": {
      const re = new RegExp(exp.value, exp.flags ?? "i");
      const ok = re.test(hay);
      return { ok, what: `output should match /${exp.value}/`, expected: `/${exp.value}/`, actual: ok ? "matched" : truncate(hay, 400) };
    }
    case "number": {
      // Find the labelled number, or fall back to the nth number in the output.
      const found = exp.near
        ? numberNear(hay, exp.near, { window: exp.window ?? 40, occurrence: exp.occurrence ?? null })
        : parseAllNumbers(hay)[exp.index ?? 0] ?? null;
      const ok = withinTolerance(found, exp.value, exp.tolerance);
      const alts = exp.near ? numbersNearAll(hay, exp.near, exp.window ?? 40) : [];
      return {
        ok,
        what: `${exp.label ?? exp.near ?? "result"} should be ${exp.value}${exp.unit ? " " + exp.unit : ""}`,
        expected: `${exp.value}${exp.unit ? " " + exp.unit : ""}${exp.tolerance ? ` (tolerance ${JSON.stringify(exp.tolerance)})` : ""}`,
        actual: found == null
          ? `no number found within ${exp.window ?? 40} chars of ${JSON.stringify(exp.near ?? `index ${exp.index ?? 0}`)} in: ${truncate(hay, 400)}`
          : `${found}${exp.unit ? " " + exp.unit : ""}${alts.length > 1 ? ` (all values labelled "${exp.near}": ${alts.join(", ")})` : ""}`,
      };
    }
    case "numberAny": {
      const all = parseAllNumbers(hay);
      const ok = all.some((n) => withinTolerance(n, exp.value, exp.tolerance));
      return {
        ok, what: `output should contain the value ${exp.value}${exp.unit ? " " + exp.unit : ""}`,
        expected: `${exp.value}${exp.unit ? " " + exp.unit : ""}`,
        actual: ok ? String(exp.value) : `numbers present: ${all.slice(0, 20).join(", ") || "(none)"}`,
      };
    }
    case "noPoison": {
      const hit = POISON_PATTERNS.find((p) => p.re.test(hay));
      return { ok: !hit, what: "output must not leak a non-value", expected: "no NaN/Infinity/undefined", actual: hit ? `${hit.label} in: ${truncate(hay, 300)}` : "clean" };
    }
    default:
      return { ok: false, what: `unknown expectation type ${JSON.stringify(exp.type)}`, expected: "a valid expectation type", actual: exp.type };
  }
}

/**
 * The number a human would read as belonging to `label`.
 *
 * Labels repeat on these pages — "Square Feet" is in the <h1>, in the info
 * banner, and on the result card — so a plain indexOf finds the heading and
 * reads whatever number happens to follow it. Instead, walk every occurrence
 * and take the first one that has a number close enough after it to be its
 * value. `occurrence` pins a specific one when a tool genuinely repeats a
 * labelled result.
 */
function numberNear(text, label, { window = 40, occurrence = null } = {}) {
  const hay = text.toLowerCase();
  const needle = String(label).toLowerCase();
  const candidates = [];

  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    from = i + needle.length;
    const after = text.slice(from, from + window);
    const n = parseNumber(after);
    if (n != null) candidates.push({ at: i, value: n, context: after.trim().slice(0, 40) });
  }

  if (occurrence != null) return candidates[occurrence]?.value ?? null;
  if (candidates.length) return candidates[0].value;

  // Some layouts put the value above its caption ("217,800" then "sq ft").
  const i = hay.indexOf(needle);
  if (i < 0) return null;
  const before = text.slice(Math.max(0, i - window), i);
  const nums = parseAllNumbers(before);
  return nums.length ? nums[nums.length - 1] : null;
}

/** Every labelled candidate, for reporting when the expectation fails. */
function numbersNearAll(text, label, window = 40) {
  const hay = text.toLowerCase();
  const needle = String(label).toLowerCase();
  const out = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    from = i + needle.length;
    const n = parseNumber(text.slice(from, from + window));
    if (n != null) out.push(n);
  }
  return out;
}

/* ------------------------------------------------------------------ P5 */

export async function p5_boundaries(ctx, controls) {
  const { session, tool } = ctx;
  const page = session.page;
  const findings = [];
  const tried = [];
  const inputs = controls.filter((c) => c.kind === "input" && c.visible && !c.disabled && !c.readOnly && c.type !== "file");
  const computeButtons = controls.filter((c) => c.kind === "action" && c.visible && classifyAction(c) === "compute");

  if (!inputs.length) return { phase: "P5", verdict: SKIP, findings, evidence: { reason: "no drivable inputs" } };

  for (const c of inputs) {
    const cases = boundaryCasesFor(c);
    if (!cases.length) continue;

    for (const bc of cases) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(LIMITS.settleMs);
      const fresh = await inventory(page);
      const live = fresh.find((f) => f.selector === c.selector) ?? fresh.find((f) => f.name === c.name);
      if (!live) break;

      // Give the other inputs valid values so the tool has a complete state and
      // the only variable is the boundary value under test.
      for (const other of fresh.filter((f) => f.kind === "input" && f.selector !== live.selector && f.visible && !f.disabled && f.type !== "file")) {
        const v = probeValueFor(other, 0);
        if (v !== null) await setControl(page, other, v);
      }
      const errBefore = session.diagnostics.pageErrors.length;
      await setControl(page, live, bc.value);
      for (const b of computeButtons) {
        const btn = fresh.find((f) => f.selector === b.selector);
        if (btn) await clickControl(page, btn);
      }
      await sleep(LIMITS.settleMs);

      const out = await liveText(page);
      const poison = POISON_PATTERNS.find((p) => p.re.test(out));
      const threw = session.diagnostics.pageErrors.length > errBefore;
      tried.push({ control: c.name || c.selector, case: bc.label, value: truncate(bc.value, 40), poison: poison?.label ?? null, threw });

      const steps = [
        `Open ${tool.url}`,
        ...fresh.filter((f) => f.kind === "input" && f.selector !== live.selector && f.visible && !f.disabled && f.type !== "file")
          .map((f) => `Set "${f.name || f.type}" to ${JSON.stringify(String(probeValueFor(f, 0)))}`),
        `Set "${c.name || c.type}" to ${JSON.stringify(truncate(bc.value, 60))} (${bc.label})`,
      ];

      if (poison) {
        findings.push(finding({
          id: `P5/poison/${c.selector}/${bc.label}`, phase: "P5", severity: "S2-major",
          summary: `"${bc.label}" input into "${c.name || c.type}" renders ${poison.label} to the user`,
          expected: "a validation message or a blank result", actual: `${poison.label} shown in the output`,
          control: c, detail: `Output:\n${truncate(out, 500)}`, steps,
        }));
      }
      if (threw) {
        const last = session.diagnostics.pageErrors.at(-1);
        findings.push(finding({
          id: `P5/throw/${c.selector}/${bc.label}`, phase: "P5", severity: "S1-critical",
          summary: `"${bc.label}" input into "${c.name || c.type}" throws an uncaught exception`,
          expected: "input is handled without throwing", actual: last?.message ?? "uncaught exception",
          control: c, detail: last?.stack ?? null, steps,
        }));
      }
      if (bc.label === "negative" && !poison) {
        const nums = parseAllNumbers(out);
        const hasNegativeResult = nums.some((n) => n < 0);
        const rejects = /invalid|must|cannot|positive|greater than|enter a valid|negative/i.test(out);
        if (hasNegativeResult && !rejects && isPhysicalQuantity(tool)) {
          findings.push(finding({
            id: `P5/negative-accepted/${c.selector}`, phase: "P5", severity: "S3-minor",
            summary: `Negative input into "${c.name || c.type}" produces a negative physical result with no validation message`,
            expected: "a validation message, since this quantity cannot be negative",
            actual: `result contains ${nums.filter((n) => n < 0).slice(0, 3).join(", ")}`,
            control: c, detail: `Output:\n${truncate(out, 400)}`, steps,
          }));
        }
      }
    }
  }

  return {
    phase: "P5",
    verdict: findings.some((f) => /S1|S2/.test(f.severity)) ? FAIL : findings.length ? WARN : PASS,
    findings,
    evidence: { cases: tried },
  };
}

/** Quantities that are physically non-negative — length, area, mass, power, cost. */
function isPhysicalQuantity(tool) {
  return /area|length|volume|weight|mass|distance|power|energy|cost|price|load|current|voltage|resistance|flow|pressure|speed|size|capacity|quantity|count/i
    .test(`${tool.name} ${tool.description}`);
}

/* ------------------------------------------------------------------ P6 */

export async function p6_invariants(ctx, controls) {
  const { session, tool } = ctx;
  const page = session.page;
  const findings = [];

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(LIMITS.settleMs);
  const fresh = await inventory(page);

  const before = await liveText(page);
  const inputs = fresh.filter((c) => c.kind === "input" && c.visible && !c.disabled && !c.readOnly && c.type !== "file");
  for (const c of inputs) {
    const v = probeValueFor(c, 0);
    if (v !== null) await setControl(page, c, v);
  }
  for (const b of fresh.filter((c) => c.kind === "action" && c.visible && classifyAction(c) === "compute")) {
    await clickControl(page, b);
  }
  await sleep(LIMITS.settleMs);
  const after = await liveText(page);

  // Scan both the live region and, specifically, the text the interaction
  // produced — the latter is by construction the tool's own output.
  const produced = addedText(before, after);
  for (const target of [{ label: "live output region", text: after }, { label: "newly produced output", text: produced }]) {
    for (const p of POISON_PATTERNS) {
      if (!p.re.test(target.text)) continue;
      const m = target.text.match(p.re);
      const idx = target.text.indexOf(m[0]);
      findings.push(finding({
        id: `P6/${p.id}/${target.label}`, phase: "P6", severity: p.id === "placeholder" ? "S3-minor" : "S2-major",
        summary: `${p.label} is rendered in the ${target.label} for ordinary valid input`,
        expected: `no ${p.label} in rendered output`,
        actual: truncate(target.text.slice(Math.max(0, idx - 80), idx + 120), 220),
        detail: `Full output region:\n${truncate(after, 700)}`,
        steps: [
          `Open ${tool.url}`,
          ...inputs.map((c) => `Set "${c.name || c.type}" to ${JSON.stringify(String(probeValueFor(c, 0)))}`),
          "Read the result area",
        ],
      }));
      break; // one finding per pattern per target
    }
  }

  return {
    phase: "P6",
    verdict: findings.some((f) => /S1|S2/.test(f.severity)) ? FAIL : findings.length ? WARN : PASS,
    findings,
    evidence: { output: truncate(after, 1200), produced: truncate(produced, 600) },
  };
}

/* ------------------------------------------------------------------ P7 */

export async function p7_stateActions(ctx, controls) {
  const { session, tool } = ctx;
  const page = session.page;
  const findings = [];
  const checked = [];

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(LIMITS.settleMs);
  let fresh = await inventory(page);

  const inputs = fresh.filter((c) => c.kind === "input" && c.visible && !c.disabled && !c.readOnly && c.type !== "file");
  const pristine = await page.evaluate(() => window.__qa.controlValues());

  for (const c of inputs) {
    const v = probeValueFor(c, 0);
    if (v !== null) await setControl(page, c, v);
  }
  for (const b of fresh.filter((c) => c.kind === "action" && c.visible && classifyAction(c) === "compute")) {
    await clickControl(page, b);
  }
  await sleep(LIMITS.settleMs);
  const filledOutput = await liveText(page);

  fresh = await inventory(page);
  const actions = fresh.filter((c) => c.kind === "action" && c.visible && !c.disabled);

  // --- reset / clear
  for (const btn of actions.filter((a) => classifyAction(a) === "reset")) {
    await clickControl(page, btn);
    await sleep(LIMITS.settleMs);
    const afterValues = await page.evaluate(() => window.__qa.controlValues());
    const stillSet = Object.entries(afterValues).filter(([sel, v]) => {
      const was = pristine[sel];
      return was !== undefined && v !== was && v !== "" && v !== "false";
    });
    checked.push({ action: "reset", label: btn.name || btn.text, cleared: stillSet.length === 0 });
    if (stillSet.length) {
      findings.push(finding({
        id: `P7/reset/${btn.selector}`, phase: "P7", severity: "S2-major",
        summary: `"${btn.name || btn.text}" does not restore the tool to its initial state`,
        expected: "every field returns to its value on page load",
        actual: stillSet.slice(0, 5).map(([sel, v]) => `${sel} = ${JSON.stringify(v)} (was ${JSON.stringify(pristine[sel])})`).join("; "),
        control: btn,
        steps: [`Open ${tool.url}`, "Fill every field with a valid value", `Click "${btn.name || btn.text}"`, "Check the fields"],
      }));
    }
    // Put the filled state back for the remaining checks.
    for (const c of inputs) { const v = probeValueFor(c, 0); if (v !== null) await setControl(page, c, v); }
    await sleep(LIMITS.settleMs);
  }

  // --- copy
  for (const btn of actions.filter((a) => classifyAction(a) === "copy")) {
    // The Clipboard API needs the page focused, and it can be unavailable
    // outright. Establish that we can both write and read the sentinel before
    // trusting anything this check observes — otherwise a harness limitation
    // would be reported as a broken Copy button.
    await page.bringToFront().catch(() => {});
    let clipboardUsable = false;
    try {
      await page.evaluate(() => navigator.clipboard.writeText("__qa_sentinel__"));
      clipboardUsable = (await page.evaluate(() => navigator.clipboard.readText())) === "__qa_sentinel__";
    } catch { clipboardUsable = false; }

    const r = await clickControl(page, btn);
    await sleep(500);
    let clip = null;
    try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* permission varies */ }
    checked.push({
      action: "copy", label: btn.name || btn.text, clicked: r.ok,
      clipboardUsable, clipboard: truncate(clip, 120),
    });

    if (!clipboardUsable) {
      // Inconclusive, not a finding — recorded so the report does not claim the
      // clipboard was verified (HARD RULE 8.1).
      checked.push({ action: "copy", label: btn.name || btn.text, verdict: "inconclusive — clipboard unavailable in this browser context" });
      continue;
    }

    if (!r.ok) {
      findings.push(finding({
        id: `P7/copy-click/${btn.selector}`, phase: "P7", severity: "S3-minor",
        summary: `"${btn.name || btn.text}" could not be clicked: ${r.error}`,
        expected: "button is clickable", actual: r.error, control: btn,
        steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`],
      }));
    } else if (clip === "__qa_sentinel__") {
      findings.push(finding({
        id: `P7/copy-noop/${btn.selector}`, phase: "P7", severity: "S2-major",
        summary: `"${btn.name || btn.text}" did not write anything to the clipboard`,
        expected: "the tool's result on the clipboard", actual: "clipboard unchanged",
        control: btn, detail: `Visible result at the time of the click:\n${truncate(filledOutput, 400)}`,
        steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`, "Paste somewhere and compare"],
      }));
    } else if (clip != null && /NaN|undefined|\[object Object\]/.test(clip)) {
      findings.push(finding({
        id: `P7/copy-poison/${btn.selector}`, phase: "P7", severity: "S2-major",
        summary: `"${btn.name || btn.text}" copies a broken value to the clipboard`,
        expected: "the rendered result", actual: truncate(clip, 200),
        control: btn, steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`, "Paste somewhere"],
      }));
    }
  }

  // --- download / export
  for (const btn of actions.filter((a) => classifyAction(a) === "download")) {
    const errBefore = session.diagnostics.pageErrors.length;
    const dl = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
    await clickControl(page, btn);
    const download = await dl;
    const threw = session.diagnostics.pageErrors.length > errBefore;
    checked.push({ action: "download", label: btn.name || btn.text, got: !!download, threw });
    if (!download && threw) {
      findings.push(finding({
        id: `P7/download-throw/${btn.selector}`, phase: "P7", severity: "S2-major",
        summary: `"${btn.name || btn.text}" throws instead of producing a file`,
        expected: "a file download starts", actual: session.diagnostics.pageErrors.at(-1)?.message ?? "exception",
        control: btn, steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`],
      }));
    } else if (download && download.suggestedFilename && /undefined|NaN|null/.test(download.suggestedFilename)) {
      findings.push(finding({
        id: `P7/download-name/${btn.selector}`, phase: "P7", severity: "S3-minor",
        summary: `Exported file is named ${JSON.stringify(download.suggestedFilename)}`,
        expected: "a meaningful filename", actual: download.suggestedFilename,
        control: btn, steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`, "Look at the filename"],
      }));
    }
  }

  // --- toggles must be reversible
  for (const btn of actions.filter((a) => classifyAction(a) === "toggle")) {
    const t0 = await liveText(page);
    await clickControl(page, btn);
    const t1 = await liveText(page);
    await clickControl(page, btn);
    const t2 = await liveText(page);
    checked.push({ action: "toggle", label: btn.name || btn.text, changed: t0 !== t1, reversible: normaliseText(t0) === normaliseText(t2) });
    if (normaliseText(t0) === normaliseText(t1)) {
      findings.push(finding({
        id: `P7/toggle-noop/${btn.selector}`, phase: "P7", severity: "S2-major",
        summary: `"${btn.name || btn.text}" has no effect on the output`,
        expected: "the output changes when the toggle is pressed", actual: "output identical before and after",
        control: btn, steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}"`, "Compare the result"],
      }));
    } else if (normaliseText(t0) !== normaliseText(t2)) {
      findings.push(finding({
        id: `P7/toggle-irreversible/${btn.selector}`, phase: "P7", severity: "S3-minor",
        summary: `Pressing "${btn.name || btn.text}" twice does not return to the original state`,
        expected: "toggling twice is a no-op", actual: `before: ${truncate(t0, 160)}\nafter two presses: ${truncate(t2, 160)}`,
        control: btn, steps: [`Open ${tool.url}`, "Fill the fields", `Click "${btn.name || btn.text}" twice`, "Compare with the original result"],
      }));
    }
  }

  return {
    phase: "P7",
    verdict: findings.some((f) => /S1|S2/.test(f.severity)) ? FAIL : findings.length ? WARN : PASS,
    findings,
    evidence: { checked },
  };
}

/* ------------------------------------------------------------------ P8 */

export async function p8_responsive(ctx) {
  const { browser, origin, tool } = ctx;
  const findings = [];
  const seen = [];

  for (const vp of VIEWPORTS) {
    const s = await openTool(browser, { origin, url: tool.url, viewport: vp });
    try {
      if (s.navError || (s.status ?? 500) >= 400) { seen.push({ viewport: vp.name, error: s.navError ?? s.status }); continue; }
      const inv = await inventory(s.page);
      for (const c of inv.filter((c) => c.kind === "input" && c.visible && !c.disabled && c.type !== "file")) {
        const v = probeValueFor(c, 0);
        if (v !== null) await setControl(s.page, c, v);
      }
      for (const b of inv.filter((c) => c.kind === "action" && c.visible && classifyAction(c) === "compute")) {
        await clickControl(s.page, b);
      }
      await sleep(LIMITS.settleMs);

      const rep = await overflowReport(s.page);
      seen.push({ viewport: vp.name, pageOverflow: rep.pageOverflow, offenders: rep.offenders.length, brokenControls: rep.brokenControls.length });

      if (rep.pageOverflow > 2 && rep.offenders.length) {
        findings.push(finding({
          id: `P8/overflow/${vp.name}`, phase: "P8", severity: "S3-minor",
          summary: `Page scrolls horizontally at ${vp.width}px (${rep.pageOverflow}px overflow)`,
          expected: `content fits within ${vp.width}px`,
          actual: rep.offenders.slice(0, 3).map((o) => `<${o.tag}> extends to ${o.right}px ("${truncate(o.text, 40)}")`).join("; "),
          detail: JSON.stringify(rep.offenders, null, 2),
          steps: [`Open ${tool.url}`, `Set the viewport to ${vp.width}x${vp.height}`, "Fill the fields", "Scroll sideways"],
        }));
      }
      for (const b of rep.brokenControls) {
        findings.push(finding({
          id: `P8/collapsed/${vp.name}/${b.selector}`, phase: "P8", severity: "S3-minor",
          summary: `Control "${b.name || b.selector}" collapses to ${b.w}x${b.h}px at ${vp.width}px and cannot be used`,
          expected: "control keeps a usable size", actual: `${b.w}x${b.h}px`,
          steps: [`Open ${tool.url}`, `Set the viewport to ${vp.width}x${vp.height}`, "Try to use the control"],
        }));
      }
    } finally {
      await s.close();
    }
  }

  return { phase: "P8", verdict: findings.length ? WARN : PASS, findings, evidence: { viewports: seen } };
}

/* ------------------------------------------------------------------ P9 */

export async function p9_a11y(ctx) {
  const { session, tool } = ctx;
  const findings = [];
  const issues = await a11yReport(session.page);

  const grouped = new Map();
  for (const i of issues) {
    if (!grouped.has(i.kind)) grouped.set(i.kind, []);
    grouped.get(i.kind).push(i);
  }
  const labels = {
    "no-accessible-name": ["S3-minor", "control has no accessible name — screen readers announce it as unlabelled"],
    "placeholder-as-label": ["S4-note", "field relies on its placeholder as its only label"],
    "positive-tabindex": ["S3-minor", "positive tabindex disrupts natural keyboard order"],
    "img-missing-alt": ["S4-note", "image has no alt attribute"],
  };
  for (const [kind, list] of grouped) {
    const [sev, desc] = labels[kind] ?? ["S4-note", kind];
    findings.push(finding({
      id: `P9/${kind}`, phase: "P9", severity: sev,
      summary: `${list.length} ${list.length === 1 ? "element" : "elements"}: ${desc}`,
      expected: "every control has a programmatic name", actual: JSON.stringify(list.slice(0, 5), null, 2),
      steps: [`Open ${tool.url}`, "Inspect the listed elements"],
    }));
  }

  // Keyboard reachability of the primary controls.
  const inv = await inventory(session.page);
  const firstInput = inv.find((c) => c.kind === "input" && c.visible && !c.disabled);
  let keyboardOk = null;
  if (firstInput) {
    keyboardOk = await session.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.focus();
      return document.activeElement === el;
    }, firstInput.selector);
    if (keyboardOk === false) {
      findings.push(finding({
        id: "P9/not-focusable", phase: "P9", severity: "S3-minor",
        summary: `The primary input "${firstInput.name || firstInput.type}" cannot take keyboard focus`,
        expected: "field is focusable", actual: "focus() did not move the active element",
        steps: [`Open ${tool.url}`, "Press Tab to reach the first field"],
      }));
    }
  }

  return { phase: "P9", verdict: findings.length ? WARN : PASS, findings, evidence: { issueCount: issues.length, keyboardOk } };
}

/* ------------------------------------------------------------------ P10 */

export async function p10_meta(ctx) {
  const { session, tool, origin } = ctx;
  const findings = [];
  const meta = await pageMeta(session.page);

  if (!meta.title || meta.title.trim().length < 10) {
    findings.push(finding({
      id: "P10/title", phase: "P10", severity: "S3-minor",
      summary: "Page title is missing or too short", expected: "a descriptive <title>", actual: JSON.stringify(meta.title),
      steps: [`Open ${tool.url}`, "Check the document title"],
    }));
  }
  if (!meta.description || meta.description.trim().length < 50) {
    findings.push(finding({
      id: "P10/description", phase: "P10", severity: "S3-minor",
      summary: "Meta description is missing or too short", expected: "a 50-160 character description", actual: JSON.stringify(truncate(meta.description, 200)),
      steps: [`Open ${tool.url}`, "Check <meta name=description>"],
    }));
  }
  const expectedCanonical = `${tool.url}`;
  if (!meta.canonical) {
    findings.push(finding({
      id: "P10/canonical-missing", phase: "P10", severity: "S3-minor",
      summary: "No canonical link on the page", expected: `canonical ending in ${expectedCanonical}`, actual: "none",
      steps: [`Open ${tool.url}`, "Check <link rel=canonical>"],
    }));
  } else if (!meta.canonical.endsWith(expectedCanonical)) {
    findings.push(finding({
      id: "P10/canonical-mismatch", phase: "P10", severity: "S2-major",
      summary: `Canonical points somewhere other than this tool's own URL`,
      expected: `…${expectedCanonical}`, actual: meta.canonical,
      steps: [`Open ${tool.url}`, "Check <link rel=canonical>"],
    }));
  }
  for (const [i, ld] of meta.jsonLd.entries()) {
    if (!ld.ok) {
      findings.push(finding({
        id: `P10/jsonld/${i}`, phase: "P10", severity: "S2-major",
        summary: `JSON-LD block ${i + 1} is not valid JSON and will be ignored by search engines`,
        expected: "parseable JSON-LD", actual: `${ld.error} — ${ld.head}`,
        steps: [`Open ${tool.url}`, "View source and validate the ld+json blocks"],
      }));
    }
  }
  if (meta.h1.length === 1 && tool.name && !similarEnough(meta.h1[0], tool.name)) {
    findings.push(finding({
      id: "P10/h1-mismatch", phase: "P10", severity: "S4-note",
      summary: `The <h1> does not match the tool name in config/tools.ts`,
      expected: tool.name, actual: meta.h1[0],
      steps: [`Open ${tool.url}`, "Compare the heading with config/tools.ts"],
    }));
  }

  return { phase: "P10", verdict: findings.some((f) => /S1|S2/.test(f.severity)) ? FAIL : findings.length ? WARN : PASS, findings, evidence: { meta } };
}

function similarEnough(a, b) {
  const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = n(a), y = n(b);
  return x.includes(y) || y.includes(x);
}
