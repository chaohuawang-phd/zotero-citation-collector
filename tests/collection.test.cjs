const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = name => readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8");

function libraryItem() {
  const fields = { title: "Moderate coreset selection for learning", date: "2023" };
  const memberships = new Set();
  return {
    id: 42, libraryID: 1, itemType: "conferencePaper", itemTypeID: 2, saves: 0,
    getCreators: () => [{ creatorTypeID: 1, firstName: "Xiaobo", lastName: "Xia" }],
    getField: key => fields[key] || "",
    isRegularItem: () => true,
    isTopLevelItem: () => true,
    addToCollection: id => memberships.add(id),
    inCollection: id => memberships.has(id),
    async save() { this.saves++; },
  };
}

test("resolving a line-broken title reuses the existing item without making a network request", async () => {
  const item = libraryItem();
  const zotero = {
    Search: class {
      addCondition() {}
      async search() { return [item.id]; }
    },
    Items: {
      getAsync: async id => Array.isArray(id) ? [item] : item,
      loadDataTypes: async () => {},
    },
    CreatorTypes: { getPrimaryIDForType: () => 1 },
  };
  const resolver = vm.runInNewContext(src("review") + "\n" + src("resolve") + "\nCitationResolver;", { Zotero: zotero });
  const citation = "Xia, X. Mod- erate coreset selection for learning. In Conference Proceedings, 2023.";
  const match = await resolver.resolve(citation, 1);
  assert.equal(match.confident, true);
  assert.equal(match.candidates[0].itemID, item.id);
  assert.equal(await resolver.findExisting(match.candidates[0], 1), item);
  const conflicting = { ...match.candidates[0], itemID: undefined, authors: [{ lastName: "Miller" }] };
  await assert.rejects(resolver.findExisting(conflicting, 1));
});

// Call the same onCollect handler used by the reader. The fake picker returns
// the chosen plan; Zotero is represented only by the data this flow needs.
async function startCollector({ destination, selectCandidate = 0, confident = true }) {
  const item = libraryItem();
  const root = { id: 1, key: "ROOT", name: "Reading", libraryID: 1 };
  const collections = [root];
  const counts = { lookups: 0, transactions: 0, preferences: 0 };
  const win = {
    closed: false, ZoteroPane: {},
    document: {
      createElementNS: () => ({ setAttribute() {}, remove() {}, style: {} }),
      documentElement: { appendChild() {} },
    },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
  };
  const zotero = {
    getMainWindow: () => win,
    Libraries: { userLibraryID: 1 },
    Collections: {
      getByLibraryAndKey: (id, key) => collections.find(c => c.key === key && c.libraryID === id),
      getByParent: id => collections.filter(c => c.parentID === id),
    },
    Collection: class {
      async save() {
        this.id = collections.length + 1;
        this.key = "KEY" + this.id;
        collections.push(this);
      }
    },
    DB: { executeTransaction: async callback => { counts.transactions++; return callback(); } },
    Prefs: { get() {}, set() { counts.preferences++; } },
  };
  let onCollect;
  const context = vm.createContext({
    Zotero: zotero, setTimeout, clearTimeout,
    installCitationReader: options => { onCollect = options.onCollect; return () => {}; },
    chooseDestination: async () => destination,
    CitationReview: { registerColumns() {}, unregisterColumns() {} },
    chooseCandidateIndex: async () => selectCandidate,
    CitationFulltext: { ensure: async () => ({ status: "exists" }) },
    CitationResolver: {
      resolve: async () => {
        counts.lookups++;
        return { confident, candidates: [{ title: item.getField("title"), itemID: item.id }] };
      },
      findExisting: async () => item,
    },
  });
  await vm.runInContext(src("controller") + "\nstartup();", context);
  const collect = () => onCollect({ text: "Sample bibliography reference", chooseCollection: true });
  return { collect, counts, collections, item };
}

test("canceling the destination or candidate picker makes no library changes", async () => {
  const closed = await startCollector({ destination: null });
  assert.equal(await closed.collect(), "");
  assert.equal(closed.counts.lookups, 0);
  const declined = await startCollector({
    destination: { parentKey: "ROOT", name: "Unconfirmed" }, confident: false, selectCandidate: -1,
  });
  assert.equal(await declined.collect(), "");
  assert.equal(declined.counts.lookups, 1);
  for (const run of [closed, declined]) {
    assert.equal(run.counts.transactions, 0);
    assert.equal(run.counts.preferences, 0);
    assert.equal(run.collections.length, 1);
    assert.equal(run.item.saves, 0);
  }
});

test("a new child is created on save and reused on the next collection request", async () => {
  const state = await startCollector({ destination: { parentKey: "ROOT", name: "  Methods  " } });
  await state.collect();
  await state.collect();
  assert.equal(state.collections.length, 2);
  const child = state.collections[1];
  assert.equal(child.name, "Methods");
  assert.equal(child.parentID, 1);
  assert.equal(state.item.inCollection(child.id), true);
  assert.equal(state.item.saves, 1);
});
