import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PATHS } from "./config.mjs";
import { ensureDir, readJson, writeJson, truncate, c, log } from "./util.mjs";

const exec = promisify(execFile);

/**
 * Prefer `gh` from PATH, but fall back to a user-local install, because a
 * standalone binary in ~/.local/bin is a common setup where Homebrew is not
 * usable. QA_GH_BIN overrides both.
 */
const GH = process.env.QA_GH_BIN || resolveGh();

function resolveGh() {
  const local = process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "gh") : null;
  if (local && fs.existsSync(local)) return local;
  return "gh";
}

/**
 * Drafts first, then filing — HARD RULE 7.1.
 *
 * The runner can fill in everything it observed. The three fields that require
 * reading the site's source (root cause, fix, blast radius) are left as
 * explicit TODO markers, and a draft that still contains one is refused at
 * filing time. That is what keeps HARD RULE 5.2 enforceable rather than
 * aspirational.
 */

const TODO = "<!-- TODO:";

const REQUIRED_SECTIONS = [
  "## Summary",
  "## Steps to reproduce",
  "## Expected vs Actual",
  "## Root cause",
  "## Suggested fix",
  "## Blast radius",
  "## Evidence",
];

export function draftPath(runId, finding) {
  return path.join(PATHS.drafts, runId, `${finding.severity}__${finding.tool}__${finding.phase}__${finding.fingerprint}.md`);
}

/** Pre-fill every draft with what the run actually observed. */
export function scaffoldDrafts(runId, { includeSeverities = ["S1-critical", "S2-major", "S3-minor"] } = {}) {
  const runDir = path.join(PATHS.reports, runId);
  const queue = readJson(path.join(runDir, "triage-queue.json"));
  if (!queue) throw new Error(`No triage-queue.json for run ${runId} — run "qa triage" first.`);

  const ledger = readJson(PATHS.ledger, { filed: {} });
  const outDir = ensureDir(path.join(PATHS.drafts, runId));
  const written = [];
  const skipped = [];

  for (const f of queue.confirmed) {
    if (!includeSeverities.includes(f.severity)) { skipped.push({ ...f, why: "severity below threshold" }); continue; }
    if (ledger.filed[f.fingerprint]) {
      skipped.push({ fingerprint: f.fingerprint, tool: f.tool, why: `already filed as ${ledger.filed[f.fingerprint].url}` });
      continue;
    }
    const p = draftPath(runId, f);
    if (fs.existsSync(p)) { skipped.push({ fingerprint: f.fingerprint, tool: f.tool, why: "draft already exists" }); continue; }
    fs.writeFileSync(p, renderDraft(f, runId));
    written.push(path.relative(PATHS.root, p));
  }

  writeJson(path.join(outDir, "_index.json"), {
    runId, written, skipped,
    confirmed: queue.confirmed.length,
    generatedAt: new Date().toISOString(),
  });
  return { dir: path.relative(PATHS.root, outDir), written, skipped };
}

function renderDraft(f, runId) {
  const title = issueTitle(f);
  const steps = (f.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "1. (none recorded)";
  const srcHint = f.sourceDir
    ? `\`${f.sourceDir}/logic.ts\`, \`${f.sourceDir}/ui.tsx\`, \`${f.sourceDir}/config.ts\``
    : "(no source directory — this slug has no implementation)";

  return `---
qa_run: ${runId}
qa_tool: ${f.tool}
qa_phase: ${f.phase}
qa_severity: ${f.severity}
qa_fingerprint: ${f.fingerprint}
qa_title: ${title}
qa_labels: bug, qa-automated, ${f.severity}
---

## Summary

${f.summary}

**Tool:** ${f.toolName} (\`${f.tool}\`)
**URL:** \`${f.url}\`
**Category:** ${f.category}
**Route:** ${f.route}${f.routeFile ? ` — \`${f.routeFile}\`` : ""}
**Severity:** ${f.severity}
**Detected by:** phase ${f.phase} / assertion \`${f.id}\`
**Reproduced:** ${f.recheck?.reproduced ?? "?"}/${f.recheck?.runs ?? "?"} independent re-runs${f.recheck?.stableActual === false ? " (the observed value varied between runs — check whether this tool is intentionally random before filing)" : ""}

## Steps to reproduce

${steps}

## Expected vs Actual

| | |
|---|---|
| **Expected** | ${mdCell(f.expected)} |
| **Actual** | ${mdCell(f.actual)} |

${derivationBlock(f)}

${f.detail ? `<details><summary>Captured detail</summary>\n\n\`\`\`\n${truncate(f.detail, 3000)}\n\`\`\`\n\n</details>\n` : ""}

## Root cause

${TODO} HARD RULE 5.2 — read the source and name the exact line and expression that
produces this behaviour. Quote it. Files to read: ${srcHint}.
An issue may not be filed without a file:line and a mechanism. -->

## Suggested fix

${TODO} A concrete change — ideally a diff — and one sentence on why the new
behaviour is correct. -->

## Blast radius

${TODO} HARD RULE 7.4 — list any other tool that imports the same helper, repeats
the same formula, or copies this file. If several tools share the root cause,
file one issue listing them all rather than one issue per tool. -->

## Evidence

- Screenshot: \`${f.evidence?.screenshot ?? "(none)"}\`
${f.evidence?.domDump ? `- DOM snapshot: \`${f.evidence.domDump}\`\n` : ""}- Run report: \`reports/${runId}/run.json\`
- Triage record: \`reports/${runId}/triage-queue.json\`

<!-- qa-fingerprint: ${f.fingerprint} -->
`;
}

/**
 * A derivation is only meaningful for a numeric claim. Demanding one for, say,
 * a missing accessible name would make the TODO gate unsatisfiable, so the
 * section is only required where a number is actually being disputed.
 */
function derivationBlock(f) {
  if (f.derivation) {
    return `**Independent derivation of the expected value** (QA_RULES.md HARD RULE 2.2):

> ${String(f.derivation).replace(/\n/g, "\n> ")}
`;
  }
  const numeric = /^-?[\d.,\s]+$/.test(String(f.expected ?? "")) && /^-?[\d.,\s]+$/.test(String(f.actual ?? ""));
  if (f.phase === "P4" || numeric) {
    return `${TODO} This finding disputes a number, so HARD RULE 2.2 requires an independent
derivation of the expected value here — a published constant, a stated formula, or a hand
computation. "The code says so" is not a derivation. -->`;
  }
  return `_No numeric derivation applies to this finding: the expected behaviour above is a structural or
behavioural requirement, not a computed value._
`;
}

function mdCell(v) {
  const s = String(v ?? "(not recorded)").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function issueTitle(f) {
  const prefix = `[${String(f.severity).split("-")[0]}]`;
  return truncate(`${prefix} ${f.toolName}: ${f.summary}`.replace(/\s+/g, " "), 110);
}

/* ------------------------------------------------------------- filing */

function parseDraft(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { ok: false, error: "missing front matter" };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ok: true, meta, body: m[2], raw, file };
}

function validateDraft(d) {
  const problems = [];
  if (d.body.includes(TODO)) {
    const which = [...d.body.matchAll(/##\s+(.+)\n+<!-- TODO:/g)].map((x) => x[1]);
    problems.push(`unfilled TODO section(s): ${which.join(", ") || "see file"}`);
  }
  for (const s of REQUIRED_SECTIONS) {
    if (!d.body.includes(s)) problems.push(`missing section ${s}`);
  }
  if (!d.meta.qa_fingerprint) problems.push("missing qa_fingerprint");
  if (!d.meta.qa_title) problems.push("missing qa_title");
  if (!/<!-- qa-fingerprint: \w+ -->/.test(d.body)) problems.push("missing trailing fingerprint marker");
  // HARD RULE 5.2 — a root cause has to point at something.
  const rc = d.body.split("## Root cause")[1]?.split("##")[0] ?? "";
  if (rc.trim().length < 40) problems.push("root cause section is empty or too thin");
  if (!/[\w./-]+\.(ts|tsx|js|jsx|mjs)(:\d+)?/.test(rc)) problems.push("root cause names no source file");
  return problems;
}

async function gh(args, { cwd = PATHS.site } = {}) {
  const { stdout } = await exec(GH, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** HARD RULE 7.2 layer 2 — look for the fingerprint and the slug on the remote. */
async function remoteDuplicate(repo, fingerprint, slug) {
  const search = async (q) => {
    try {
      const out = await gh(["issue", "list", "--repo", repo, "--state", "all", "--search", q,
        "--limit", "20", "--json", "number,title,url,state,body"]);
      return JSON.parse(out || "[]");
    } catch { return []; }
  };
  const byFp = await search(`"qa-fingerprint: ${fingerprint}"`);
  const hit = byFp.find((i) => (i.body ?? "").includes(`qa-fingerprint: ${fingerprint}`));
  if (hit) return { kind: "fingerprint", issue: hit };

  const bySlug = await search(`"${slug}" in:title,body label:qa-automated`);
  if (bySlug.length) return { kind: "same-tool", candidates: bySlug.map((i) => ({ number: i.number, title: i.title, url: i.url, state: i.state })) };
  return null;
}

export async function fileIssues({ runId, repo, dryRun = true, only = null }) {
  const dir = path.join(PATHS.drafts, runId);
  if (!fs.existsSync(dir)) throw new Error(`No drafts for run ${runId}. Run "qa draft --run ${runId}" first.`);

  let files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f));
  if (only) {
    const set = new Set(String(only).split(",").map((s) => s.trim()));
    files = files.filter((f) => [...set].some((s) => path.basename(f).includes(s)));
  }
  if (!files.length) throw new Error(`No draft .md files matched in ${dir}`);

  const ledger = readJson(PATHS.ledger, { filed: {} });
  const results = [];

  for (const file of files) {
    const d = parseDraft(file);
    const rel = path.relative(PATHS.root, file);
    if (!d.ok) { results.push({ file: rel, action: "rejected", reason: d.error }); continue; }

    const problems = validateDraft(d);
    if (problems.length) { results.push({ file: rel, action: "rejected", reason: problems.join("; ") }); continue; }

    const fp = d.meta.qa_fingerprint;
    const slug = d.meta.qa_tool;

    if (ledger.filed[fp]) {
      results.push({ file: rel, action: "skipped", reason: `fingerprint already filed: ${ledger.filed[fp].url}` });
      continue;
    }

    const dup = await remoteDuplicate(repo, fp, slug);
    if (dup?.kind === "fingerprint") {
      ledger.filed[fp] = { url: dup.issue.url, number: dup.issue.number, at: new Date().toISOString(), viaRemoteMatch: true };
      results.push({ file: rel, action: "skipped", reason: `already on GitHub: ${dup.issue.url}` });
      continue;
    }

    const title = d.meta.qa_title;
    const labels = (d.meta.qa_labels ?? "bug, qa-automated").split(",").map((s) => s.trim()).filter(Boolean);

    if (dryRun) {
      results.push({
        file: rel, action: "would-create", title, labels,
        relatedExisting: dup?.candidates ?? [],
        bodyBytes: d.body.length,
      });
      continue;
    }

    const bodyFile = path.join(dir, `.body-${fp}.md`);
    fs.writeFileSync(bodyFile, d.body.trim());
    try {
      const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile];
      for (const l of labels) args.push("--label", l);
      let url;
      try {
        url = (await gh(args)).trim().split("\n").pop();
      } catch (e) {
        // A missing label is the usual cause; retry with the two that always exist.
        if (/label|not found/i.test(String(e.stderr ?? e.message))) {
          const base = ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile, "--label", "bug"];
          url = (await gh(base)).trim().split("\n").pop();
        } else throw e;
      }
      ledger.filed[fp] = { url, title, tool: slug, runId, at: new Date().toISOString() };
      results.push({ file: rel, action: "created", url, title });
    } catch (e) {
      results.push({ file: rel, action: "error", reason: truncate(String(e.stderr ?? e.message), 400) });
    } finally {
      fs.unlinkSync(bodyFile);
    }
  }

  writeJson(PATHS.ledger, ledger);
  writeJson(path.join(PATHS.reports, runId, "filing-result.json"), { runId, repo, dryRun, results, at: new Date().toISOString() });
  return results;
}

export function printFiling(results, dryRun) {
  log("");
  log(c.bold(dryRun ? "  dry run — nothing was sent to GitHub" : "  filing result"));
  for (const r of results) {
    const tag = { created: c.green("created"), "would-create": c.blue("would create"), skipped: c.dim("skipped"), rejected: c.red("rejected"), error: c.red("error") }[r.action];
    log(`  ${tag}  ${r.title ?? path.basename(r.file)}`);
    if (r.url) log(`      ${r.url}`);
    if (r.reason) log(c.dim(`      ${r.reason}`));
    if (r.relatedExisting?.length) {
      log(c.yellow(`      ${r.relatedExisting.length} existing issue(s) already mention this tool — read them before filing (HARD RULE 7.2 layer 3):`));
      for (const e of r.relatedExisting.slice(0, 5)) log(c.dim(`        #${e.number} [${e.state}] ${truncate(e.title, 80)}`));
    }
  }
}

export async function ghReady(repo) {
  try {
    await gh(["auth", "status"]);
    await gh(["repo", "view", repo, "--json", "name"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: truncate(String(e.stderr ?? e.message), 300) };
  }
}
