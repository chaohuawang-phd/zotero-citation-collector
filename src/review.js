// Store review metadata in a namespaced, human-readable block in native Extra.
// Every note line has a literal prefix, including empty lines. A note may thus
// quote a DOI, another marker or an entire review block without becoming one.
const CitationReview = (() => {
  const startMarker = "[正文引文收藏 v1]";
  const endMarker = "[/正文引文收藏]";
  const blockPattern = /^\[正文引文收藏 v1\]\r?\n(?:重要性：(★{1,5})\r?\n)?(?:阅读说明：\r?\n((?:│ [^\r\n]*\r?\n)+))?\[\/正文引文收藏\](\r?\n|$)/gm;
  const cached = new WeakMap();
  const columnKeys = new Map();

  function bibliographicExtra(extra) {
    return String(extra || "").replace(blockPattern, "");
  }

  function read(item) {
    const extra = String(item?.getField?.("extra") || "");
    if (!extra) return { note: "", rating: 0 };
    let entry = cached.get(item);
    if (!entry || entry.extra !== extra) {
      const match = extra.matchAll(blockPattern).next().value;
      const lines = match?.[2]?.split(/\r?\n/).slice(0, -1) || [];
      entry = {
        extra,
        rating: match?.[1]?.length || 0,
        note: lines.map(line => line.slice(2)).join("\n")
      };
      cached.set(item, entry);
    }
    return { note: entry.note, rating: entry.rating };
  }

  function format(note, rating, newline) {
    if (!note && !rating) return "";
    const lines = [startMarker];
    if (rating) lines.push("重要性：" + "★".repeat(rating));
    if (note) {
      lines.push("阅读说明：");
      for (const line of note.split("\n")) lines.push("│ " + line);
    }
    lines.push(endMarker);
    return lines.join(newline);
  }

  // The caller owns the transaction and subsequent item.save().
  function apply(item, patch) {
    if (!patch || !Object.hasOwn(patch, "note") && !Object.hasOwn(patch, "rating")) return false;
    const current = read(item);
    const rating = Object.hasOwn(patch, "rating") ? patch.rating : current.rating;
    const input = Object.hasOwn(patch, "note") ? patch.note : current.note;
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      throw new RangeError("重要性必须是 0 至 5 之间的整数。");
    }
    if (typeof input !== "string") throw new TypeError("阅读说明必须是文本。");
    const note = input.replace(/\r\n?/g, "\n");
    if (current.note === note && current.rating === rating) return false;

    const extra = String(item.getField("extra") || "");
    const newline = extra.match(/\r?\n/)?.[0] || "\n";
    const block = format(note, rating, newline);
    // Write the primary block in place, preserving surrounding whitespace.
    // If a library merge duplicated the block, remove superseded copies.
    let found = false;
    let updated = extra.replace(blockPattern, (_match, _stars, _note, separator) => {
      if (found || !block) return "";
      found = true;
      return block + separator;
    });
    if (block && !found) updated = block + (extra ? newline + extra : "");
    item.setField("extra", updated);
    return true;
  }

  function isBibliographicRow(item) {
    return typeof item?.getField === "function" && item.isRegularItem?.() !== false;
  }

  function renderCell(doc, column, text, tooltip) {
    const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cell.className = "cell " + column.className;
    cell.textContent = text;
    if (tooltip) cell.title = tooltip;
    return cell;
  }

  function registerColumns(pluginID) {
    const manager = Zotero.ItemTreeManager;
    if (!manager?.registerColumn) return;
    const options = [
      {
        dataKey: "importance", label: "重要性", width: "88", sortReverse: true,
        dataProvider(item) {
          // An empty sort value sorts ahead of rated records in descending order.
          return isBibliographicRow(item) ? String(read(item).rating) : "";
        },
        renderCell(_index, data, column, _first, doc) {
          const count = /^[1-5]$/.test(data) ? Number(data) : 0;
          return renderCell(doc, column, "★".repeat(count), count ? count + " / 5" : "");
        }
      },
      {
        dataKey: "readingNote", label: "阅读说明", flex: 2,
        dataProvider(item) { return isBibliographicRow(item) ? read(item).note : ""; },
        renderCell(_index, data, column, _first, doc) {
          return renderCell(doc, column, String(data || "").replace(/\n+/g, " "), data);
        }
      }
    ];
    for (const option of options) {
      if (columnKeys.has(option.dataKey)) continue;
      try {
        const key = manager.registerColumn({
          pluginID, enabledTreeIDs: ["main"],
          // Zotero 10 separately controls tree availability and initial
          // visibility. A user's saved column settings take precedence.
          defaultIn: ["library", "collection"], showInColumnPicker: true,
          zoteroPersist: ["width", "hidden", "sortDirection"],
          ...option
        });
        if (key) columnKeys.set(option.dataKey, key);
      } catch (error) {
        Zotero.logError?.(error);
      }
    }
  }

  function unregisterColumns() {
    for (const key of columnKeys.values()) {
      try { Zotero.ItemTreeManager?.unregisterColumn(key); }
      catch (error) { Zotero.logError?.(error); }
    }
    columnKeys.clear();
  }

  return { read, apply, bibliographicExtra, registerColumns, unregisterColumns };
})();
