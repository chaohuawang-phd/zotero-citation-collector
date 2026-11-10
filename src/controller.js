// Packaged after the reader and resolver in the same Zotero bootstrap scope.
const COLLECTOR_ID = "citation-collector@research-tools.local";
const COLLECTION_PREF = "citationCollector.destinationKey";
let removeCollectorReader = null;
let collectorActive = false;
let collectorWriteQueue = Promise.resolve();
const pendingCollections = new Map();
const pendingReviewsByWindow = new WeakMap();
const pendingFulltexts = new Set();
const collectorNotices = new Map();

function personalCollection(key) {
  if (!key) return null;
  const collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
  return collection && !collection.deleted ? collection : null;
}

function collectionPath(collection) {
  const parts = [];
  const visited = new Set();
  while (collection && !visited.has(collection.id)) {
    visited.add(collection.id);
    parts.unshift(collection.name);
    collection = collection.parentID && Zotero.Collections.get(collection.parentID);
  }
  return parts.join(" / ");
}

function lastDestination() {
  return personalCollection(Zotero.Prefs.get(COLLECTION_PREF));
}

function displayCandidate(candidate) {
  const author = (candidate.authors || []).slice(0, 2).map(person => person.lastName || person.name || person.firstName).filter(Boolean).join(", ");
  const extra = [author, candidate.year, candidate.venue, candidate.doi || (candidate.arxiv && "arXiv " + candidate.arxiv)]
    .filter(Boolean).join(" · ");
  const source = candidate.itemID ? "【库内】" : candidate.source === "PDF" ? "【据 PDF 转录，请核对】" : "";
  return source + candidate.title + (extra ? "  —  " + extra : "");
}

function clearCollectorNotice(win) {
  const notice = collectorNotices.get(win);
  if (!notice) return;
  collectorNotices.delete(win);
  win.clearTimeout(notice.timer);
  win.removeEventListener("unload", notice.remove);
  notice.element.remove();
}

function notifyCollector(title, description, win = Zotero.getMainWindow()) {
  try {
    if (!collectorActive || !win || win.closed) return;
    clearCollectorNotice(win);
    const doc = win.document;
    const element = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    element.setAttribute("role", "status");
    element.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483646;max-width:min(32em,80vw);padding:10px 14px;white-space:pre-line;overflow-wrap:anywhere;color:CanvasText;background:Canvas;border:1px solid GrayText;border-radius:6px;box-shadow:0 2px 10px #0003;font:message-box;pointer-events:none;";
    element.textContent = title + "\n" + description;
    doc.documentElement.appendChild(element);
    const remove = () => clearCollectorNotice(win);
    const notice = { element, remove, timer: win.setTimeout(remove, 5500) };
    collectorNotices.set(win, notice);
    win.addEventListener("unload", remove, { once: true });
  } catch (error) {
    Zotero.debug("正文引文收藏：无法显示状态 " + error);
  }
}

function activeCollectorWindow(anchor) {
  const top = anchor?.ownerDocument?.defaultView?.top;
  return top && !top.closed && top.ZoteroPane ? top : Zotero.getMainWindow();
}

function completeFulltext(item, candidate) {
  if (pendingFulltexts.has(item.id)) return;
  pendingFulltexts.add(item.id);
  const messages = {
    added: "全文 PDF 已添加",
    unavailable: "题录已保留，暂未找到可下载的 PDF",
    error: "题录已保留，PDF 下载未完成，可再次点击收藏重试"
  };
  const report = status => {
    if (collectorActive && messages[status]) notifyCollector(messages[status], item.getField("title"));
  };
  Promise.resolve().then(() => CitationFulltext.ensure(item, candidate, () => collectorActive))
    .then(result => report(result.status))
    .catch(error => {
      Zotero.debug("正文引文收藏：查找全文失败 " + error);
      report("error");
    })
    .finally(() => pendingFulltexts.delete(item.id));
}

function siblingName(name) {
  return name.trim().normalize("NFC").toLowerCase();
}

async function resolveDestinationForSave(plan, libraryID) {
  if (plan.key) {
    const collection = personalCollection(plan.key);
    if (!collection) throw new Error("选定的分类已被移除，请重新选择。");
    return collection;
  }
  const name = (plan.name || "").trim();
  if (!name) throw new Error("请输入分类名称。");
  const parent = plan.parentKey ? personalCollection(plan.parentKey) : null;
  if (plan.parentKey && !parent) throw new Error("所选上级分类已被移除，请重新选择。");
  const siblings = parent ? Zotero.Collections.getByParent(parent.id) : Zotero.Collections.getByLibrary(libraryID);
  const wanted = siblingName(name);
  const matches = siblings.filter(c => !c.deleted && siblingName(c.name) === wanted);
  if (matches.length > 1) throw new Error("该位置存在多个同名分类，请从已有分类中选择。");
  if (matches.length === 1) return matches[0];
  const collection = new Zotero.Collection();
  collection.libraryID = libraryID;
  collection.name = name;
  if (parent) collection.parentID = parent.id;
  await collection.save({ skipSelect: true });
  return collection;
}

async function saveCandidate(candidate, destination, review) {
  // Serialize final lookup + write, including clicks from different reader tabs.
  const write = async () => {
    if (!collectorActive) return null;
    const libraryID = Zotero.Libraries.userLibraryID;
    return Zotero.DB.executeTransaction(async () => {
      const existing = await CitationResolver.findExisting(candidate, libraryID);
      if (!collectorActive) return null;
      const item = existing || CitationResolver.makeItem(candidate, libraryID);
      if (review) {
        const current = CitationReview.read(item);
        for (const field of Object.keys(review.patch)) {
          if (current[field] !== review.initial[field] && current[field] !== review.patch[field]) {
            throw new Error("这篇论文的标注已被更改。请重新打开标注，核对最新内容后再保存。");
          }
        }
      }
      const collection = await resolveDestinationForSave(destination, libraryID);
      const alreadyInCollection = existing && existing.inCollection(collection.id);
      const edited = review && CitationReview.apply(item, review.patch);
      if (!alreadyInCollection) item.addToCollection(collection.id);
      if (!alreadyInCollection || edited) await item.save();
      let status = existing ? "已将库内条目加入分类" : "已收藏";
      if (alreadyInCollection) status = edited ? "已更新阅读标注" : "已在该分类";
      return { item, collection, status };
    });
  };
  const result = collectorWriteQueue.then(write);
  collectorWriteQueue = result.catch(() => {});
  return result;
}

async function collectReference({ text, anchor, chooseCollection, annotate = false }) {
  if (!collectorActive || !text?.trim()) return "";
  const win = activeCollectorWindow(anchor);
  const previous = !chooseCollection && lastDestination();
  const destination = previous ? { key: previous.key, annotate } : await chooseDestination(win, annotate);
  if (!destination || !collectorActive || win.closed) return "";
  // Each reader window owns its editor. A quick save must never consume an
  // annotated request, nor should a second window inherit the first one's form.
  let pending = pendingCollections;
  if (destination.annotate) {
    if (!pendingReviewsByWindow.has(win)) pendingReviewsByWindow.set(win, new Map());
    pending = pendingReviewsByWindow.get(win);
  }
  const lookupKey = JSON.stringify([destination.key || null, destination.parentKey || null,
    destination.key ? null : siblingName(destination.name), text]);
  if (pending.has(lookupKey)) return pending.get(lookupKey);
  const job = (async () => {
    const waiting = setTimeout(() => {
      if (collectorActive) notifyCollector("正在核对引文", text.slice(0, 160), win);
    }, 1400);
    let resolved;
    try {
      resolved = await CitationResolver.resolve(text, Zotero.Libraries.userLibraryID);
    } finally {
      clearTimeout(waiting);
    }
    if (!collectorActive || win.closed) return "";
    if (!resolved.candidates.length) {
      throw new Error("未能可靠识别这条引文。请核对引文预览，或在文末选中完整的一条参考文献再收藏。");
    }
    let index = 0;
    if (!resolved.confident || resolved.candidates.length !== 1) {
      index = await chooseCandidateIndex(win, text.slice(0, 450),
        resolved.candidates.map(displayCandidate));
      if (index < 0) return "";
    }
    const candidate = resolved.candidates[index];
    let review;
    if (destination.annotate) {
      const existing = await CitationResolver.findExisting(candidate, Zotero.Libraries.userLibraryID);
      if (!collectorActive || win.closed) return "";
      const initial = existing ? CitationReview.read(existing) : { note: "", rating: 0 };
      const patch = await editCitationReview(win, { title: candidate.title, initial });
      if (!patch || !collectorActive || win.closed) return "";
      if (Object.keys(patch).length) review = { initial, patch };
    }
    const result = await saveCandidate(candidate, destination, review);
    if (!result) return "";
    Zotero.Prefs.set(COLLECTION_PREF, result.collection.key);
    notifyCollector(result.status + " · " + result.collection.name, result.item.getField("title"), win);
    completeFulltext(result.item, candidate);
    return result.status;
  })();
  pending.set(lookupKey, job);
  try {
    return await job;
  } finally {
    pending.delete(lookupKey);
  }
}

function install() {}
function uninstall() {}

async function startup() {
  collectorActive = true;
  await Zotero.initializationPromise;
  if (!collectorActive) return;
  removeCollectorReader = installCitationReader({
    pluginID: COLLECTOR_ID,
    async onCollect(request) {
      try {
        return await collectReference(request);
      } catch (error) {
        Zotero.logError(error);
        if (collectorActive) notifyCollector("此次收藏未完成", String(error.message || error), activeCollectorWindow(request.anchor));
        throw error;
      }
    },
    getLabel() {
      const collection = lastDestination();
      return collection ? "收藏到「" + collection.name + "」" : "收藏到…";
    }
  });
  CitationReview.registerColumns(COLLECTOR_ID);
}

function shutdown() {
  collectorActive = false;
  CitationReview.unregisterColumns();
  closeCollectorDialogs();
  for (const win of collectorNotices.keys()) clearCollectorNotice(win);
  removeCollectorReader?.();
  removeCollectorReader = null;
}
