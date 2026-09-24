import { LIMITS } from "./config.mjs";
import { sleep } from "./util.mjs";

/**
 * Driving controls the way a person would: type into the field, fire the events
 * React listens for, and wait out the debounce before reading anything back.
 */

/**
 * Playwright's actionability wait is the right default for a control that is
 * merely slow, but on one that is missing, hidden, disabled or readonly it can
 * never succeed — it just burns actionTimeoutMs. P5 pushes ~20 abuse values
 * through every input, so a single unfillable field cost 20 x 15s. Read the
 * state directly instead: one evaluate, no waiting.
 */
async function elementState(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      missing: false,
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      readOnly: !!el.readOnly,
      // offsetParent is null for display:none and for fixed elements; the rect
      // check covers the latter.
      hidden:
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        (el.offsetParent === null && el.getClientRects().length === 0),
    };
  }, selector);
}

/**
 * Why a control cannot be driven, or null if it can. `needsEditable` is false
 * for clicks and checkbox toggles, which work on a readonly element.
 */
async function blockedReason(page, selector, needsEditable) {
  // Hydration can leave a control briefly unactionable, so a negative verdict
  // is confirmed once after a short settle rather than trusted immediately.
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await elementState(page, selector);
    let reason = null;
    if (st.missing) reason = `control not present in the DOM (${selector})`;
    else if (st.hidden) reason = "control is not visible";
    else if (st.disabled) reason = "control is disabled";
    else if (needsEditable && st.readOnly) reason = "control is readonly";
    if (!reason) return null;
    if (attempt === 0) await sleep(300);
    else return reason;
  }
  return null;
}

export async function setControl(page, ctl, value) {
  const loc = page.locator(ctl.selector).first();
  const kind = ctl.type;

  // The evaluate-based branches (range, color, contenteditable) set the value
  // directly and do not wait on actionability, so they are not gated here.
  const gated = kind !== "range" && kind !== "color" && kind !== "file";
  if (gated) {
    const needsEditable = !(kind === "checkbox" || kind === "radio");
    const blocked = await blockedReason(page, ctl.selector, needsEditable);
    if (blocked) return { ok: false, error: blocked };
  }

  try {
    if (kind === "checkbox" || kind === "radio") {
      const want = value === true || value === "true" || value === 1;
      if (want) await loc.check({ force: true, timeout: LIMITS.actionTimeoutMs });
      else await loc.uncheck({ force: true, timeout: LIMITS.actionTimeoutMs });
    } else if (ctl.tag === "select") {
      await loc.selectOption(String(value), { timeout: LIMITS.actionTimeoutMs });
    } else if (kind === "range") {
      // Range inputs ignore fill(); set the value and fire React's events.
      await page.evaluate(
        ([sel, val]) => {
          const el = document.querySelector(sel);
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, String(val));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        [ctl.selector, value]
      );
    } else if (kind === "color") {
      await page.evaluate(
        ([sel, val]) => {
          const el = document.querySelector(sel);
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, String(val));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        [ctl.selector, value]
      );
    } else if (kind === "file") {
      return { ok: false, skipped: "file input handled by fixture step" };
    } else if (ctl.tag === "textarea" || ctl.tag === "input" || ctl.role === "textbox") {
      await loc.fill(String(value), { timeout: LIMITS.actionTimeoutMs });
      // Some tools only recompute on blur/keyup.
      await loc.dispatchEvent("input").catch(() => {});
      await loc.dispatchEvent("change").catch(() => {});
    } else {
      await page.evaluate(
        ([sel, val]) => {
          const el = document.querySelector(sel);
          if (el && el.isContentEditable) {
            el.textContent = String(val);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
        [ctl.selector, value]
      );
    }
    await sleep(LIMITS.settleMs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.split("\n")[0] };
  }
}

export async function clickControl(page, ctl) {
  const blocked = await blockedReason(page, ctl.selector, false);
  if (blocked) return { ok: false, error: blocked };
  try {
    await page.locator(ctl.selector).first().click({ timeout: LIMITS.actionTimeoutMs });
    await sleep(LIMITS.settleMs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.split("\n")[0] };
  }
}

export async function readControl(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    if (el.type === "checkbox" || el.type === "radio") return String(el.checked);
    return el.value !== undefined ? String(el.value) : (el.textContent || "");
  }, selector);
}

/**
 * A plausible in-range value for a control, used by the live-logic sweep (P3)
 * where only "does this input move the output" matters. Correctness values
 * never come from here — HARD RULE 2.1 keeps those in the spec files.
 */
export function probeValueFor(ctl, variant = 0) {
  const name = `${ctl.name} ${ctl.placeholder ?? ""} ${ctl.text}`.toLowerCase();
  const min = ctl.min != null && ctl.min !== "" ? Number(ctl.min) : null;
  const max = ctl.max != null && ctl.max !== "" ? Number(ctl.max) : null;

  if (ctl.tag === "select") {
    const opts = (ctl.options ?? []).filter((o) => o.value !== "");
    if (!opts.length) return null;
    return opts[Math.min(variant + (opts.length > 1 ? 1 : 0), opts.length - 1)].value;
  }
  if (ctl.type === "checkbox" || ctl.type === "radio") return variant % 2 === 0;
  if (ctl.type === "color") return ["#3366cc", "#cc3366"][variant % 2];
  if (ctl.type === "date") return ["1990-06-15", "2000-01-01"][variant % 2];
  if (ctl.type === "time") return ["09:30", "17:45"][variant % 2];
  if (ctl.type === "email") return ["qa@example.com", "second@example.org"][variant % 2];
  if (ctl.type === "url") return ["https://example.com/a", "https://example.org/b"][variant % 2];

  if (isNumericControl(ctl)) {
    const lo = min ?? 1;
    const hi = max ?? (min != null ? min + 100 : 100);
    const span = hi - lo || 1;
    const picks = [lo + span * 0.4, lo + span * 0.7, lo + span * 0.15];
    let v = picks[variant % picks.length];
    const step = ctl.step && ctl.step !== "any" ? Number(ctl.step) : null;
    if (step && Number.isFinite(step) && step > 0) v = Math.round(v / step) * step;
    if (!Number.isFinite(v)) v = 10;
    // Keep integers integral so the tool's own display rounding stays readable.
    const out = Number.isInteger(step ?? 1) && Number.isInteger(v) ? v : Number(v.toFixed(4));
    return String(out);
  }

  // Free text — bias the sample toward what the field is asking for.
  if (/text|content|paragraph|essay|article|message|body/.test(name)) {
    return [
      "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.",
      "Second sample sentence for QA. It has different length and word count entirely.",
    ][variant % 2];
  }
  if (/json/.test(name)) return ['{"a":1,"b":[2,3]}', '{"x":"y"}'][variant % 2];
  if (/url|link|domain/.test(name)) return ["https://example.com/page", "https://test.org"][variant % 2];
  if (/name|title|keyword|word/.test(name)) return ["Sample Title", "Another Keyword"][variant % 2];
  if (/password/.test(name)) return ["Str0ng!Passw0rd", "an0ther#Secret1"][variant % 2];
  if (/color|hex/.test(name)) return ["#3366cc", "#cc3366"][variant % 2];

  return variant % 2 === 0 ? "QA sample input" : "Second QA value";
}

/**
 * Whether a control really takes a number.
 *
 * An empty text field is not evidence of anything — a textarea waiting for an
 * essay also has an empty value — so this looks at the type, the numeric
 * attributes, and the wording of the label, and never at the current value.
 */
export function isNumericControl(ctl) {
  if (ctl.tag === "textarea" || ctl.type === "textarea") return false;
  if (ctl.tag === "select" || ctl.type === "checkbox" || ctl.type === "radio") return false;
  if (ctl.type === "number" || ctl.type === "range") return true;
  if (/^(numeric|decimal)$/i.test(ctl.inputMode ?? "")) return true;
  if (ctl.min != null && ctl.min !== "") return true;
  if (ctl.step != null && ctl.step !== "" && ctl.step !== "any") return true;
  // A placeholder that is itself a number, e.g. "0", "100", "1.5".
  if (/^\s*-?\d+(\.\d+)?\s*$/.test(ctl.placeholder ?? "")) return true;
  // A plain text input whose label names a measurable quantity.
  return NUMERIC_LABEL.test(`${ctl.name ?? ""} ${ctl.placeholder ?? ""}`);
}

const NUMERIC_LABEL = /\b(amount|quantity|qty|count|number of|length|width|height|depth|area|volume|weight|mass|radius|diameter|distance|price|cost|rate|percent|percentage|voltage|current|resistance|power|watts?|amps?|volts?|ohms?|load|pressure|temperature|speed|velocity|budget|salary|income|principal|balance|years?|months?|days?|hours?|minutes?|span|thickness|spacing|size|capacity|density|flow|frequency)\b/i;

/**
 * Edge cases every numeric or text control must survive (P5). None of these may
 * produce NaN, Infinity, a crash, or a silently wrong number.
 */
export function boundaryCasesFor(ctl) {
  if (ctl.tag === "select" || ctl.type === "checkbox" || ctl.type === "radio" ||
      ctl.type === "color" || ctl.type === "file" || ctl.type === "date" ||
      ctl.type === "time" || ctl.type === "email" || ctl.type === "url") return [];

  if (isNumericControl(ctl)) {
    return [
      { label: "empty", value: "", expect: "graceful" },
      { label: "zero", value: "0", expect: "graceful" },
      { label: "negative", value: "-5", expect: "graceful" },
      { label: "very large", value: "999999999999", expect: "graceful" },
      { label: "very small", value: "0.0000001", expect: "graceful" },
      { label: "non-numeric", value: "abc", expect: "graceful" },
      { label: "whitespace", value: "   ", expect: "graceful" },
      { label: "leading zeros", value: "007", expect: "graceful" },
      { label: "scientific", value: "1e10", expect: "graceful" },
      { label: "comma decimal", value: "1,5", expect: "graceful" },
    ];
  }
  return [
    { label: "empty", value: "", expect: "graceful" },
    { label: "whitespace only", value: "    ", expect: "graceful" },
    { label: "unicode", value: "emoji test 😀 中文 عربى", expect: "graceful" },
    { label: "html injection", value: "<script>alert(1)</script><b>x</b>", expect: "graceful" },
    { label: "long paste", value: "lorem ipsum dolor sit amet ".repeat(400), expect: "graceful" },
    { label: "newlines", value: "line one\n\nline two\n\n\nline three", expect: "graceful" },
  ];
}

/** Buttons whose job we can recognise from their label. */
export function classifyAction(ctl) {
  const t = `${ctl.name} ${ctl.text}`.toLowerCase();
  if (/\b(reset|clear|start over)\b/.test(t)) return "reset";
  if (/\bcopy\b/.test(t)) return "copy";
  if (/\b(download|export|save as|\.csv|\.txt|\.png|\.pdf|\.json)\b/.test(t)) return "download";
  if (/\b(calculate|convert|compute|generate|run|analyz|analys|check|submit|go)\b/.test(t)) return "compute";
  if (/\b(swap|switch|reverse|invert|toggle)\b/.test(t)) return "toggle";
  if (/\b(history|recent|saved)\b/.test(t)) return "history";
  if (/\b(print|share|tweet)\b/.test(t)) return "external";
  return "other";
}
