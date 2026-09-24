import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

export function runId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Stable fingerprint for dedupe — HARD RULE 7.2 layer 1. */
export function fingerprint(parts) {
  const norm = (v) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[‘’“”]/g, "'")
      .trim();
  return crypto
    .createHash("sha1")
    .update(parts.map(norm).join(" "))
    .digest("hex")
    .slice(0, 16);
}

/** Whitespace the browser renders but a regex should treat as a plain space. */
const ODD_SPACE = /[      ]/g;

/** Pull the first number out of a string the way a reader would. */
export function parseNumber(text) {
  if (text == null) return null;
  const m = String(text)
    .replace(ODD_SPACE, " ")
    .match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** All numbers in a string, comma-groups collapsed. */
export function parseAllNumbers(text) {
  if (text == null) return [];
  const out = [];
  const re = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const src = String(text).replace(ODD_SPACE, " ");
  let m;
  while ((m = re.exec(src))) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Tolerance comparison — HARD RULE 5.4. */
export function withinTolerance(actual, expected, tol) {
  if (actual == null || expected == null) return false;
  const t = tol ?? {};
  if (t.abs != null) return Math.abs(actual - expected) <= t.abs;
  const rel = t.rel ?? 0.005; // default 0.5%
  if (expected === 0) return Math.abs(actual) <= (t.abs ?? 1e-9);
  return Math.abs((actual - expected) / expected) <= rel;
}

export function normaliseText(s) {
  return String(s ?? "").replace(ODD_SPACE, " ").replace(/\s+/g, " ").trim();
}

export function truncate(s, n = 600) {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n)}... [${t.length - n} more chars]`;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ESC = String.fromCharCode(27);
const wrap = (code) => (s) => `${ESC}[${code}m${s}${ESC}[0m`;

export const c = {
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  bold: wrap(1),
};

export function log(...a) { console.log(...a); }
