import { chromium } from "playwright";
import { CONSOLE_IGNORE, LIMITS } from "./config.mjs";

/* Vercel injects these at the edge; a local server never has them, so their
   404s say nothing about the site. */
const VERCEL_ONLY = /\/_vercel\/(insights|speed-insights)\//;
import { sleep } from "./util.mjs";

/**
 * One browser for the run, one fresh context per tool.
 *
 * HARD RULE 3.2 — several tools persist history to localStorage, so state must
 * never survive from one tool to the next. A context per tool is the cheapest
 * way to guarantee that.
 */

export async function launchBrowser({ headed = false } = {}) {
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  return browser;
}

export async function openTool(browser, { origin, url, viewport }) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["clipboard-read", "clipboard-write"],
    // Deterministic rendering for screenshot comparison across runs.
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(LIMITS.actionTimeoutMs);
  context.setDefaultNavigationTimeout(LIMITS.navTimeoutMs);

  const diagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
  };

  const page = await context.newPage();

  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    if (CONSOLE_IGNORE.some((re) => re.test(text))) return;
    // "Failed to load resource" carries its URL in the location, not the text.
    const src = msg.location?.()?.url ?? "";
    if (src && VERCEL_ONLY.test(src)) return;
    diagnostics.console.push({
      type,
      text,
      location: msg.location?.() ?? null,
      at: Date.now(),
    });
  });

  page.on("pageerror", (err) => {
    diagnostics.pageErrors.push({
      message: err.message,
      stack: String(err.stack ?? "").split("\n").slice(0, 8).join("\n"),
      at: Date.now(),
    });
  });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    if (f && /net::ERR_ABORTED/.test(f.errorText)) return; // navigation races
    diagnostics.requestFailures.push({
      url: req.url(),
      method: req.method(),
      error: f?.errorText ?? "unknown",
    });
  });

  page.on("response", (res) => {
    if (res.status() >= 400 && !VERCEL_ONLY.test(res.url())) {
      diagnostics.responses.push({ url: res.url(), status: res.status() });
    }
  });

  const target = origin + url;
  let mainResponse = null;
  let navError = null;
  try {
    mainResponse = await page.goto(target, { waitUntil: "domcontentloaded" });
    // Tools debounce at ~100ms and several hydrate lazily via next/dynamic.
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await sleep(LIMITS.settleMs);
  } catch (e) {
    navError = e.message;
  }

  return {
    context,
    page,
    diagnostics,
    status: mainResponse?.status() ?? null,
    navError,
    target,
    close: async () => { await context.close().catch(() => {}); },
  };
}

/** Console/page errors that should count against the tool, formatted for a report. */
export function hardErrors(diagnostics) {
  return [
    ...diagnostics.pageErrors.map((e) => ({ kind: "pageerror", text: e.message, detail: e.stack })),
    ...diagnostics.console.filter((c) => c.type === "error").map((c) => ({
      kind: "console.error",
      text: c.text,
      detail: c.location ? `${c.location.url}:${c.location.lineNumber}` : null,
    })),
  ];
}

export function hydrationErrors(diagnostics) {
  const re = /hydrat|Text content does not match|did not match|server[- ]rendered HTML|server HTML/i;
  return [
    ...diagnostics.pageErrors.filter((e) => re.test(e.message)).map((e) => e.message),
    ...diagnostics.console.filter((c) => re.test(c.text)).map((c) => c.text),
  ];
}
