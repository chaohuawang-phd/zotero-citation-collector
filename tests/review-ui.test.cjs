const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = name => readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8");
const plain = result => result === null ? null : { ...result };

class Element extends EventTarget {
  constructor(tag, text = "") {
    super();
    this.tag = tag;
    this.textContent = text;
    this.children = [];
    this.value = "";
    this.style = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this[key] = value; }
  focus() {}
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

// Exercise the real form-building and acceptance callbacks; the user-window
// lifecycle (modal opening, closing and unload) is shared by all pickers.
function pickers() {
  let current;
  const win = {};
  const context = vm.createContext({
    Zotero: { Libraries: { userLibraryID: 1 }, Collections: {
      getByLibrary: () => [{ key: "A", name: "Papers" }],
    } },
    collectionPath: item => item.name,
    lastDestination: () => ({ key: "A" }),
  });
  vm.runInContext(source("picker"), context);
  context.openCollectorDialog = (_win, _title, cancelValue, build) =>
    new Promise(resolve => {
      const body = new Element("div"), submit = new Element("button");
      const { initialFocus, accept } = build({
        element: (tag, text) => new Element(tag, text), body, submit, finish: resolve,
      });
      current = { nodes: body.all(), submit, accept, initialFocus, cancel: () => resolve(cancelValue) };
    });
  return { context, win, form: () => current };
}

test("review editor preloads, changes only touched fields, clears and cancels", async () => {
  const { context, win, form } = pickers();
  const title = "<PDF> Method & Results";
  const initial = { note: "第一段\n第二段", rating: 4 };
  function open() { return context.editCitationReview(win, { title, initial }); }
  let result = open();
  const radios = form().nodes.filter(node => node.type === "radio");
  assert.equal(radios.length, 6);
  assert.equal(radios[4].checked, true);
  assert.deepEqual(radios.map(node => node["aria-label"]), ["未评分", "1 星", "2 星", "3 星", "4 星", "5 星"]);
  assert.equal(form().nodes.find(node => node.tag === "p").textContent, title);
  assert.equal(form().initialFocus.value, initial.note);
  form().accept();
  assert.deepEqual(plain(await result), {});
  result = open();
  form().initialFocus.value = "方法值得复现";
  form().accept();
  assert.deepEqual(plain(await result), { note: "方法值得复现" });
  result = open();
  for (const radio of form().nodes.filter(node => node.type === "radio")) radio.checked = radio.value === "5";
  form().accept();
  assert.deepEqual(plain(await result), { rating: 5 });
  result = open();
  for (const radio of form().nodes.filter(node => node.type === "radio")) radio.checked = radio.value === "0";
  form().initialFocus.value = "";
  form().accept();
  assert.deepEqual(plain(await result), { note: "", rating: 0 });
  result = open();
  form().initialFocus.value = "discard";
  form().cancel();
  assert.equal(await result, null);
});

test("destination review option works for an existing and a new classification", async () => {
  const { context, win, form } = pickers();
  let result = context.chooseDestination(win);
  assert.equal(form().nodes.find(node => node.type === "checkbox").checked, false);
  form().accept();
  assert.deepEqual(plain(await result), { key: "A" });

  result = context.chooseDestination(win, true);
  assert.equal(form().nodes.find(node => node.type === "checkbox").checked, true);
  form().nodes.find(node => node.type === "checkbox").checked = false;
  form().accept();
  assert.deepEqual(plain(await result), { key: "A" });

  result = context.chooseDestination(win);
  form().nodes.find(node => node.type === "checkbox").checked = true;
  form().nodes.find(node => node.textContent === "新建分类…").dispatchEvent(new Event("click"));
  form().nodes.find(node => node.type === "text").value = "筛选方法";
  form().accept();
  assert.deepEqual(plain(await result), { parentKey: "A", name: "筛选方法", annotate: true });
});

test("annotation commands target the chosen citation, including grouped and selected references", async () => {
  const handlers = new Map(), calls = [];
  const Zotero = { Reader: {
    registerEventListener: (type, listener) => handlers.set(type, listener),
    unregisterEventListener: type => handlers.delete(type),
  } };
  const context = vm.createContext({ Zotero });
  vm.runInContext(source("reader"), context);
  const cleanup = context.installCitationReader({
    pluginID: "test", getLabel: () => "收藏到 Papers", onCollect: args => { calls.push(args); },
  });
  const reader = { type: "pdf" };
  const refs = ["Yang (2024). Work A", "Xia (2023). Work B"].map(text => ({
    chars: [...text].map(c => ({ c })),
  }));
  let menu;
  handlers.get("createViewContextMenu")({
    reader, params: { overlay: { type: "citation", references: refs } }, append: (...items) => { menu = items; },
  });
  menu.find(item => item.label === "标注并收藏…").groups[0][1].onCommand();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].annotate, true);
  assert.equal(calls[0].text, "Xia (2023). Work B");
  menu.find(item => item.label === "收藏到 Papers").groups[0][0].onCommand();
  assert.equal(calls[1].annotate, false);
  assert.equal(calls[1].chooseCollection, false);

  // The same controls are rendered in reference hover rows and selections.
  const selection = "Xia, X. Moderate coreset: A universal method of data selection. 2023.";
  const doc = { createElement: tag => new Element(tag), documentElement: null };
  let controls;
  handlers.get("renderTextSelectionPopup")({ reader, doc, params: { annotation: { text: selection } },
    append: group => { controls = group; },
  });
  controls.all().find(node => node.textContent === "标注并收藏…").dispatchEvent(new Event("click"));
  assert.equal(calls[2].text, selection);
  assert.equal(calls[2].annotate, true);
  cleanup();
});
