import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";

/**
 * Builds the authoritative tool manifest.
 *
 * The site serves tool pages through two parallel routing schemes, and
 * `config/tools.ts` is the only data-only list of all of them, so it is the
 * source of truth for scope. Whether a slug actually resolves is a separate
 * question answered here, because "listed on the category page but 404s" is
 * itself a defect class worth catching.
 */

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function parseToolEntries(src) {
  // Entries are written one per line as object literals.
  const out = [];
  const re = /\{\s*slug:\s*"([^"]+)"\s*,\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*description:\s*"((?:[^"\\]|\\.)*)"\s*,\s*category:\s*"([^"]+)"\s*,\s*icon:\s*"([^"]*)"\s*,\s*free:\s*(true|false)\s*\}/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({
      slug: m[1],
      name: m[2].replace(/\\"/g, '"'),
      description: m[3].replace(/\\"/g, '"'),
      category: m[4],
      icon: m[5],
      free: m[6] === "true",
    });
  }
  return out;
}

function parseCategories(src) {
  const start = src.indexOf("export const categories");
  if (start < 0) return [];
  const block = src.slice(start, src.indexOf("];", start));
  const out = [];
  const re = /\{\s*slug:\s*"([^"]+)"\s*,\s*name:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(block))) out.push({ slug: m[1], name: m[2] });
  return out;
}

/** Slugs the dynamic [tool]/[subtool] route can serve. */
function parseDynamicRouteSlugs() {
  const p = path.join(PATHS.appTools, "[tool]", "[subtool]", "page.tsx");
  const src = read(p);
  if (!src) return new Set();

  // alias -> tool directory, from the config imports at the top of the file
  const aliasToDir = new Map();
  const impRe = /import\s*\{\s*(?:toolConfig\s+as\s+)?([A-Za-z0-9_$]+)\s*\}\s*from\s*"@\/tools\/([^/"]+)\/config"/g;
  let m;
  while ((m = impRe.exec(src))) aliasToDir.set(m[1], m[2]);

  // TOOLS array entries reference those aliases
  const startIdx = src.indexOf("const TOOLS");
  if (startIdx < 0) return new Set();
  const endIdx = src.indexOf("\n];", startIdx);
  const block = src.slice(startIdx, endIdx < 0 ? undefined : endIdx);

  const slugs = new Set();
  const entryRe = /\{\s*config:\s*([A-Za-z0-9_$]+)\s*,/g;
  while ((m = entryRe.exec(block))) {
    const dir = aliasToDir.get(m[1]);
    if (dir) slugs.add(dir);
  }
  return slugs;
}

/** Read the slug a tool's own config.ts declares, when it has one. */
function declaredSlug(toolDir) {
  const src = read(path.join(PATHS.toolsDir, toolDir, "config.ts"));
  const m = src.match(/slug:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function discover({ category = null, tools: only = null } = {}) {
  const src = read(PATHS.toolsConfig);
  if (!src) throw new Error(`Cannot read ${PATHS.toolsConfig}`);

  const categories = parseCategories(src);
  const dynamicSlugs = parseDynamicRouteSlugs();
  const all = parseToolEntries(src);

  // config/tools.ts has duplicate slugs in places; first entry wins, and the
  // duplicate is recorded because it is worth reporting on its own.
  const seen = new Map();
  const duplicates = [];
  for (const t of all) {
    if (seen.has(t.slug)) { duplicates.push(t.slug); continue; }
    seen.set(t.slug, t);
  }

  const manifest = [...seen.values()].map((t) => {
    const dedicatedPath = path.join(PATHS.appTools, t.category, t.slug, "page.tsx");
    const hasDedicated = fs.existsSync(dedicatedPath);
    const inDynamic = dynamicSlugs.has(t.slug);
    const toolDir = path.join(PATHS.toolsDir, t.slug);
    const hasSource = fs.existsSync(toolDir);

    return {
      ...t,
      url: `/tools/${t.category}/${t.slug}`,
      route: hasDedicated ? "dedicated" : inDynamic ? "dynamic" : "unrouted",
      routeFile: hasDedicated
        ? path.relative(PATHS.site, dedicatedPath)
        : inDynamic
          ? "app/tools/[tool]/[subtool]/page.tsx"
          : null,
      sourceDir: hasSource ? path.relative(PATHS.site, toolDir) : null,
      files: hasSource
        ? fs.readdirSync(toolDir).filter((f) => !f.startsWith("."))
        : [],
      declaredSlug: hasSource ? declaredSlug(t.slug) : null,
      specPath: path.join(PATHS.specs, `${t.slug}.json`),
      hasSpec: fs.existsSync(path.join(PATHS.specs, `${t.slug}.json`)),
    };
  });

  let selected = manifest;
  if (category) {
    const cats = String(category).split(",").map((s) => s.trim()).filter(Boolean);
    selected = selected.filter((t) => cats.includes(t.category));
  }
  if (only) {
    const set = new Set(String(only).split(",").map((s) => s.trim()).filter(Boolean));
    selected = selected.filter((t) => set.has(t.slug));
  }

  return {
    categories,
    total: manifest.length,
    duplicates,
    all: manifest,
    selected: selected.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

export function summarise(d) {
  const byCat = new Map();
  for (const t of d.all) byCat.set(t.category, (byCat.get(t.category) || 0) + 1);
  return {
    total: d.total,
    duplicateSlugs: d.duplicates,
    byCategory: [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, count]) => ({
        slug,
        count,
        name: d.categories.find((c) => c.slug === slug)?.name ?? slug,
      })),
  };
}
