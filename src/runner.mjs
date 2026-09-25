import fs from "node:fs";
import path from "node:path";
import { PATHS, LIMITS } from "./config.mjs";
import { launchBrowser, openTool } from "./browser.mjs";
import { discover } from "./discover.mjs";
import * as P from "./phases.mjs";
import { ensureDir, readJson, writeJson, runId as newRunId, c, log, truncate, fingerprint } from "./util.mjs";

/**
 * Runs the full P1-P10 pipeline over a scope. There is deliberately no shallow
 * path — HARD RULE 1.2 says depth is not negotiable, so every tool in scope
 * goes through every phase.
 */

export async function runScope({
  category = null,
  tools: only = null,
  origin,
  browser,
  runId = newRunId(),
  headed = false,
  onProgress = () => {},
} = {}) {
  const d = discover({ category, tools: only });
  const scope = d.selected;
  if (!scope.length) throw new Error("Scope selected zero tools.");

  const ownBrowser = !browser;
  const b = browser ?? (await launchBrowser({ headed }));

  const runDir = ensureDir(path.join(PATHS.reports, runId));
  const evidenceDir = ensureDir(path.join(runDir, "evidence"));

  const results = [];
  const startedAt = new Date().toISOString();

  try {
    for (const [i, tool] of scope.entries()) {
      onProgress({ index: i + 1, total: scope.length, tool });
      const res = await runTool({ browser: b, origin, tool, evidenceDir });
      results.push(res);
      // Write incrementally so a long run is never lost.
      writeJson(path.join(runDir, "run.json"), buildRun({ runId, startedAt, origin, category, only, scope, results }));
    }
  } finally {
    if (ownBrowser) await b.close().catch(() => {});
  }

  const run = buildRun({ runId, startedAt, origin, category, only, scope, results, finishedAt: new Date().toISOString() });
  writeJson(path.join(runDir, "run.json"), run);
  writeJson(PATHS.lastRun, { runId, dir: runDir, finishedAt: run.finishedAt });
  return run;
}

export async function runTool({ browser, origin, tool, evidenceDir, phases = null }) {
  const spec = tool.hasSpec ? readJson(tool.specPath) : null;
  const t0 = Date.now();
  const session = await openTool(browser, { origin, url: tool.url });
  const ctx = { session, tool, spec, browser, origin };

  const phaseResults = {};
  const record = (r) => { phaseResults[r.phase] = r; return r; };
  const want = (p) => !phases || phases.includes(p);

  let controls = [];
  let frozen = false;
  try {
    const p1 = record(await P.p1_render(ctx));
    if (p1.blocking) {
      for (const p of ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]) {
        phaseResults[p] = { phase: p, verdict: "blocked", findings: [], evidence: { reason: "P1 failed — the page does not render" } };
      }
    } else {
      const p2 = record(await P.p2_controls(ctx));
      controls = p2.controls ?? [];

      const later = [
        ["P3", () => P.p3_liveLogic(ctx, controls)],
        ["P4", () => P.p4_specs(ctx, controls)],
        ["P5", () => P.p5_boundaries(ctx, controls)],
        ["P6", () => P.p6_invariants(ctx, controls)],
        ["P7", () => P.p7_stateActions(ctx, controls)],
        ["P9", () => P.p9_a11y(ctx)],
        ["P10", () => P.p10_meta(ctx)],
        ["P8", () => P.p8_responsive(ctx)],
      ];
      for (const [i, [name, run]] of later.entries()) {
        if (!want(name)) continue;
        // A page whose main thread freezes never answers page.evaluate, and
        // without a deadline one tool stalls the whole run (a 10^12 plot count
        // did exactly that). Past the deadline the phase and everything after
        // it are recorded as incomplete (HARD RULE 1.3), never as passing.
        const r = await withDeadline(run(), LIMITS.phaseTimeoutMs);
        if (r !== TIMED_OUT) { record(r); continue; }
        phaseResults[name] = {
          phase: name, verdict: "incomplete",
          findings: [P.finding({
            id: `${name}/timeout`, phase: name, severity: "S2-major",
            summary: `${name} did not finish within ${LIMITS.phaseTimeoutMs / 60000} min — the page stopped responding`,
            expected: "the page stays responsive to every input the phase enters",
            actual: `no response after ${LIMITS.phaseTimeoutMs / 1000} s`,
            detail: "The main thread appears frozen. Later phases were not run for this tool.",
            steps: [`Open ${tool.url}`, `Run phase ${name}`],
          })],
          evidence: { reason: "phase deadline exceeded" },
        };
        for (const [skipped] of later.slice(i + 1)) {
          if (want(skipped)) phaseResults[skipped] = { phase: skipped, verdict: "incomplete", findings: [], evidence: { reason: `not run: ${name} froze the page` } };
        }
        frozen = true;
        break;
      }
    }
  } catch (e) {
    phaseResults.ERROR = {
      phase: "ERROR", verdict: "fail",
      findings: [{
        id: "RUNNER/exception", phase: "RUNNER", severity: "S4-note",
        summary: `The QA runner itself threw while testing this tool: ${e.message}`,
        expected: "the pipeline completes", actual: e.message,
        detail: String(e.stack ?? "").split("\n").slice(0, 6).join("\n"),
        steps: [`Open ${tool.url}`],
      }],
      evidence: {},
    };
  }

  // Evidence: a screenshot of the tool in its exercised state.
  let screenshot = null;
  if (!frozen) try {
    screenshot = path.join(evidenceDir, `${tool.slug}.png`);
    await session.page.screenshot({ path: screenshot, fullPage: false });
    screenshot = path.relative(PATHS.root, screenshot);
  } catch { screenshot = null; }

  let domDump = null;
  const anyFailure = Object.values(phaseResults).some((p) => p.verdict === "fail");
  if (anyFailure && !frozen) {
    try {
      const html = await session.page.content();
      const p = path.join(evidenceDir, `${tool.slug}.html`);
      fs.writeFileSync(p, html);
      domDump = path.relative(PATHS.root, p);
    } catch { /* non-fatal */ }
  }

  await withDeadline(session.close(), 15_000);

  const findings = Object.values(phaseResults).flatMap((p) =>
    (p.findings ?? []).map((f) => ({
      ...f,
      tool: tool.slug,
      toolName: tool.name,
      category: tool.category,
      url: tool.url,
      route: tool.route,
      routeFile: tool.routeFile,
      sourceDir: tool.sourceDir,
      fingerprint: fingerprint([tool.slug, f.phase, f.id, f.expected, f.actual]),
      evidence: { screenshot, domDump },
    })));

  return {
    slug: tool.slug,
    name: tool.name,
    category: tool.category,
    url: tool.url,
    route: tool.route,
    hasSpec: !!spec,
    specCases: spec?.cases?.length ?? 0,
    durationMs: Date.now() - t0,
    phases: Object.fromEntries(
      Object.entries(phaseResults).map(([k, v]) => [k, {
        verdict: v.verdict,
        findingCount: (v.findings ?? []).length,
        evidence: v.evidence ?? {},
      }])),
    verdict: overallVerdict(phaseResults),
    findings,
    console: {
      errors: session.diagnostics.console.filter((x) => x.type === "error").map((x) => truncate(x.text, 300)),
      warnings: session.diagnostics.console.filter((x) => x.type === "warning").map((x) => truncate(x.text, 300)),
      pageErrors: session.diagnostics.pageErrors.map((e) => truncate(e.message, 300)),
      failedRequests: session.diagnostics.requestFailures.slice(0, 10),
    },
    evidence: { screenshot, domDump },
  };
}

function overallVerdict(phaseResults) {
  const vs = Object.values(phaseResults).map((p) => p.verdict);
  if (vs.includes("fail")) return "fail";
  if (vs.includes("blocked")) return "fail";
  if (vs.includes("warn")) return "warn";
  if (vs.includes("skipped")) return "pass-with-gaps";
  return "pass";
}

function buildRun({ runId, startedAt, finishedAt = null, origin, category, only, scope, results }) {
  const findings = results.flatMap((r) => r.findings);
  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  return {
    runId,
    startedAt,
    finishedAt,
    origin,
    scope: { category, tools: only, count: scope.length },
    rulesVersion: fs.existsSync(PATHS.rules) ? fingerprint([fs.readFileSync(PATHS.rules, "utf8")]) : null,
    summary: {
      tested: results.length,
      pass: results.filter((r) => r.verdict === "pass").length,
      passWithGaps: results.filter((r) => r.verdict === "pass-with-gaps").length,
      warn: results.filter((r) => r.verdict === "warn").length,
      fail: results.filter((r) => r.verdict === "fail").length,
      withoutSpec: results.filter((r) => !r.hasSpec).length,
      findings: findings.length,
      bySeverity,
    },
    tools: results,
  };
}

export function printRunSummary(run) {
  const s = run.summary;
  log("");
  log(c.bold(`  run ${run.runId} — ${s.tested} tools`));
  log(`  ${c.green(`pass ${s.pass}`)}  ${c.yellow(`warn ${s.warn}`)}  ${c.red(`fail ${s.fail}`)}  ${c.dim(`pass-with-gaps ${s.passWithGaps}`)}`);
  log(`  findings: ${s.findings}  ` + Object.entries(s.bySeverity).map(([k, v]) => `${k}=${v}`).join("  "));
  if (s.withoutSpec) {
    log(c.yellow(`  ! ${s.withoutSpec} tool(s) had no correctness spec — P4 did NOT verify their maths`));
  }
}

const TIMED_OUT = Symbol("timed-out");
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise.catch((e) => { throw e; }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}
