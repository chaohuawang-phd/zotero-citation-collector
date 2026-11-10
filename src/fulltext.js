// Download the cited work after its bibliographic record has been committed.
// Use Zotero's own file resolvers and storage API. Stage and inspect the bytes
// before making a child attachment: a publisher can return HTML or an EPUB.
const CitationFulltext = (() => {
  const pending = new Map();
  let queue = Promise.resolve();

  function pdfChild(attachment) {
    return attachment && !attachment.deleted && attachment.isFileAttachment()
      && (attachment.isPDFAttachment() || /\.pdf$/i.test(attachment.attachmentPath || ""));
  }

  async function hasPDFHeader(path) {
    const sample = await Zotero.File.getBinaryContentsAsync(path, 1024);
    return /%PDF-\d\.\d/.test(sample) && !/^\s*<(?:!doctype\s+html|html)\b/i.test(sample);
  }

  async function existingPDF(item, restoreSyncedFile = false) {
    await item.loadDataType("childItems");
    const children = await Zotero.Items.getAsync(item.getAttachments());
    const missing = [];
    for (const child of children.filter(pdfChild)) {
      const path = await child.getFilePathAsync();
      if (path && await hasPDFHeader(path)) return child;
      if (!path && child.isStoredFileAttachment()) missing.push(child);
    }
    if (restoreSyncedFile) {
      // A stored attachment may just be waiting for sync-on-demand.
      for (const child of missing) {
        try {
          await Zotero.Sync.Runner.downloadFile(child);
          const path = await child.getFilePathAsync();
          if (path && await hasPDFHeader(path)) return child;
        } catch (error) {
          Zotero.debug("正文引文收藏：未能从同步端取回 PDF " + error);
        }
      }
    }
    return null;
  }

  function directPDFs(item, candidate) {
    const urls = new Set();
    const arxivID = /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i;
    function addArxiv(value) {
      const id = String(value || "").trim().replace(/^(?:arxiv:\s*|10\.48550\/arxiv\.)/i, "");
      if (arxivID.test(id)) urls.add("https://arxiv.org/pdf/" + id);
    }
    addArxiv(candidate.arxiv);
    addArxiv(candidate.doi);
    addArxiv(item.getField("DOI"));
    for (const value of [candidate.url, item.getField("url")]) {
      if (!value) continue;
      let url;
      try { url = new URL(value); } catch { continue; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
      if (["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname)) {
        const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/);
        if (match) addArxiv(match[1]);
      }
      if (["openreview.net", "www.openreview.net"].includes(url.hostname)
          && /^\/(forum|pdf)\/?$/.test(url.pathname)) {
        const id = url.searchParams.get("id");
        if (id && /^[\w-]+$/.test(id)) urls.add("https://openreview.net/pdf?id=" + id);
      }
    }
    return [...urls].map(url => ({ url, accessMethod: "repository" }));
  }

  function checkRequest(url, isActive) {
    if (!isActive()) throw new Error("已停止下载");
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password
        || !u.hostname.includes(".") || u.hostname.endsWith(".local") || u.hostname.endsWith(".localhost")
        || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) {
      throw new Error("全文来源不是公开网站");
    }
  }

  async function download(item, candidate, isActive) {
    if (!isActive() || item.deleted || !item.id) return { status: "cancelled" };
    const found = await existingPDF(item, true);
    if (found) return { status: "existing", attachmentID: found.id };
    const files = Zotero.Attachments;
    const resolvers = [
      ...directPDFs(item, candidate),
      ...files.getFileResolvers(item, ["doi", "url", "oa"], true)
    ];
    if (!resolvers.length) return { status: "unavailable" };
    const tmp = await files.createTemporaryStorageDirectory();
    try {
      const path = PathUtils.join(tmp.path, "download.tmp");
      for (const resolver of resolvers) {
        if (!isActive() || item.deleted) return { status: "cancelled" };
        const result = await files.downloadFirstAvailableFile([resolver], path, {
          enforceFileType: true,
          shouldDisplayCaptcha: false,
          onBeforeRequest: url => checkRequest(url, isActive)
        });
        if (!result?.url || !await hasPDFHeader(path)) continue;
        // A native Zotero sync, connector or another tab may have attached a
        // PDF while this download was underway. Keep the winner.
        const other = await existingPDF(item);
        if (other) return { status: "existing", attachmentID: other.id };
        if (!isActive() || item.deleted) return { status: "cancelled" };
        const base = files.getFileBaseNameFromItem(item, { attachmentTitle: "PDF" }) || item.key;
        const filename = await Zotero.File.rename(path, base + ".pdf");
        const child = await files.createURLAttachmentFromTemporaryStorageDirectory({
          directory: tmp.path, filename, title: "PDF", url: result.url,
          contentType: "application/pdf", parentItemID: item.id, libraryID: item.libraryID
        });
        return { status: "added", attachmentID: child.id };
      }
      return { status: isActive() ? "unavailable" : "cancelled" };
    } finally {
      // On success Zotero has moved this directory into managed storage.
      await IOUtils.remove(tmp.path, { recursive: true, ignoreAbsent: true });
    }
  }

  function ensure(item, candidate = {}, isActive = () => true) {
    if (pending.has(item.id)) return pending.get(item.id);
    const job = queue.then(() => download(item, candidate, isActive)).catch(error => {
      Zotero.debug("正文引文收藏：补充 PDF 失败 " + error);
      return { status: "error", detail: String(error.message || error) };
    });
    pending.set(item.id, job);
    queue = job.finally(() => pending.delete(item.id));
    return job;
  }
  return { ensure };
})();
