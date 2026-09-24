import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";
import { readJson, truncate } from "./util.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const SEV_ORDER = { "S1-critical": 0, "S2-major": 1, "S3-minor": 2, "S4-note": 3 };
const PHASE_NAMES = {
  P1: "Route & render", P2: "Control inventory", P3: "Live-logic sweep",
  P4: "Correctness specs", P5: "Boundary & abuse", P6: "Invariant scan",
  P7: "State & actions", P8: "Responsive", P9: "Accessibility", P10: "SEO / meta",
};

export function buildReport(runId) {
  const runDir = path.join(PATHS.reports, runId);
  const run = readJson(path.join(runDir, "run.json"));
  if (!run) throw new Error(`No run.json for ${runId}`);
  const triage = readJson(path.join(runDir, "triage-queue.json"));

  const status = new Map();
  if (triage) {
    for (const f of triage.confirmed) status.set(`${f.tool}::${f.phase}::${f.id}`, "confirmed");
    for (const f of triage.flaky) status.set(`${f.tool}::${f.phase}::${f.id}`, "flaky");
    for (const f of triage.notReproduced) status.set(`${f.tool}::${f.phase}::${f.id}`, "not-reproduced");
  }

  const allFindings = run.tools.flatMap((t) => t.findings)
    .map((f) => ({ ...f, triage: status.get(`${f.tool}::${f.phase}::${f.id}`) ?? (triage ? "not-reproduced" : "untriaged") }))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || a.tool.localeCompare(b.tool));

  const html = page(run, triage, allFindings);
  const out = path.join(runDir, "report.html");
  fs.writeFileSync(out, html);
  return out;
}

function page(run, triage, findings) {
  const s = run.summary;
  const confirmed = findings.filter((f) => f.triage === "confirmed");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA run ${esc(run.runId)}</title>
<style>
  :root{color-scheme:light dark;--bg:#0f1115;--fg:#e6e8ee;--dim:#8b90a0;--card:#171a21;--line:#262b36;
        --s1:#ff6b6b;--s2:#ffa94d;--s3:#ffd43b;--s4:#8b90a0;--ok:#51cf66;--blue:#4dabf7}
  @media (prefers-color-scheme:light){:root{--bg:#f7f8fa;--fg:#14161b;--dim:#5c6270;--card:#fff;--line:#e3e6ec}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
  .meta{color:var(--dim);font-size:13px;margin-bottom:24px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card .n{font-size:24px;font-weight:700} .card .l{color:var(--dim);font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
  .S1-critical{background:var(--s1);color:#1a0000}.S2-major{background:var(--s2);color:#241200}
  .S3-minor{background:var(--s3);color:#241f00}.S4-note{background:var(--s4);color:#0c0d10}
  .t-confirmed{color:var(--s1);font-weight:700}.t-flaky{color:var(--s3)}.t-not-reproduced{color:var(--dim)}
  .v-pass{color:var(--ok)}.v-warn{color:var(--s3)}.v-fail{color:var(--s1);font-weight:700}
  .v-skipped,.v-blocked{color:var(--dim)}
  code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;font-size:12px}
  details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:8px 0}
  summary{cursor:pointer;font-weight:600}
  pre{overflow-x:auto;background:rgba(127,127,127,.1);padding:10px;border-radius:8px;font-size:12px;margin:8px 0 0}
  .note{background:var(--card);border-left:3px solid var(--blue);padding:12px 14px;border-radius:0 8px 8px 0;margin:14px 0;color:var(--dim)}
  .grid10{display:grid;grid-template-columns:repeat(10,1fr);gap:2px}
  .ph{height:16px;border-radius:3px;background:var(--line)}
  .ph.pass{background:var(--ok)}.ph.warn{background:var(--s3)}.ph.fail{background:var(--s1)}
  .ph.skipped{background:var(--line)}.ph.blocked{background:#4a2020}
</style></head><body><div class="wrap">

<h1>QA run ${esc(run.runId)}</h1>
<div class="meta">
  ${esc(run.scope.category ? `category: ${run.scope.category}` : `tools: ${run.scope.tools ?? "all"}`)} ·
  ${run.summary.tested} tools · ${esc(run.origin)} ·
  started ${esc(run.startedAt)}${run.finishedAt ? ` · finished ${esc(run.finishedAt)}` : " · <strong>incomplete</strong>"}
</div>

<div class="cards">
  <div class="card"><div class="n v-pass">${s.pass}</div><div class="l">pass</div></div>
  <div class="card"><div class="n v-warn">${s.warn}</div><div class="l">warn</div></div>
  <div class="card"><div class="n v-fail">${s.fail}</div><div class="l">fail</div></div>
  <div class="card"><div class="n">${s.findings}</div><div class="l">findings</div></div>
  <div class="card"><div class="n ${confirmed.length ? "v-fail" : "v-pass"}">${triage ? confirmed.length : "—"}</div><div class="l">confirmed (3/3)</div></div>
  <div class="card"><div class="n">${s.withoutSpec}</div><div class="l">no correctness spec</div></div>
</div>

${s.withoutSpec ? `<div class="note"><strong>${s.withoutSpec} tool(s) ran without a correctness spec.</strong>
Phase P4 did not verify their arithmetic — only that they render, respond, and do not leak broken values.
Write <code>specs/&lt;slug&gt;.json</code> with independently derived expected values to close that gap.</div>` : ""}

${!triage ? `<div class="note">No triage record yet. Findings below are <strong>candidates</strong>: they have not been
re-run three times, so none of them may be filed as issues (HARD RULE 5.1). Run <code>qa triage --run ${esc(run.runId)}</code>.</div>` : ""}

<h2>Confirmed findings${triage ? ` (${confirmed.length})` : " — not yet triaged"}</h2>
${confirmed.length ? findingsTable(confirmed) : `<div class="note">${triage ? "Nothing reproduced 3/3." : "Run triage first."}</div>`}

<h2>All findings (${findings.length})</h2>
${findings.length ? findingsTable(findings, true) : `<div class="note">No findings recorded.</div>`}

<h2>Per-tool phase matrix</h2>
<div class="scroll"><table>
<thead><tr><th>Tool</th><th>Route</th><th>Spec</th><th style="min-width:230px">P1 … P10</th><th>Verdict</th><th>Time</th></tr></thead>
<tbody>
${run.tools.map((t) => `<tr>
  <td><a href="${esc(run.origin + t.url)}" style="color:var(--blue)">${esc(t.slug)}</a></td>
  <td>${esc(t.route)}</td>
  <td>${t.hasSpec ? `${t.specCases} cases` : '<span class="t-not-reproduced">none</span>'}</td>
  <td><div class="grid10" title="${esc(Object.entries(t.phases).map(([k, v]) => `${k} ${PHASE_NAMES[k] ?? ""}: ${v.verdict}`).join("\n"))}">
    ${["P1","P2","P3","P4","P5","P6","P7","P8","P9","P10"].map((p) => `<div class="ph ${esc(t.phases[p]?.verdict ?? "skipped")}"></div>`).join("")}
  </div></td>
  <td class="v-${esc(t.verdict.replace(/-.*/, ""))}">${esc(t.verdict)}</td>
  <td>${Math.round(t.durationMs / 1000)}s</td>
</tr>`).join("")}
</tbody></table></div>
<div class="meta" style="margin-top:8px">Bars are P1–P10 in order. Hover for names. Green pass · yellow warn · red fail · grey skipped.</div>

${triage ? `<h2>Flaky (${triage.flaky.length})</h2>
<div class="note">Reproduced in some but not all of ${triage.rechecks} re-runs. Never filed as issues; carried into the flaky log for the next run to watch.</div>
${triage.flaky.length ? findingsTable(triage.flaky.map((f) => ({ ...f, triage: "flaky" }))) : ""}` : ""}

</div></body></html>`;
}

function findingsTable(list, showTriage = false) {
  return `<div class="scroll"><table>
<thead><tr><th>Sev</th><th>Tool</th><th>Phase</th><th>Finding</th><th>Expected</th><th>Actual</th>${showTriage ? "<th>Triage</th>" : "<th>Repro</th>"}</tr></thead>
<tbody>
${list.map((f) => `<tr>
  <td><span class="pill ${esc(f.severity)}">${esc(f.severity.replace(/-.*/, ""))}</span></td>
  <td><code>${esc(f.tool)}</code></td>
  <td title="${esc(PHASE_NAMES[f.phase] ?? "")}">${esc(f.phase)}</td>
  <td>${esc(truncate(f.summary, 220))}</td>
  <td><code>${esc(truncate(f.expected, 90))}</code></td>
  <td><code>${esc(truncate(f.actual, 90))}</code></td>
  <td class="t-${esc(f.triage ?? "untriaged")}">${showTriage ? esc(f.triage ?? "untriaged") : `${f.recheck?.reproduced ?? "?"}/${f.recheck?.runs ?? "?"}`}</td>
</tr>`).join("")}
</tbody></table></div>`;
}
