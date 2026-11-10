const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The packaged plugin is a Zotero bootstrap script, not a Node module.
const source = readFileSync(path.join(__dirname, "../src/precision.js"), "utf8");
const refine = vm.runInNewContext(source + "\nrefineCitedReferences;");

// PDFView delivers glyph coordinates in PDF space, with line breaks recorded
// on the final glyph. Keep the geometry simple while preserving reading order.
function pageFromLines(lines) {
  const chars = [];
  function coordinates(line, column) {
    return [20 + column * 5, 400 - line * 14];
  }
  lines.forEach((line, row) => {
    Array.from(line).forEach((c, column) => {
      const [x, y] = coordinates(row, column);
      chars.push({ c, rect: [x, y, x + 5, y + 10], lineBreakAfter: column === line.length - 1 });
    });
  });
  return {
    chars,
    at(row, needle) {
      const column = lines[row].indexOf(needle);
      assert.notEqual(column, -1);
      const [x, y] = coordinates(row, column);
      return [x + 2.5, y + 5];
    },
  };
}

function resolveAt(pageData, point, references, options = {}) {
  return refine({ pageData, point, overlay: { type: "citation", references }, ...options });
}

test("each author or year in a wrapped multi-citation selects its own reference", () => {
  const page = pageFromLines([
    "(Yang et al.,",
    "2024; Xia et al., 2023; Yang et al., 2023b; Zhang et al., 2024)",
  ]);
  const papers = [
    { text: "Yang, S. Paper on selection. 2024." },
    { text: "Xia, X. Paper on coresets. 2023." },
    { text: "Yang, S. Paper on pruning. 2023b." },
    { text: "Zhang, X. Paper on scoring. 2024." },
  ];
  const extra = [
    { text: "He, M., Yang, S. Paper by a different first author. 2024." },
    { text: "Yang, E. Another paper published in the same year. 2023a." },
  ];
  const pieces = [
    [0, "Yang", 0], [1, "2024;", 0],
    [1, "Xia", 1], [1, "2023;", 1],
    [1, "Yang", 2], [1, "2023b", 2],
    [1, "Zhang", 3], [1, "2024)", 3],
  ];
  for (const [row, token, expected] of pieces) {
    const result = resolveAt(page, page.at(row, token), [...extra, ...papers]);
    assert.equal(result.precise, true, token);
    assert.deepEqual(Array.from(result.references), [papers[expected]], token);
  }
});

test("the actual link destination breaks an otherwise ambiguous author-year tie", () => {
  const page = pageFromLines(["(Smith et al., 2020)"]);
  const point = page.at(0, "2020");
  const refs = [
    { text: "Smith, M. Paper A. 2020.", position: { pageIndex: 5, rects: [[30, 180, 175, 190]] } },
    { text: "Smith, S. Paper B. 2020.", position: { pageIndex: 5, rects: [[250, 180, 410, 190]] } },
  ];
  const ambiguous = resolveAt(page, point, refs);
  assert.equal(ambiguous.precise, false);
  assert.deepEqual(Array.from(ambiguous.references), refs);

  const [x, y] = point;
  const link = { type: "internal-link", rect: [x - 3, y - 4, x + 3, y + 4] };
  const linked = resolveAt(page, point, refs, {
    getEmbeddedLinks: () => [link],
    getReferencePage(hit) {
      assert.equal(hit, link);
      return { pageIndex: 5, x: 248, y: 192, references: refs };
    },
  });
  assert.equal(linked.precise, true);
  assert.deepEqual(Array.from(linked.references), [refs[1]]);
});

test("a coauthor or a different year suffix cannot stand in for the cited author", () => {
  const page = pageFromLines(["(Yang et al., 2023b)"]);
  const result = resolveAt(page, page.at(0, "2023b"), [
    { text: "He, M., Yang, S. Unrelated paper. 2023b." },
    { text: "Yang, E. Paper with a different suffix. 2023a." },
  ]);
  assert.equal(result.precise, false);
  assert.equal(result.references.length, 0);
});

test("numeric ranges preserve all works even if the reader supplies only the first", () => {
  const page = pageFromLines(["Some prior work [2–4]."]);
  const refs = [2, 3, 4].map(number => ({ text: '[' + number + '] Smith, M. Paper ' + number + '. 2020.' }));
  const result = resolveAt(page, page.at(0, "2"), [refs[0]], { getAllReferences: () => refs });
  assert.equal(result.precise, false);
  assert.deepEqual(Array.from(result.references), refs);
});
