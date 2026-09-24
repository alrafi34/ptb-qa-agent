/**
 * Browser-side inspection. Everything here runs inside the page.
 *
 * The site has no test ids, so controls are located structurally (an
 * :nth-child path from <body>), which is stable for the lifetime of one page
 * session — long enough for a phase — and needs no changes to the site.
 */

/* ---------- shared in-page source, injected once per page ---------- */

const PAGE_HELPERS = `
window.__qa = (function () {
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const idx = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + idx + ")");
      node = parent;
    }
    return "html > " + parts.join(" > ");
  }

  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\\s+/).map(function (id) {
        const n = document.getElementById(id);
        return n ? n.textContent.trim() : "";
      }).filter(Boolean).join(" ");
      if (t) return t;
    }

    // A button, link or summary names itself. This has to come before the
    // sibling-label heuristics below: buttons on this site are stacked as
    // siblings, so walking backwards would name "Show History" after the
    // "Reset" button sitting above it.
    var selfLabelled = el.tagName === "BUTTON" || el.tagName === "A" ||
      el.tagName === "SUMMARY" || el.getAttribute("role") === "button";
    if (selfLabelled) {
      const own = (el.textContent || "").trim();
      if (own) return own;
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim();
      const val = el.getAttribute("value");
      if (val && val.trim()) return val.trim();
      return "";
    }

    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      const t = wrapping.textContent.replace(el.value || "", "").trim();
      if (t) return t;
    }

    // Label rendered as a sibling above the control — the pattern this site
    // uses. A neighbouring control is never this control's label.
    function usableLabel(node) {
      if (!node) return null;
      if (node.matches("button, a, input, select, textarea, [role=button]")) return null;
      if (node.querySelector("input, select, textarea, button, [role=button]")) return null;
      const t = (node.textContent || "").trim();
      return t && t.length < 120 ? t : null;
    }

    let probe = el.previousElementSibling;
    let hops = 0;
    while (probe && hops < 3) {
      const t = usableLabel(probe);
      if (t) return t;
      probe = probe.previousElementSibling;
      hops++;
    }
    const wrap = el.parentElement;
    if (wrap) {
      let p = wrap.previousElementSibling;
      let h = 0;
      while (p && h < 2) {
        const t = usableLabel(p);
        if (t) return t;
        p = p.previousElementSibling;
        h++;
      }
    }

    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return "(placeholder) " + ph.trim();
    return "";
  }

  function chromeAncestor(el) {
    return !!el.closest("header, footer, nav, [role=banner], [role=contentinfo], [role=navigation]");
  }

  function controls(opts) {
    opts = opts || {};
    const sel = "input, select, textarea, button, [role=button], [role=switch], [role=slider], [role=tab], [contenteditable=true]";
    const main = document.querySelector("main") || document.body;
    const out = [];
    main.querySelectorAll(sel).forEach(function (el) {
      if (chromeAncestor(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
      if (type === "hidden") return;
      const isInput = tag === "input" || tag === "select" || tag === "textarea" || el.isContentEditable;
      out.push({
        selector: cssPath(el),
        tag: tag,
        type: type,
        role: el.getAttribute("role") || null,
        kind: isInput ? "input" : "action",
        name: accName(el),
        text: (el.textContent || "").trim().slice(0, 80),
        value: el.value !== undefined ? String(el.value) : null,
        checked: el.checked === undefined ? null : !!el.checked,
        min: el.getAttribute("min"),
        max: el.getAttribute("max"),
        step: el.getAttribute("step"),
        maxLength: el.getAttribute("maxlength"),
        required: el.hasAttribute("required"),
        disabled: !!el.disabled,
        readOnly: !!el.readOnly,
        visible: visible(el),
        options: tag === "select"
          ? Array.prototype.map.call(el.options, function (o) { return { value: o.value, label: o.textContent.trim() }; })
          : null,
        inputMode: el.getAttribute("inputmode"),
        pattern: el.getAttribute("pattern"),
        placeholder: el.getAttribute("placeholder"),
        box: (function () { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        tabIndex: el.tabIndex,
      });
    });
    return out;
  }

  /** Smallest element containing every form control — the live tool UI. */
  function toolRoot() {
    const main = document.querySelector("main") || document.body;
    const els = Array.prototype.filter.call(
      main.querySelectorAll("input, select, textarea, [contenteditable=true]"),
      function (el) { return !chromeAncestor(el) && visible(el); }
    );
    if (!els.length) {
      const art = main.querySelector("article") || main;
      return art;
    }
    let node = els[0];
    while (node && node !== main) {
      const all = els.every(function (e) { return node.contains(e); });
      if (all) break;
      node = node.parentElement;
    }
    return node || main;
  }

  /** Text of the live region, with long-form SEO prose excluded. */
  function liveText() {
    const root = toolRoot();
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach(function (n) { n.remove(); });
    // Long prose blocks inside the tool region are explanatory copy, not output.
    clone.querySelectorAll("p, li, details, summary").forEach(function (n) {
      if ((n.textContent || "").trim().length > 220) n.remove();
    });
    return (clone.innerText || clone.textContent || "").replace(/\\s+/g, " ").trim();
  }

  /** Whole-main text. Static copy cancels out when two snapshots are diffed. */
  function mainText() {
    const main = document.querySelector("main") || document.body;
    const clone = main.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, header, footer, nav").forEach(function (n) { n.remove(); });
    return (clone.innerText || clone.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function controlValues() {
    const main = document.querySelector("main") || document.body;
    const out = {};
    main.querySelectorAll("input, select, textarea").forEach(function (el) {
      if (chromeAncestor(el)) return;
      out[cssPath(el)] = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : String(el.value);
    });
    return out;
  }

  function snapshot() {
    return {
      live: liveText(),
      main: mainText(),
      values: controlValues(),
      canvasCount: document.querySelectorAll("main canvas").length,
      svgCount: document.querySelectorAll("main svg").length,
      imgCount: document.querySelectorAll("main img").length,
      downloadHrefs: Array.prototype.map.call(
        document.querySelectorAll("main a[download], main a[href^='blob:'], main a[href^='data:']"),
        function (a) { return (a.getAttribute("href") || "").slice(0, 40); }
      ),
    };
  }

  function meta() {
    const ld = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      try { ld.push({ ok: true, type: (JSON.parse(s.textContent)["@type"]) || null }); }
      catch (e) { ld.push({ ok: false, error: String(e.message), head: (s.textContent || "").slice(0, 120) }); }
    });
    const h1 = Array.prototype.map.call(document.querySelectorAll("h1"), function (h) { return h.textContent.trim(); });
    const headings = Array.prototype.map.call(document.querySelectorAll("main h1, main h2, main h3"), function (h) {
      return { level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 100) };
    });
    return {
      title: document.title,
      description: (document.querySelector('meta[name="description"]') || {}).content || null,
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
      ogTitle: (document.querySelector('meta[property="og:title"]') || {}).content || null,
      ogImage: (document.querySelector('meta[property="og:image"]') || {}).content || null,
      robots: (document.querySelector('meta[name="robots"]') || {}).content || null,
      h1: h1,
      headings: headings,
      jsonLd: ld,
      lang: document.documentElement.lang || null,
      is404: /404|not found|page could not be found/i.test((document.querySelector("h1") || {}).textContent || "")
             || /404/.test(document.title),
    };
  }

  function overflow() {
    const de = document.documentElement;
    const pageOverflow = de.scrollWidth - de.clientWidth;
    const offenders = [];
    if (pageOverflow > 1) {
      const vw = de.clientWidth;
      document.querySelectorAll("main *").forEach(function (el) {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        if (r.right > vw + 1 || r.left < -1) {
          const s = getComputedStyle(el);
          if (s.overflowX === "auto" || s.overflowX === "scroll") return;
          if (el.closest("[style*='overflow'], .overflow-x-auto, .overflow-auto, .overflow-scroll")) return;
          offenders.push({
            selector: cssPath(el),
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().slice(0, 60),
            right: Math.round(r.right),
            viewport: vw,
          });
        }
      });
    }
    // Controls pushed outside the viewport or collapsed to nothing.
    const broken = [];
    document.querySelectorAll("main input, main select, main textarea, main button").forEach(function (el) {
      if (chromeAncestor(el)) return;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return;
      if (r.width < 2 || r.height < 2) {
        broken.push({ selector: cssPath(el), reason: "zero-size", w: Math.round(r.width), h: Math.round(r.height), name: accName(el) });
      }
    });
    return { pageOverflow: pageOverflow, offenders: offenders.slice(0, 12), brokenControls: broken.slice(0, 12) };
  }

  function a11y() {
    const issues = [];
    const main = document.querySelector("main") || document.body;
    main.querySelectorAll("input, select, textarea, button, [role=button]").forEach(function (el) {
      if (chromeAncestor(el) || !visible(el)) return;
      const n = accName(el);
      if (!n) {
        issues.push({ kind: "no-accessible-name", selector: cssPath(el), tag: el.tagName.toLowerCase(), type: el.type || null });
      } else if (n.indexOf("(placeholder)") === 0 && el.tagName !== "BUTTON") {
        issues.push({ kind: "placeholder-as-label", selector: cssPath(el), name: n });
      }
      if (el.tabIndex > 0) {
        issues.push({ kind: "positive-tabindex", selector: cssPath(el), tabIndex: el.tabIndex });
      }
    });
    main.querySelectorAll("img").forEach(function (img) {
      if (!img.hasAttribute("alt")) issues.push({ kind: "img-missing-alt", selector: cssPath(img), src: (img.getAttribute("src") || "").slice(0, 80) });
    });
    return issues.slice(0, 25);
  }

  return {
    cssPath: cssPath, controls: controls, snapshot: snapshot, liveText: liveText,
    mainText: mainText, meta: meta, overflow: overflow, a11y: a11y,
    controlValues: controlValues, toolRootPath: function () { return cssPath(toolRoot()); },
  };
})();
true;
`;

async function ensure(page) {
  const has = await page.evaluate(() => typeof window.__qa === "object").catch(() => false);
  if (!has) await page.evaluate(PAGE_HELPERS);
}

export async function inventory(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.controls());
}

export async function snapshot(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.snapshot());
}

export async function liveText(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.liveText());
}

export async function pageMeta(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.meta());
}

export async function overflowReport(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.overflow());
}

export async function a11yReport(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.a11y());
}

export async function toolRootPath(page) {
  await ensure(page);
  return page.evaluate(() => window.__qa.toolRootPath());
}

/** Text present after an action that was not present before it. */
export function addedText(before, after) {
  const b = new Set(before.split(/(?<=[.,;:%\s])/).map((s) => s.trim()).filter(Boolean));
  return after
    .split(/(?<=[.,;:%\s])/)
    .map((s) => s.trim())
    .filter((s) => s && !b.has(s))
    .join(" ");
}
