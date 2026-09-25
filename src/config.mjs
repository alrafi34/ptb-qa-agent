import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// qa-agent is its own repo, kept beside the site it tests rather than inside
// it. QA_SITE overrides the location if the two are ever checked out apart.
export const ROOT = path.resolve(__dirname, "..");
export const SITE = process.env.QA_SITE
  ? path.resolve(process.env.QA_SITE)
  : path.resolve(ROOT, "..", "productive-tb");

export const PATHS = {
  root: ROOT,
  site: SITE,
  toolsConfig: path.join(SITE, "config", "tools.ts"),
  toolsDir: path.join(SITE, "tools"),
  appTools: path.join(SITE, "app", "tools"),
  specs: path.join(ROOT, "specs"),
  reports: path.join(ROOT, "reports"),
  drafts: path.join(ROOT, "drafts"),
  state: path.join(ROOT, "state"),
  ledger: path.join(ROOT, "state", "issue-ledger.json"),
  flaky: path.join(ROOT, "state", "flaky-log.json"),
  lastRun: path.join(ROOT, "state", "last-run.json"),
  rules: path.join(ROOT, "QA_RULES.md"),
};

export const SERVER = {
  port: Number(process.env.QA_PORT || 4333),
  get origin() { return `http://127.0.0.1:${this.port}`; },
  // Next dev compiles a route on first request; the first hit on a cold page
  // can legitimately take a long time on the 1,859 KB dynamic route.
  bootTimeoutMs: 180_000,
  firstHitTimeoutMs: 180_000,
};

export const LIMITS = {
  navTimeoutMs: 90_000,
  settleMs: 450,          // debounce headroom — tools debounce at ~100ms
  actionTimeoutMs: 15_000,
  recheckRuns: 3,         // HARD RULE 5.1
  phaseTimeoutMs: Number(process.env.QA_PHASE_TIMEOUT_MS || 480_000), // past this the page froze — see runner.mjs
  recheckMustFail: 3,     // 3/3 or it is FLAKY
};

export const VIEWPORTS = [
  { name: "mobile",  width: 375,  height: 812 },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

// HARD RULE P6 — these must never reach rendered output.
export const POISON_PATTERNS = [
  { id: "nan",        re: /(^|[^A-Za-z])NaN([^A-Za-z]|$)/,          label: "NaN" },
  { id: "infinity",   re: /(^|[^A-Za-z])-?Infinity([^A-Za-z]|$)/,   label: "Infinity" },
  { id: "undefined",  re: /(^|[^A-Za-z])undefined([^A-Za-z]|$)/,    label: "undefined" },
  { id: "null-text",  re: /(^|[^A-Za-z])null([^A-Za-z]|$)/,         label: "null" },
  { id: "object",     re: /\[object (Object|Array|Null|Undefined)\]/, label: "[object Object]" },
  { id: "react-err",  re: /Minified React error|Objects are not valid as a React child/, label: "React error" },
  { id: "placeholder",re: /\b(TODO|FIXME|Lorem ipsum dolor sit amet, consectetur adipiscing elit\. TODO)\b/, label: "placeholder text" },
];

// Console noise that is not a defect.
export const CONSOLE_IGNORE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /webpack-hmr|hot-update/i,
  /Vercel (Analytics|Speed Insights)/i,
  /va\.vercel-scripts\.com/i,
  /_vercel\/insights|_vercel\/speed-insights/i,
  /React Router Future Flag/i,
  /Image with src .* was detected as the Largest Contentful Paint/i,
  /source-map|sourcemap/i,
];

export const SEVERITIES = ["S1-critical", "S2-major", "S3-minor", "S4-note"];
