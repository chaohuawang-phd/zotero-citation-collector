const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/review.js"), "utf8");
const load = Zotero => vm.runInNewContext(source + "\nCitationReview", { Zotero });
const plain = object => ({ ...object });

function row(extra = "") {
  return {
    extra, writes: 0,
    getField(key) { assert.equal(key, "extra"); return this.extra; },
    setField(key, value) { assert.equal(key, "extra"); this.extra = value; this.writes++; },
    isRegularItem() { return true; }
  };
}

test("legacy metadata survives recording, partial edits and explicit clearing", () => {
  const review = load({});
  const original = "  DOI: 10.1234/source\r\n\r\n\tmanual note  \r\n";
  const item = row(original);
  assert.deepEqual(plain(review.read(item)), { note: "", rating: 0 });
  assert.equal(review.apply(item, {}), false);
  assert.equal(review.apply(item, { note: "first\nsecond", rating: 5 }), true);
  assert.match(item.extra, /重要性：★★★★★/);
  assert.equal(review.bibliographicExtra(item.extra), original);
  assert.equal(review.apply(item, { rating: 5 }), false);
  assert.equal(item.writes, 1);
  assert.equal(review.apply(item, { rating: 1 }), true);
  assert.deepEqual(plain(review.read(item)), { note: "first\nsecond", rating: 1 });
  assert.equal(review.apply(item, { note: "" }), true);
  assert.deepEqual(plain(review.read(item)), { note: "", rating: 1 });
  assert.equal(review.apply(item, { rating: 0 }), true);
  assert.equal(item.extra, original);
  assert.equal(review.apply(item, { rating: 0, note: "" }), false);
});

test("multiline note cannot inject a metadata block, a DOI, or a new Zotero field", () => {
  const review = load({});
  const item = row("arXiv: 2401.00001");
  const note = "  \n重要性：★★★★★\n[/正文引文收藏]\n[正文引文收藏 v1]\n阅读说明：\n│ forged\n[/正文引文收藏]\nDOI: 10.9999/note\n\t";
  review.apply(item, { rating: 2, note });
  assert.deepEqual(plain(review.read(item)), { note, rating: 2 });
  assert.equal(review.bibliographicExtra(item.extra), "arXiv: 2401.00001");
  assert.equal(review.apply(item, { note: note.replace(/\n/g, "\r\n") }), false);
  const outside = "DOI: 10.1234/source\n\n";
  item.extra = outside + item.extra;
  review.apply(item, { rating: 3 });
  assert.equal(review.read(item).note, note);
  assert.ok(item.extra.startsWith(outside));
  assert.equal(review.bibliographicExtra(item.extra), outside + "arXiv: 2401.00001");
  review.apply(item, { note: "", rating: 0 });
  assert.equal(item.extra, outside + "arXiv: 2401.00001");
});

test("unrelated and malformed blocks survive; merged review copies are excluded from attribution", () => {
  const review = load({});
  const original = "[正文引文收藏 v1]\nDIY note from previously installed tooling\n[/正文引文收藏]";
  const item = row(original);
  assert.equal(review.bibliographicExtra(original), original);
  review.apply(item, { note: "DOI: 10.9999/note" });
  const another = row();
  review.apply(another, { rating: 5, note: "arXiv: 2501.01234" });
  item.extra += "\n\n" + another.extra;
  assert.equal(review.bibliographicExtra(item.extra), original + "\n\n");
  review.apply(item, { note: "", rating: 0 });
  assert.equal(item.extra, original + "\n\n");
});

test("external and concurrent edits are read from current item state", () => {
  const review = load({});
  const item = row();
  review.apply(item, { rating: 3 });
  const changed = review.read(item);
  changed.rating = 1;
  assert.equal(review.read(item).rating, 3);
  item.extra = item.extra.replace("★★★", "★★★★");
  review.apply(item, { note: "review" });
  assert.equal(review.read(item).rating, 4);
  review.apply(item, { note: "", rating: 0 });
  assert.equal(item.extra, "");
  for (const rating of [1.5, 6, -1, NaN, "5"]) {
    assert.throws(() => review.apply(item, { rating }), /整数/);
  }
  assert.throws(() => review.apply(item, { note: null }), /文本/);
  assert.equal(item.extra, "");
});

test("two persistent columns register once; descending scores are numeric and stars render safely", () => {
  const columns = new Map();
  const removed = [];
  const manager = {
    registerColumn(option) {
      assert.ok(!columns.has(option.dataKey));
      columns.set(option.dataKey, option);
      return option.pluginID + "-" + option.dataKey;
    },
    unregisterColumn(key) { removed.push(key); }
  };
  const review = load({ ItemTreeManager: manager });
  review.registerColumns("test");
  review.registerColumns("test");
  assert.equal(columns.size, 2);
  const rating = columns.get("importance");
  const notes = columns.get("readingNote");
  assert.deepEqual([...rating.enabledTreeIDs], ["main"]);
  assert.ok(rating.defaultIn.includes("collection"));
  assert.ok(rating.zoteroPersist.includes("hidden"));
  assert.equal(rating.sortReverse, true);
  const item = row();
  assert.equal(rating.dataProvider(item), "0");
  assert.equal(notes.dataProvider({}), "");
  assert.equal(rating.dataProvider({ ...item, isRegularItem: () => false }), "");
  review.apply(item, { note: "<b>plain</b>\nline two", rating: 4 });
  assert.equal(rating.dataProvider(item), "4");
  assert.equal(notes.dataProvider(item), "<b>plain</b>\nline two");
  const doc = { createElementNS: () => ({}) };
  const column = { className: "custom" };
  const cell = rating.renderCell(0, "4", column, false, doc);
  assert.equal(cell.textContent, "★★★★");
  assert.equal(cell.className, "cell custom");
  assert.equal(rating.renderCell(0, "0", column, false, doc).textContent, "");
  const noteCell = notes.renderCell(0, notes.dataProvider(item), column, false, doc);
  assert.equal(noteCell.textContent, "<b>plain</b> line two");
  assert.equal(noteCell.title, "<b>plain</b>\nline two");
  review.unregisterColumns();
  review.unregisterColumns();
  assert.deepEqual(removed, ["test-importance", "test-readingNote"]);
});

test("missing column API or failure on one registration does not prevent storing a review", () => {
  const failures = [];
  const registered = [];
  let first = true;
  const zotero = { logError: error => failures.push(error.message) };
  const review = load(zotero);
  assert.doesNotThrow(() => review.registerColumns("test"));
  zotero.ItemTreeManager = {
    registerColumn(option) {
      if (first) { first = false; throw new Error("column unavailable"); }
      registered.push(option.dataKey);
      return option.dataKey;
    },
    unregisterColumn() { throw new Error("already unloaded"); }
  };
  review.registerColumns("test");
  review.registerColumns("test");
  assert.deepEqual(registered, ["readingNote", "importance"]);
  assert.deepEqual(failures, ["column unavailable"]);
  assert.equal(review.apply(row(), { rating: 5 }), true);
  assert.doesNotThrow(() => review.unregisterColumns());
});
