import path from "node:path";
import { PATHS, LIMITS } from "./config.mjs";
import { launchBrowser } from "./browser.mjs";
import { discover } from "./discover.mjs";
import { runTool } from "./runner.mjs";
import { ensureDir, readJson, writeJson, c, log, truncate } from "./util.mjs";

/**
 * HARD RULE 5.1 — re-check #1, mechanical reproduction.
 *
 * Every candidate failure is re-run three times in brand-new browser contexts.
 * 3/3 advances to Claude for root-cause analysis; anything less is FLAKY and
 * never becomes an issue. Only the phases that actually produced findings are
 * replayed, because replaying all ten would multiply an already long run for no
 * extra evidence.
 */

const reproKey = (f) => `${f.tool}::${f.phase}::${f.id}`;

export async function triage({ runId, origin, browser, headed = false, onProgress = () => {} }) {
  const runDir = path.join(PATHS.reports, runId);
  const run = readJson(path.join(runDir, "run.json"));
  if (!run) throw new Error(`No run.json for run ${runId}`);

  const candidates = run.tools.flatMap((t) => t.findings);
  if (!candidates.length) {
    const empty = { runId, checked: 0, confirmed: [], flaky: [], rechecks: LIMITS.recheckRuns };
    writeJson(path.join(runDir, "triage-queue.json"), empty);
    return empty;
  }

  // Which tools need replaying, and which phases within them.
  const byTool = new Map();
  for (const f of candidates) {
    if (!byTool.has(f.tool)) byTool.set(f.tool, new Set());
    byTool.get(f.tool).add(f.phase);
  }

  const d = discover({ tools: [...byTool.keys()].join(",") });
  const toolBySlug = new Map(d.selected.map((t) => [t.slug, t]));

  const ownBrowser = !browser;
  const b = browser ?? (await launchBrowser({ headed }));
  const evidenceDir = ensureDir(path.join(runDir, "evidence", "recheck"));

  // seenCount[key] = how many of the N rechecks reproduced it
  const seenCount = new Map();
  const observed = new Map(); // key -> latest finding object from a recheck

  try {
    let n = 0;
    for (const [slug, phaseSet] of byTool) {
      const tool = toolBySlug.get(slug);
      n++;
      if (!tool) continue;
      const phases = [...phaseSet].filter((p) => /^P\d+$/.test(p));
      onProgress({ index: n, total: byTool.size, slug, phases });

      for (let attempt = 1; attempt <= LIMITS.recheckRuns; attempt++) {
        const res = await runTool({
          browser: b, origin, tool,
          evidenceDir: ensureDir(path.join(evidenceDir, `attempt-${attempt}`)),
          phases: phases.length ? phases : null,
        });
        for (const f of res.findings) {
          const k = reproKey(f);
          seenCount.set(k, (seenCount.get(k) ?? 0) + 1);
          observed.set(k, f);
        }
      }
    }
  } finally {
    if (ownBrowser) await b.close().catch(() => {});
  }

  const confirmed = [];
  const flaky = [];
  const notReproduced = [];

  for (const f of candidates) {
    const k = reproKey(f);
    const hits = seenCount.get(k) ?? 0;
    const latest = observed.get(k);
    const entry = {
      ...f,
      recheck: {
        runs: LIMITS.recheckRuns,
        reproduced: hits,
        stableActual: latest ? String(latest.actual) === String(f.actual) : null,
        latestActual: latest ? truncate(latest.actual, 300) : null,
      },
    };
    if (hits >= LIMITS.recheckMustFail) confirmed.push(entry);
    else if (hits > 0) flaky.push(entry);
    else notReproduced.push(entry);
  }

  // Findings the rechecks surfaced that the first run did not — these are
  // flaky in the other direction and are logged, never filed.
  const firstRunKeys = new Set(candidates.map(reproKey));
  const newlySeen = [...observed.entries()]
    .filter(([k]) => !firstRunKeys.has(k))
    .map(([k, f]) => ({ ...f, recheck: { runs: LIMITS.recheckRuns, reproduced: seenCount.get(k) ?? 0, firstRun: false } }));

  const queue = {
    runId,
    rechecks: LIMITS.recheckRuns,
    threshold: LIMITS.recheckMustFail,
    checked: candidates.length,
    confirmed: confirmed.sort(bySeverity),
    flaky: flaky.sort(bySeverity),
    notReproduced: notReproduced.sort(bySeverity),
    appearedOnlyInRecheck: newlySeen.sort(bySeverity),
  };

  writeJson(path.join(runDir, "triage-queue.json"), queue);

  // Keep a running record so a finding that is flaky twice can be looked at.
  const flakyLog = readJson(PATHS.flaky, { entries: [] });
  for (const f of [...flaky, ...newlySeen]) {
    flakyLog.entries.push({
      runId, key: reproKey(f), tool: f.tool, phase: f.phase,
      summary: truncate(f.summary, 200), reproduced: f.recheck.reproduced,
      at: new Date().toISOString(),
    });
  }
  writeJson(PATHS.flaky, flakyLog);

  return queue;
}

const ORDER = { "S1-critical": 0, "S2-major": 1, "S3-minor": 2, "S4-note": 3 };
function bySeverity(a, b) {
  return (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || a.tool.localeCompare(b.tool);
}

export function printTriage(q) {
  log("");
  log(c.bold(`  triage ${q.runId} — ${q.checked} candidate findings, ${q.rechecks}x recheck`));
  log(`  ${c.red(`confirmed ${q.confirmed.length}`)}  ${c.yellow(`flaky ${q.flaky.length}`)}  ${c.dim(`not reproduced ${q.notReproduced.length}`)}`);
  if (q.appearedOnlyInRecheck.length) {
    log(c.yellow(`  ! ${q.appearedOnlyInRecheck.length} finding(s) appeared only during recheck — logged as flaky, not filed`));
  }
  const bySev = {};
  for (const f of q.confirmed) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  if (q.confirmed.length) {
    log(`  confirmed by severity: ${Object.entries(bySev).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    log("");
    for (const f of q.confirmed.slice(0, 25)) {
      log(`  ${c.red(f.severity)} ${c.bold(f.tool)} [${f.phase}] ${truncate(f.summary, 110)}`);
    }
    if (q.confirmed.length > 25) log(c.dim(`  … and ${q.confirmed.length - 25} more (see triage-queue.json)`));
  }
  log("");
  log(c.dim("  Next: Claude root-causes each confirmed finding in source (HARD RULE 5.2),"));
  log(c.dim("  self-audits the expected value (5.3), then writes drafts/<run-id>/*.md"));
}
