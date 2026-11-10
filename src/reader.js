// The Zotero 10.0.x reader has public toolbar and selection extension points.
// CitationPopup and ReferencePopup expose one .reference-row per cited work.
function installCitationReader({ onCollect, getLabel, pluginID }) {
  const rowSelector = ".citation-popup .reference-row, .reference-popup .reference-row";
  const marker = "data-inline-citation-collector";
  const documents = new Map();
  let active = true;

  function makeActions(doc, reader, getText) {
    const group = doc.createElement("span");
    group.setAttribute(marker, "actions");
    group.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:3px 0;pointer-events:auto;";
    const primary = doc.createElement("button");
    const annotate = doc.createElement("button");
    annotate.textContent = "标注并收藏…";
    annotate.title = "填写这篇论文的阅读说明或重要性评分";
    const choose = doc.createElement("button");
    choose.textContent = "另选分类…";
    choose.title = "为这篇文献选择收藏分类";
    const status = doc.createElement("span");
    status.setAttribute("role", "status");
    status.style.cssText = "font-size:inherit;overflow-wrap:anywhere;";
    const updateLabel = () => {
      const label = getLabel(reader) || "收藏到…";
      if (primary.textContent !== label) primary.textContent = label;
      primary.title = label + "（按住 Option/Alt 可另选分类）";
    };
    updateLabel();
    group.addEventListener("pointerenter", updateLabel);
    group.addEventListener("focusin", updateLabel);
    for (const button of [primary, annotate, choose]) {
      button.type = "button";
      button.style.cssText = "font:inherit;color:inherit;border:1px solid currentColor;border-radius:4px;background:transparent;padding:2px 6px;cursor:pointer;";
      // Keep the native row's navigation and other plugins' click handlers
      // away from these controls only. All native reference links stay intact.
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        button.addEventListener(type, event => event.stopPropagation());
      }
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (!active || primary.disabled) return;
        const text = getText().trim();
        if (!text) return;
        primary.disabled = annotate.disabled = choose.disabled = true;
        status.textContent = "正在核对…";
        try {
          const result = await onCollect({
            text, reader, anchor: button, chooseCollection: button === choose || event.altKey,
            annotate: button === annotate,
          });
          if (active && group.isConnected) status.textContent = result || "";
        } catch (error) {
          if (active && group.isConnected) status.textContent = error.message || String(error);
        } finally {
          if (active && group.isConnected) {
            primary.disabled = annotate.disabled = choose.disabled = false;
            updateLabel();
          }
        }
      });
    }
    group.append(primary, annotate, choose, status);
    return group;
  }

  // In Zotero 10 PDFView this is the shared pointer hit test for the
  // in-text popup, right-click context menu, and citation navigation.
  function installPrecision(view, outerWindow) {
    const original = view._getSelectableOverlay;
    const previous = Object.getOwnPropertyDescriptor(view, "_getSelectableOverlay");
    const rawByPage = new Map(), pending = new Set(), retryAfter = new Map();
    const versions = new WeakMap(), refLists = new WeakMap();
    let enabled = true, reported = false, lastHit = null, timer = null;

    function nativeValue(value) {
      return typeof Components === "undefined" ? value : Components.utils.cloneInto(value, outerWindow);
    }
    function pageReferences(pageIndex) {
      const overlays = view._processedPageOverlays?.[pageIndex] || view._pdfPages?.[pageIndex]?.overlays;
      if (!overlays) return [];
      if (refLists.has(overlays)) return refLists.get(overlays);
      const refs = [];
      for (const overlay of overlays) {
        if (overlay.type === "reference" && overlay.references) refs.push(...overlay.references);
      }
      refLists.set(overlays, refs);
      return refs;
    }
    function referencesAt(link) {
      const dest = link.destinationPosition, rect = dest?.rects?.[0];
      if (!rect || !Number.isInteger(dest.pageIndex)) return null;
      return {
        pageIndex: dest.pageIndex, x: rect[0], y: rect[1], references: pageReferences(dest.pageIndex),
        viewBox: view._pdfPages?.[dest.pageIndex]?.viewBox ||
          view._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.[dest.pageIndex]?.pdfPage?.view,
      };
    }
    function getAllReferences() {
      return Object.keys(view._processedPageOverlays || {}).flatMap(pageReferences);
    }
    function refreshVisible(last) {
      if (!enabled || lastHit !== last || !view._overlayPopup || view._selectedOverlay !== last.shown) return;
      const updated = refine(last.position, last.original);
      if (updated === last.shown || updated?.type !== "citation") return;
      view._selectedOverlay = updated;
      lastHit = { ...last, shown: updated };
      view._onSetOverlayPopup(nativeValue({ ...updated,
        rect: view.getClientRect(updated.position.rects[0], updated.position.pageIndex),
      }));
    }
    // Zotero builds the bibliography asynchronously, separately from raw PDF
    // links. Refresh a stationary cold-start preview after both are ready;
    // never open a popup if the user has since moved away or dismissed it.
    function refreshAfterIndexing() {
      if (timer !== null) return;
      const started = Date.now();
      function check() {
        timer = null;
        const last = lastHit;
        if (!enabled || !last?.shown || Date.now() - started > 30000) return;
        const open = view._overlayPopup && view._selectedOverlay === last.shown;
        if (open && rawByPage.has(last.position.pageIndex) &&
            Object.keys(view._processedPageOverlays || {}).length) {
          refreshVisible(last);
          return;
        }
        // Wait for the native hover delay; after this the card must be open.
        if (!open && Date.now() - started > 1800) return;
        timer = outerWindow.setTimeout(check, 300);
      }
      timer = outerWindow.setTimeout(check, 300);
    }
    function loadLinks(pageIndex) {
      if (rawByPage.has(pageIndex) || pending.has(pageIndex) || (retryAfter.get(pageIndex) || 0) > Date.now()) return;
      const pdf = view._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (!pdf?.getPageData) return;
      pending.add(pageIndex);
      Promise.resolve(pdf.getPageData(nativeValue({ pageIndex }))).then(page => {
        if (!enabled) return;
        rawByPage.set(pageIndex, Array.from(page?.overlays || []).filter(o => o.type === "internal-link"));
        const last = lastHit;
        if (!last || last.position.pageIndex !== pageIndex || !last.shown) return;
        refreshVisible(last);
        refreshAfterIndexing();
      }).catch(error => {
        retryAfter.set(pageIndex, Date.now() + 10000);
        if (enabled) Zotero.debug("正文引文收藏：无法读取 PDF 定位链接 " + error);
      }).finally(() => pending.delete(pageIndex));
    }
    function contains(rect, point) {
      return point[0] >= Math.min(rect[0], rect[2]) && point[0] <= Math.max(rect[0], rect[2]) &&
        point[1] >= Math.min(rect[1], rect[3]) && point[1] <= Math.max(rect[1], rect[3]);
    }
    function refKey(ref) {
      return [ref.position?.pageIndex, ref.position?.rects?.[0]?.join(","), ref.chars?.[0]?.offset].join(":");
    }
    function refine(position, originalHit) {
      const rect = position?.rects?.[0];
      if (!rect || (originalHit && !["internal-link", "citation"].includes(originalHit.type))) return originalHit;
      const pageIndex = position.pageIndex;
      const pageData = view._pdfPages?.[pageIndex];
      if (!pageData) return originalHit;
      loadLinks(pageIndex);
      const point = [rect[0], rect[1]], links = rawByPage.get(pageIndex) || [];
      const overlay = originalHit || links.find(l => l.position?.rects?.some(r => contains(r, point)));
      if (!overlay) return originalHit;
      const result = refineCitedReferences({ pageData, overlay, point,
        getEmbeddedLinks: () => links, getReferencePage: referencesAt, getAllReferences,
      });
      const refs = result?.references;
      if (!refs?.length) {
        // The printed author/year was recognized but conflicts with native
        // candidates. Preserve a real PDF navigation link, never present an
        // unrelated cited paper as a collection target.
        if (result?.hint) {
          return overlay.type === "internal-link" ? overlay :
            links.find(link => link.position?.rects?.some(r => contains(r, point))) || null;
        }
        return originalHit;
      }
      if (!result.precise && overlay.type === "internal-link" && refs.length < 2) return originalHit;
      const native = overlay.references || [], key = refs.map(refKey).join("|");
      if (originalHit?.type === "citation" && native.length === refs.length && native.map(refKey).join("|") === key) {
        return originalHit;
      }
      let byResult = versions.get(overlay);
      if (!byResult) versions.set(overlay, byResult = new Map());
      if (!byResult.has(key)) byResult.set(key, nativeValue({ ...overlay, type: "citation", references: refs }));
      return byResult.get(key);
    }
    function hitTest(rawPosition) {
      const position = rawPosition && typeof Components !== "undefined" ? Components.utils.waiveXrays(rawPosition) : rawPosition;
      const origin = original.call(view, position);
      if (!enabled) return origin;
      try {
        const shown = refine(position, origin);
        lastHit = position ? { position, original: origin, shown } : null;
        if (lastHit?.shown && !Object.keys(view._processedPageOverlays || {}).length) refreshAfterIndexing();
        return shown;
      } catch (error) {
        if (!reported) Zotero.debug("正文引文收藏：保留阅读器原始引文 " + error);
        reported = true;
        return origin;
      }
    }
    function primeVisible() {
      if (enabled) Object.keys(view._pdfPages || {}).forEach(k => loadLinks(Number(k)));
    }
    primeVisible();
    if (view.initializedPromise) Promise.resolve(view.initializedPromise).then(primeVisible).catch(() => {});
    const replace = typeof Components === "undefined" ? hitTest : Components.utils.exportFunction(hitTest, outerWindow);
    Object.defineProperty(view, "_getSelectableOverlay", { configurable: true, writable: true, value: replace });
    const installed = view._getSelectableOverlay;
    return () => {
      enabled = false;
      if (timer !== null) outerWindow.clearTimeout(timer);
      if (view._getSelectableOverlay === installed) {
        if (previous) Object.defineProperty(view, "_getSelectableOverlay", previous);
        else delete view._getSelectableOverlay;
      }
      if (lastHit && lastHit.shown !== lastHit.original && view._selectedOverlay === lastHit.shown) {
        view._selectedOverlay = null;
        view._onSetOverlayPopup(null);
      }
      rawByPage.clear();
      lastHit = null;
    };
  }

  function watchDocument(reader, doc) {
    if (!active || !doc?.documentElement || documents.has(doc)) return;
    if (reader.type && reader.type !== "pdf") return;
    const win = doc.defaultView;
    const viewHooks = new Map();
    function syncViews() {
      if (!active || !doc.defaultView) return;
      const inner = reader._internalReader;
      const current = [inner?._primaryView, inner?._secondaryView].filter(Boolean);
      for (const [view, release] of viewHooks) {
        if (!current.includes(view)) { release(); viewHooks.delete(view); }
      }
      for (const view of current) {
        if (viewHooks.has(view) || !view._iframeWindow || typeof view._getSelectableOverlay !== "function") continue;
        try { viewHooks.set(view, installPrecision(view, win)); }
        catch (error) { Zotero.debug("正文引文收藏：启用精确定位失败 " + error); }
      }
    }
    syncViews();
    // createReader may render its toolbar before _internalReader is assigned.
    Promise.resolve(reader._initPromise).then(() => {
      if (documents.has(doc)) syncViews();
    }).catch(error => Zotero.debug("正文引文收藏：" + error));
    const rows = new WeakSet();
    function enrich(row) {
      // The first child is Zotero's FormattedText, not the whole row: other
      // extensions may append an abstract or translated text next to it.
      if (rows.has(row) && row.querySelector(":scope > [" + marker + "]")) return;
      const getText = () => row.querySelector(":scope > div")?.textContent || "";
      if (!getText().trim()) return;
      rows.add(row);
      row.append(makeActions(doc, reader, getText));
    }
    function scan(node) {
      if (node.nodeType !== 1 || node.closest("[" + marker + "]")) return;
      const row = node.closest(rowSelector);
      if (row) enrich(row);
      else node.querySelectorAll(rowSelector).forEach(enrich);
    }
    const observer = new win.MutationObserver(mutations => {
      syncViews();
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) scan(node);
      }
    });
    // A PDF's text layer and page rendering are in nested iframes. This
    // observes only the outer reader UI, including both panes in split view.
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    function stop() {
      for (const release of viewHooks.values()) release();
      viewHooks.clear();
      observer.disconnect();
      win.removeEventListener("pagehide", stop);
      doc.querySelectorAll("[" + marker + "]").forEach(node => node.remove());
      documents.delete(doc);
    }
    documents.set(doc, stop);
    win.addEventListener("pagehide", stop, { once: true });
    doc.querySelectorAll(rowSelector).forEach(enrich);
  }

  const onViewMenu = ({ reader, params, append }) => {
    if (!active || (reader.type && reader.type !== "pdf")) return;
    const overlay = params?.overlay;
    if (!overlay || !["citation", "reference"].includes(overlay.type)) return;
    // PDFView supplies the reference under the actual pointer even when its
    // hover card never opened. FormattedText uses the same glyph spacing.
    const texts = [];
    for (const reference of overlay.references || []) {
      if (!Array.isArray(reference.chars)) continue;
      const text = reference.chars.filter(char => !char.ignorable)
        .map(char => char.c + (char.spaceAfter || char.lineBreakAfter ? " " : ""))
        .join("").trim();
      if (text && !texts.includes(text)) texts.push(text);
    }
    if (!texts.length) return;
    const menuItem = (label, chooseCollection, annotate = false) => {
      const command = text => () => {
        if (!active) return;
        const anchor = reader._iframeWindow?.document?.documentElement;
        Promise.resolve(onCollect({ text, reader, anchor, chooseCollection, annotate }))
          .catch(error => Zotero.logError(error));
      };
      if (texts.length === 1) return { label, onCommand: command(texts[0]) };
      return {
        label,
        groups: [texts.map((text, index) => ({
          label: (index + 1) + ". " + (text.length > 140
            ? text.slice(0, 100) + "… " + text.slice(-36) : text),
          onCommand: command(text),
        }))],
      };
    };
    append(
      menuItem(getLabel(reader) || "收藏到…", false),
      menuItem("标注并收藏…", false, true),
      menuItem("另选分类并收藏…", true)
    );
  };

  // Reader._dispatchEvent passes event.doc out of wrappedJSObject. Running a
  // MutationObserver on that waived document hides our options dictionary
  // from Gecko. Always work with the same privileged/Xray DOM as startup.
  function startReader(reader, eventDoc) {
    const canonicalDocument = () => {
      const doc = reader._iframeWindow?.document || eventDoc;
      if (!doc || typeof Components === "undefined") return doc;
      return Components.utils.unwaiveXrays(doc);
    };
    const attach = () => {
      if (!active) return;
      const doc = canonicalDocument();
      watchDocument(reader, doc);
      return doc;
    };
    const doc = attach();
    if (!doc && reader._initPromise) {
      Promise.resolve(reader._initPromise).then(attach).catch(error => Zotero.logError(error));
    }
    return doc;
  }
  const onToolbar = ({ reader, doc }) => startReader(reader, doc);
  const onSelection = ({ reader, doc: eventDoc, params, append }) => {
    if (!active || (reader.type && reader.type !== "pdf")) return;
    const text = params?.annotation?.text?.trim() || "";
    // Only offer a bibliography fallback for a plausible complete reference
    // or identifier. A short, detached author/year cannot identify a paper.
    const hasIdentifier = /\b(?:10\.\d{4,9}\/\S+|arxiv\s*:\s*(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7}))/i.test(text);
    const looksLikeReference = text.length >= 45 && /\b(?:18|19|20)\d{2}[a-z]?\b/i.test(text);
    if (text.length > 2500 || !(hasIdentifier || looksLikeReference)) return;
    const doc = startReader(reader, eventDoc);
    if (doc) append(makeActions(doc, reader, () => text));
  };
  Zotero.Reader.registerEventListener("createViewContextMenu", onViewMenu, pluginID);
  Zotero.Reader.registerEventListener("renderToolbar", onToolbar, pluginID);
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", onSelection, pluginID);
  // renderToolbar may already have fired before an in-session installation.
  for (const reader of Zotero.Reader._readers || []) {
    try { startReader(reader); }
    catch (error) { Zotero.debug("正文引文收藏: " + error); }
  }
  return () => {
    active = false;
    Zotero.Reader.unregisterEventListener("createViewContextMenu", onViewMenu);
    Zotero.Reader.unregisterEventListener("renderToolbar", onToolbar);
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onSelection);
    for (const stop of [...documents.values()]) stop();
  };
}
