// Match link and glyph geometry in PDF coordinates. PDFView hit-testing runs
// synchronously; its owner primes the original link and bibliography caches.
var refineCitedReferences = (() => {
  const layouts = new WeakMap();
  const records = new WeakMap();
  const yearPattern = /(?:18|19|20)\d{2}[a-z]?/gi;
  const authorDates = /([\p{Lu}][\p{L}\p{M}’'\-]+)(?:\s+et\s+al\.?|\s+(?:&|and)\s+[\p{Lu}][\p{L}\p{M}’'\-]+)?\s*,?\s*\(?\s*((?:18|19|20)\d{2}[a-z]?)(?![\p{L}\d])/gu;
  const hanDates = /(?:根据|参见|例如|据|见|如)?([\p{Script=Han}]{1,6}?)(?:等人?)?\s*[,（(]\s*((?:18|19|20)\d{2}[a-z]?)/gu;

  function normalize(value) {
    return String(value || "").normalize("NFKD").toLowerCase()
      .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  }
  function orderedRect(r) {
    if (!r || r.length !== 4 || !Array.from(r).every(Number.isFinite)) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]),
      Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }
  function distance(point, rect) {
    return Math.hypot(Math.max(0, rect[0] - point[0], point[0] - rect[2]),
      Math.max(0, rect[1] - point[1], point[1] - rect[3]));
  }

  function record(ref) {
    if (records.has(ref)) return records.get(ref);
    const text = ref.chars?.length
      ? Array.from(ref.chars).filter(c => !c.ignorable)
        .map(c => (c.c || "") + (c.spaceAfter || c.lineBreakAfter ? " " : "")).join("").trim()
      : String(ref.text || "").trim();
    const stripped = text.normalize("NFKC").replace(/^\s*(?:\[\s*\d+\s*\]|\d{1,3}[.)])\s*/, "");
    // Inverted ("Yang, S., …") and natural ("S. Yang, …") author order.
    // Only the first author's name is relevant, never a match on a coauthor.
    const first = stripped.split(/,|\s+(?:and|&)\s+|\s+et\s+al\b|\(\s*\d{4}/i)[0].trim();
    const names = first.match(/[\p{L}][\p{L}\p{M}’'\-]*/gu) || [];
    const noURL = stripped.replace(/https?\s*:\s*\/\s*\/[^\s;,)]*|\bdoi\s*:\s*[^\s,]+|\barxiv\s*:\s*[a-z.\-]*\/?[\d.]+(?:v\d+)?/gi, " ");
    const early = stripped.match(/^[^.;]{1,160}?\(\s*((?:18|19|20)\d{2}[a-z]?)\s*\)/i);
    const apa = stripped.match(/(?:\.\s*|,\s*|^)\(\s*((?:18|19|20)\d{2}[a-z]?)\s*\)\s*[.,]/i);
    const year = (apa?.[1] || early?.[1] || noURL.match(yearPattern)?.at(-1) || "").toLowerCase();
    const result = { text, surname: normalize(names.at(-1)), year };
    records.set(ref, result);
    return result;
  }
  function uniqueRefs(refs) {
    const seen = new Set();
    return Array.from(refs || []).filter(ref => {
      if (!ref || typeof ref !== "object") return false;
      const key = record(ref).text.replace(/\s+/g, " ").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function makeLayout(chars) {
    if (!chars?.length) return null;
    if (layouts.has(chars)) return layouts.get(chars);
    const bins = new Map();
    let text = "";
    for (const c of chars) {
      if (c.ignorable) continue;
      const pos = text.length;
      text += String(c.c || "").normalize("NFKC");
      const rect = orderedRect(c.rect || c.inlineRect);
      if (rect) {
        const glyph = { pos, rect };
        const bottom = Math.floor(rect[1] / 16);
        const top = Math.floor(rect[3] / 16);
        for (let y = bottom; y <= top; y++) {
          if (!bins.has(y)) bins.set(y, []);
          bins.get(y).push(glyph);
        }
      }
      if (c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter) text += " ";
    }
    const asSpan = m => ({ start: m.index, end: m.index + m[0].length,
      surname: normalize(m[1]), year: m[2].toLowerCase() });
    const spans = Array.from(text.matchAll(authorDates), asSpan);
    for (const m of text.matchAll(hanDates)) spans.push(asSpan(m));
    const numeric = Array.from(text.matchAll(/\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/g), m => ({
      start: m.index, end: m.index + m[0].length, group: /[,;–—-]/.test(m[0]), text: m[0],
    }));
    const result = { bins, spans, numeric };
    layouts.set(chars, result);
    return result;
  }
  function atPointer(layout, point) {
    if (!layout || !point || !Array.from(point).every(Number.isFinite)) return {};
    const glyphs = layout.bins.get(Math.floor(point[1] / 16)) || [];
    let best = Infinity, index = -1;
    for (const { pos, rect } of glyphs) {
      const d = distance(point, rect);
      if (d > 2) continue;
      const score = d * 1000 + Math.abs(point[0] - (rect[0] + rect[2]) / 2);
      if (score < best) {
        best = score;
        index = pos;
      }
    }
    if (index < 0) return {};
    const contains = span => span.start <= index && index < span.end;
    return { span: layout.spans.find(contains), numeric: layout.numeric.find(contains) };
  }
  function matchesSpan(span, ref) {
    const info = record(ref);
    return info.surname === span.surname && info.year === span.year;
  }
  function activeLink(links, point) {
    if (!point) return null;
    const hits = [];
    for (const link of links || []) {
      if (link.type && link.type !== "internal-link") continue;
      const rects = link.position?.rects || (link.rect ? [link.rect] : []);
      for (const raw of rects) {
        const rect = orderedRect(raw);
        if (!rect || distance(point, rect) > .25) continue;
        hits.push({ link, area: (rect[2] - rect[0]) * (rect[3] - rect[1]) });
        break;
      }
    }
    hits.sort((a, b) => a.area - b.area);
    if (hits.length > 1 && Math.abs(hits[1].area - hits[0].area) < .01 && hits[0].link !== hits[1].link) return null;
    return hits[0]?.link;
  }
  function targetCandidates(target) {
    if (!target || !Number.isInteger(target.pageIndex) || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return [];
    const scored = [];
    for (const ref of uniqueRefs(target.references)) {
      if (ref.position?.pageIndex !== target.pageIndex) continue;
      const line = orderedRect(ref.position.rects?.[0]);
      if (!line) continue;
      // XYZ destinations normally lie just above-left of the first line.
      // Never match solely by page, or select a row in the opposite column.
      const h = Math.max(4, Math.min(22, line[3] - line[1]));
      const dy = target.y - line[3], dx = Math.abs(target.x - line[0]);
      if (dx > 2.5 * h || dy < -.9 * h || dy > 2.5 * h) continue;
      scored.push({ ref, score: Math.abs(dy) + dx * .25 });
    }
    scored.sort((a, b) => a.score - b.score);
    if (scored.length > 1 && scored[1].score - scored[0].score < 2) return [];
    return scored.length ? [scored[0].ref] : [];
  }
  function numericGroup(span, native, getAllReferences) {
    if (native.length > 1) return native;
    const labels = new Set();
    for (const range of span.text.slice(1, -1).split(/[,;]/)) {
      const parts = range.trim().split(/\s*[-–—]\s*/).map(Number);
      const a = parts[0], b = parts.at(-1);
      if (!(a > 0 && b >= a && b - a < 40)) return [];
      for (let i = a; i <= b; i++) labels.add(i);
    }
    const all = uniqueRefs([...(getAllReferences?.() || []), ...native]);
    const result = [];
    for (const label of labels) {
      const rows = all.filter(ref => {
        const number = record(ref).text.match(/^\s*(?:\[\s*(\d+)\s*\]|(\d+)[.)])/u);
        return Number(number?.[1] || number?.[2]) === label;
      });
      if (rows.length !== 1) return [];
      result.push(rows[0]);
    }
    return result;
  }

  return function resolve({ pageData, overlay, point, getEmbeddedLinks, getReferencePage, getAllReferences }) {
    const empty = { references: [], precise: false };
    if (!overlay) return empty;
    const native = uniqueRefs(overlay.references);
    if (overlay.type === "reference") return { references: native, precise: native.length === 1 };
    const semantic = overlay.type === "citation";
    const hit = atPointer(makeLayout(pageData?.chars), point);
    const raw = activeLink(getEmbeddedLinks?.() || [], point)
      || (overlay.type === "internal-link" && overlay.source !== "matched" ? overlay : null);
    const target = raw && getReferencePage?.(raw);
    const viaLink = targetCandidates(target);
    // A grouped numeric citation can embed one link to its first member only.
    if (hit.numeric?.group) {
      const references = numericGroup(hit.numeric, native, getAllReferences);
      return { references, precise: false, hint: references.length ? undefined : "未能对应这组引文中的全部编号。" };
    }
    if (hit.numeric && native.length > 1) return { references: native, precise: false };
    if (viaLink.length && (semantic || hit.span || hit.numeric)
      && (!hit.span || matchesSpan(hit.span, viaLink[0]))) return { references: viaLink, precise: true };
    if (hit.span) {
      const all = uniqueRefs([...native, ...(target?.references || []), ...(getAllReferences?.() || [])]);
      const matches = all.filter(ref => matchesSpan(hit.span, ref));
      if (matches.length === 1 && (!viaLink.length || matchesSpan(hit.span, viaLink[0]))) {
        return { references: matches, precise: true };
      }
      if (matches.length) return { references: matches, precise: false, hint: "同名、同年或链接与文字不一致，请核对引文。" };
      return { references: [], precise: false, hint: "未能按第一作者和年份匹配这条引文。" };
    }
    return semantic ? { references: native, precise: native.length === 1 } : empty;
  };
})();
