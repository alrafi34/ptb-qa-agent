#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PATHS, SERVER, LIMITS } from "../src/config.mjs";
import { discover, summarise } from "../src/discover.mjs";
import { startServer } from "../src/devserver.mjs";
import { runScope, printRunSummary } from "../src/runner.mjs";
import { triage, printTriage } from "../src/triage.mjs";
import { buildReport } from "../src/report.mjs";
import { scaffoldDrafts, fileIssues, printFiling, ghReady } from "../src/issues.mjs";
import { buildWorklist, validateAllSpecs, SPEC_TEMPLATE } from "../src/specs.mjs";
import { readJson, writeJson, c, log, truncate, runId as newRunId } from "../src/util.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const has = (name) => argv.includes(`--${name}`);

const DEFAULT_REPO = process.env.QA_REPO || "alrafi34/productive-tb";

function scopeArgs() {
  const category = flag("category", null);
  let tools = flag("tools", null);
  const file = flag("file", null);
  if (file) {
    tools = fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).join(",");
  }
  if (!category && !tools) {
    log(c.red("  Scope is required (HARD RULE 1.1). Use --category <slug>, --tools a,b,c, or --file <path>."));
    log(c.dim("  Run `qa categories` to see what is available."));
    process.exit(2);
  }
  return { category: category === true ? null : category, tools: tools === true ? null : tools };
}

function currentRunId() {
  const explicit = flag("run", null);
  if (explicit && explicit !== true) return explicit;
  const last = readJson(PATHS.lastRun);
  if (last?.runId) return last.runId;
  log(c.red("  No run id given and no previous run recorded. Pass --run <id>."));
  process.exit(2);
}

/* ------------------------------------------------------------------ */

const commands = {
  async help() {
    log(`
${c.bold("qa")} — deep automated QA for productivetoolbox.com

  ${c.bold("Scope is always explicit.")} There is no smoke mode: every tool in scope
  goes through all ten phases (QA_RULES.md HARD RULE 1.2).

${c.bold("Commands")}
  qa categories                         list categories and tool counts
  qa discover  --category <slug>        show what a scope resolves to, and its routing
  qa specs     --category <slug>        build the spec-authoring worklist for Claude
  qa specs:check --category <slug>      validate the spec files in a scope
  qa run       --category <slug>        run P1-P10 over the scope
  qa triage    --run <id>               re-run every failure ${LIMITS.recheckRuns}x (HARD RULE 5.1)
  qa report    --run <id>               (re)build report.html
  qa draft     --run <id>               scaffold issue drafts for confirmed findings
  qa file-issues --run <id>             file the drafts on GitHub (dry run by default)
  qa doctor                             check the environment

${c.bold("Scope flags")}   --category <slug>  --tools a,b,c  --file <path-to-slug-list>
${c.bold("Run flags")}     --headed  --prod  --port <n>  --keep-server  --reuse-server
${c.bold("Filing flags")}  --confirm (actually create)  --repo <owner/name>  --only <substring>

${c.dim(`Repo: ${DEFAULT_REPO}   Site: ${PATHS.site}`)}
`);
  },

  async categories() {
    const s = summarise(discover({}));
    log("");
    log(c.bold(`  ${s.total} tools across ${s.byCategory.length} categories`));
    log("");
    for (const r of s.byCategory) {
      log(`  ${String(r.count).padStart(4)}  ${c.bold(r.slug.padEnd(18))} ${c.dim(r.name)}`);
    }
    if (s.duplicateSlugs.length) {
      log("");
      log(c.yellow(`  ! duplicate slug(s) in config/tools.ts: ${s.duplicateSlugs.join(", ")}`));
    }
    log("");
  },

  async discover() {
    const scope = scopeArgs();
    const d = discover(scope);
    log("");
    log(c.bold(`  ${d.selected.length} tools in scope`));
    log("");
    const byRoute = {};
    for (const t of d.selected) byRoute[t.route] = (byRoute[t.route] ?? 0) + 1;
    log(`  routing: ${Object.entries(byRoute).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    log(`  specs:   ${d.selected.filter((t) => t.hasSpec).length} present, ${c.yellow(`${d.selected.filter((t) => !t.hasSpec).length} missing`)}`);
    log("");
    for (const t of d.selected) {
      const routeTag = t.route === "unrouted" ? c.red("UNROUTED") : c.dim(t.route.padEnd(9));
      const specTag = t.hasSpec ? c.green("spec") : c.yellow("----");
      log(`  ${specTag} ${routeTag} ${t.url}`);
      if (!t.sourceDir) log(c.red(`         ! no source directory at tools/${t.slug}/`));
      if (t.declaredSlug && t.declaredSlug !== t.slug) {
        log(c.yellow(`         ! config.ts declares slug "${t.declaredSlug}" but the site lists "${t.slug}"`));
      }
    }
    log("");
  },

  async specs() {
    const scope = scopeArgs();
    const r = buildWorklist({ ...scope, includeExisting: has("all") });
    log("");
    log(c.bold(`  worklist: ${r.count} tool(s) need a correctness spec`));
    log(`  ${r.file}`);
    log("");
    log(c.dim("  Hand this file to Claude. For each item it reads the `contract` (what the tool"));
    log(c.dim("  promises) and the `implementation` (what it actually does), derives the expected"));
    log(c.dim("  values independently, and writes specs/<slug>.json. HARD RULE 2.1 forbids copying"));
    log(c.dim("  an expected value out of the implementation."));
    log("");
    const tplPath = path.join(PATHS.specs, "_template.json");
    if (!fs.existsSync(tplPath)) writeJson(tplPath, SPEC_TEMPLATE);
    log(c.dim(`  Template: ${path.relative(PATHS.root, tplPath)}`));
    log("");
  },

  async "specs:check"() {
    const scope = scopeArgs();
    const rows = validateAllSpecs(scope);
    log("");
    const ok = rows.filter((r) => r.status === "ok");
    const bad = rows.filter((r) => r.status === "invalid");
    const missing = rows.filter((r) => r.status === "missing");
    log(c.bold(`  ${ok.length} valid  ${bad.length ? c.red(`${bad.length} invalid`) : "0 invalid"}  ${missing.length ? c.yellow(`${missing.length} missing`) : "0 missing"}`));
    log("");
    for (const r of bad) {
      log(c.red(`  ${r.slug}`));
      for (const p of r.problems) log(`      ${p}`);
    }
    if (missing.length) {
      log(c.yellow(`  missing specs: ${missing.map((r) => r.slug).join(", ")}`));
      log(c.dim("  Those tools will run P1-P10 but P4 will not verify their arithmetic."));
    }
    log("");
    if (bad.length) process.exitCode = 1;
  },

  async run() {
    const scope = scopeArgs();
    const d = discover(scope);
    const port = Number(flag("port", SERVER.port));
    const mode = has("prod") ? "prod" : "dev";
    const id = newRunId();

    log("");
    log(c.bold(`  QA run ${id}`));
    log(`  scope: ${scope.category ? `category ${scope.category}` : `${d.selected.length} named tools`} — ${d.selected.length} tools`);
    log(`  specs: ${d.selected.filter((t) => t.hasSpec).length}/${d.selected.length} present`);
    if (d.selected.some((t) => !t.hasSpec)) {
      log(c.yellow(`  ! ${d.selected.filter((t) => !t.hasSpec).length} tool(s) have no spec — P4 will not check their maths`));
    }
    log("");

    const server = await startServer({ mode, port, quiet: !has("verbose") });
    const started = Date.now();
    try {
      const run = await runScope({
        ...scope,
        origin: server.origin,
        runId: id,
        headed: has("headed"),
        onProgress: ({ index, total, tool }) => {
          const pct = String(Math.round((index / total) * 100)).padStart(3);
          log(c.dim(`  [${pct}%] ${String(index).padStart(3)}/${total}  ${tool.slug}`));
        },
      });
      printRunSummary(run);
      const html = buildReport(id);
      log("");
      log(`  report:  ${path.relative(PATHS.root, html)}`);
      log(`  raw:     reports/${id}/run.json`);
      log(`  elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
      log("");
      log(c.dim(`  Next: qa triage --run ${id}`));
      log("");
    } finally {
      if (has("keep-server")) server.detach?.();
      else await server.stop();
    }
  },

  async triage() {
    const id = currentRunId();
    const port = Number(flag("port", SERVER.port));
    const mode = has("prod") ? "prod" : "dev";
    const server = await startServer({ mode, port, quiet: !has("verbose") });
    try {
      log("");
      log(c.dim(`  re-running every failure ${LIMITS.recheckRuns}x in fresh browser contexts ...`));
      const q = await triage({
        runId: id,
        origin: server.origin,
        headed: has("headed"),
        onProgress: ({ index, total, slug, phases }) =>
          log(c.dim(`  [${index}/${total}] ${slug} — replaying ${phases.join(",") || "all phases"}`)),
      });
      printTriage(q);
      buildReport(id);
      log(`  report: reports/${id}/report.html`);
      log("");
      log(c.dim(`  Next: qa draft --run ${id}`));
      log("");
    } finally {
      if (has("keep-server")) server.detach?.();
      else await server.stop();
    }
  },

  async report() {
    const id = currentRunId();
    const out = buildReport(id);
    log(`  ${path.relative(PATHS.root, out)}`);
  },

  async draft() {
    const id = currentRunId();
    const sev = flag("severities", null);
    const r = scaffoldDrafts(id, sev && sev !== true ? { includeSeverities: sev.split(",").map((s) => s.trim()) } : {});
    log("");
    log(c.bold(`  ${r.written.length} draft(s) scaffolded in ${r.dir}`));
    for (const f of r.written) log(c.dim(`    ${f}`));
    if (r.skipped.length) {
      log("");
      log(c.dim(`  ${r.skipped.length} skipped:`));
      for (const s of r.skipped.slice(0, 20)) log(c.dim(`    ${s.tool ?? s.fingerprint}: ${s.why}`));
    }
    log("");
    log(c.yellow("  Each draft has three TODO sections that only source reading can fill:"));
    log(c.yellow("  Root cause, Suggested fix, Blast radius. Filing refuses any draft that"));
    log(c.yellow("  still contains a TODO or names no source file (HARD RULE 5.2)."));
    log("");
    log(c.dim(`  Next: Claude fills the drafts, then: qa file-issues --run ${id}`));
    log("");
  },

  async "file-issues"() {
    const id = currentRunId();
    const repo = String(flag("repo", DEFAULT_REPO));
    const dryRun = !has("confirm");

    const ready = await ghReady(repo);
    if (!ready.ok) {
      log(c.red(`  gh is not ready for ${repo}: ${ready.error}`));
      process.exit(1);
    }
    const results = await fileIssues({ runId: id, repo, dryRun, only: flag("only", null) });
    printFiling(results, dryRun);
    const creatable = results.filter((r) => r.action === "would-create").length;
    log("");
    if (dryRun && creatable) {
      log(c.yellow(`  ${creatable} issue(s) ready. Re-run with --confirm to create them on ${repo}.`));
    } else if (!dryRun) {
      log(c.green(`  ${results.filter((r) => r.action === "created").length} issue(s) created on ${repo}.`));
    }
    log("");
  },

  async doctor() {
    log("");
    const rows = [];
    rows.push(["site directory", fs.existsSync(PATHS.site) ? `ok — ${PATHS.site}` : `MISSING — ${PATHS.site}`]);
    rows.push(["config/tools.ts", fs.existsSync(PATHS.toolsConfig) ? "ok" : "MISSING"]);
    try {
      const d = discover({});
      rows.push(["tools discovered", `${d.total} (${d.all.filter((t) => t.route === "unrouted").length} unrouted)`]);
    } catch (e) { rows.push(["tools discovered", `FAILED — ${e.message}`]); }

    try {
      const { chromium } = await import("playwright");
      const b = await chromium.launch({ headless: true });
      const v = b.version();
      await b.close();
      rows.push(["playwright chromium", `ok — ${v}`]);
    } catch (e) { rows.push(["playwright chromium", `FAILED — ${truncate(e.message, 120)}`]); }

    const ready = await ghReady(DEFAULT_REPO);
    rows.push(["gh auth + repo", ready.ok ? `ok — ${DEFAULT_REPO}` : `FAILED — ${ready.error}`]);

    const specs = fs.existsSync(PATHS.specs) ? fs.readdirSync(PATHS.specs).filter((f) => f.endsWith(".json") && !f.startsWith("_")).length : 0;
    rows.push(["correctness specs", `${specs} file(s)`]);
    const ledger = readJson(PATHS.ledger, { filed: {} });
    rows.push(["issues already filed", String(Object.keys(ledger.filed).length)]);

    for (const [k, v] of rows) {
      const bad = /MISSING|FAILED/.test(v);
      log(`  ${bad ? c.red("x") : c.green("v")} ${k.padEnd(22)} ${bad ? c.red(v) : v}`);
    }
    log("");
  },
};

const handler = commands[cmd] ?? (cmd ? null : commands.help);
if (!handler) {
  log(c.red(`  unknown command: ${cmd}`));
  await commands.help();
  process.exit(2);
}
try {
  await handler();
} catch (e) {
  log("");
  log(c.red(`  ${e.message}`));
  if (process.env.QA_DEBUG) log(c.dim(String(e.stack)));
  process.exit(1);
}
