const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function source(name) {
  return readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8");
}

const paper = { title: "A sample cited paper", doi: "10.5555/example", year: "2024" };
const originalExtra = "Citation Key: example2024\nProject: restoration";

// Load the real controller and Extra implementation. Only the catalog, library
// persistence and user gestures are replaced; all requests enter via the normal
// reader callback, just as they do when clicking a citation in the PDF.
async function openLibrary({ destination = { key: "ROOT" }, edit = async () => null,
  beforeResolve = async () => {} } = {}) {
  const libraryID = 1;
  const collections = [{ id: 1, key: "ROOT", libraryID, name: "Reading" }];
  const items = [];
  const edits = [];
  const preferences = new Map();
  const fulltext = [];
  let onCollect;
  let created = 0;
  const owner = {
    ZoteroPane: {},
    closed: false,
    document: {
      createElementNS: () => ({ setAttribute() {}, remove() {}, style: {} }),
      documentElement: { appendChild() {} },
    },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
  };
  function makeItem() {
    created++;
    const fields = { title: paper.title, extra: originalExtra };
    const memberships = new Set();
    return {
      id: null, key: "PAPER", libraryID,
      isRegularItem: () => true,
      isTopLevelItem: () => true,
      getField: name => fields[name] || "",
      setField: (name, value) => { fields[name] = value; },
      addToCollection: id => memberships.add(id),
      inCollection: id => memberships.has(id),
      saves: 0,
      async save() {
        this.saves++;
        if (this.id) return;
        this.id = items.length + 10;
        items.push(this);
      },
    };
  }
  const Zotero = {
    initializationPromise: Promise.resolve(),
    getMainWindow: () => owner,
    debug() {}, logError() {},
    Libraries: { userLibraryID: libraryID },
    Collections: {
      getByLibraryAndKey: (id, key) => collections.find(c => c.libraryID === id && c.key === key),
      getByParent: id => collections.filter(c => c.parentID === id),
      getByLibrary: id => collections.filter(c => c.libraryID === id && !c.parentID),
    },
    Collection: class {
      async save() {
        this.id = collections.length + 1;
        this.key = "KEY" + this.id;
        collections.push(this);
      }
    },
    Items: { getAsync: async id => items.find(item => item.id === id) },
    ItemTreeManager: {
      registerColumn: async config => config.dataKey,
      unregisterColumn: async () => {},
    },
    DB: { executeTransaction: callback => callback() },
    Prefs: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) },
  };
  const context = vm.createContext({
    Zotero, setTimeout, clearTimeout,
    installCitationReader(options) { onCollect = options.onCollect; return () => {}; },
    closeCollectorDialogs() {},
    chooseDestination: async (_win, annotate) => ({ annotate, ...destination }),
    editCitationReview: async (_win, request) => {
      const snapshot = { title: request.title, initial: { ...request.initial } };
      edits.push(snapshot);
      return edit(snapshot);
    },
    CitationFulltext: { ensure: async item => { fulltext.push(item.id); return { status: "existing" }; } },
    CitationResolver: {
      resolve: async () => { await beforeResolve(); return { candidates: [paper], confident: true }; },
      findExisting: async () => items[0] || null,
      makeItem,
    },
  });
  const review = vm.runInContext(source("review") + "\nCitationReview;", context);
  await vm.runInContext(source("controller") + "\nstartup();", context);
  return {
    items, collections, fulltext, edits, preferences,
    created: () => created,
    read: item => ({ ...review.read(item) }),
    updateOutsideEditor: (item, patch) => review.apply(item, patch),
    collect: (options = {}) => onCollect({ text: "A sample bibliography reference.", ...options }),
  };
}

test("first collection can save a review requested by the destination picker", async () => {
  const note = "Useful baseline\nCompare with our model";
  const app = await openLibrary({
    destination: { name: "Baselines", parentKey: "ROOT", annotate: true },
    edit: async () => ({ note, rating: 4 }),
  });
  await app.collect();
  assert.equal(app.created(), 1);
  assert.equal(app.edits.length, 1);
  assert.equal(app.edits[0].title, paper.title);
  assert.equal(app.edits[0].initial.note, "");
  assert.equal(app.edits[0].initial.rating, 0);
  const [item] = app.items;
  assert.equal(item.inCollection(app.collections[1].id), true);
  assert.equal(app.read(item).note, note);
  assert.equal(app.read(item).rating, 4);
  assert.ok(item.getField("extra").includes(originalExtra));
});

test("annotating an item already in the same collection updates just the edited field", async () => {
  const patches = [{ note: "Original comment", rating: 5 }, { rating: 0 }];
  const app = await openLibrary({ edit: async () => patches.shift() });
  await app.collect({ annotate: true });
  const [item] = app.items;
  assert.equal(app.read(item).rating, 5);
  item.setField("extra", item.getField("extra") + "\nPersonal ID: sample-15");

  await app.collect({ annotate: true });
  assert.equal(app.created(), 1);
  assert.equal(app.edits.length, 2);
  assert.equal(app.edits[1].initial.note, "Original comment");
  assert.equal(app.edits[1].initial.rating, 5);
  assert.equal(app.read(item).note, "Original comment");
  assert.equal(app.read(item).rating, 0);
  assert.ok(item.getField("extra").includes("Personal ID: sample-15"));

  const extraAfterReview = item.getField("extra");
  await app.collect();
  assert.equal(app.edits.length, 2);
  assert.equal(item.getField("extra"), extraAfterReview);
});

test("canceling review discards the proposed new collection, record and fulltext request", async () => {
  const app = await openLibrary({
    destination: { parentKey: "ROOT", name: "Never created", annotate: true },
    edit: async () => null,
  });
  await app.collect();
  assert.equal(app.edits.length, 1);
  assert.equal(app.items.length, 0);
  assert.equal(app.collections.length, 1);
  assert.equal(app.fulltext.length, 0);
  assert.equal(app.preferences.size, 0);
});

test("concurrent quick-save and annotated-save requests keep the review on one shared item", async () => {
  let entered, release;
  const firstLookup = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const app = await openLibrary({
    beforeResolve: () => { entered(); return barrier; },
    edit: async () => ({ note: "From the annotated request", rating: 3 }),
  });
  const quick = app.collect();
  await firstLookup;
  const annotated = app.collect({ annotate: true });
  release();
  await Promise.all([quick, annotated]);
  assert.equal(app.edits.length, 1);
  assert.equal(app.created(), 1);
  assert.equal(app.items.length, 1);
  const [item] = app.items;
  assert.equal(item.inCollection(1), true);
  assert.equal(app.read(item).note, "From the annotated request");
  assert.equal(app.read(item).rating, 3);
});

test("a stale editor cannot overwrite a newer review of the same field", async () => {
  let editorOpened, submit;
  const ready = new Promise(resolve => { editorOpened = resolve; });
  const pendingPatch = new Promise(resolve => { submit = resolve; });
  const app = await openLibrary({
    edit: async () => { editorOpened(); return pendingPatch; },
  });
  await app.collect();
  const [item] = app.items;
  const editing = app.collect({ annotate: true });
  await ready;
  app.updateOutsideEditor(item, { note: "Saved in another window" });
  await item.save();
  submit({ note: "Based on the stale value" });
  await assert.rejects(editing, /已被更改/);
  assert.equal(app.read(item).note, "Saved in another window");
  assert.equal(app.created(), 1);
});

test("a concurrent edit to a different field is preserved when the editor submits its patch", async () => {
  let editorOpened, submit;
  const ready = new Promise(resolve => { editorOpened = resolve; });
  const pendingPatch = new Promise(resolve => { submit = resolve; });
  const app = await openLibrary({
    edit: async () => { editorOpened(); return pendingPatch; },
  });
  await app.collect();
  const [item] = app.items;
  const editing = app.collect({ annotate: true });
  await ready;
  app.updateOutsideEditor(item, { note: "Saved in another window" });
  await item.save();
  submit({ rating: 4 });
  await editing;
  assert.equal(app.read(item).note, "Saved in another window");
  assert.equal(app.read(item).rating, 4);
  assert.equal(app.created(), 1);
});
