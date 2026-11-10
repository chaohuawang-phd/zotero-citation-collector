// Download the cited work after its bibliographic record has been committed.
// Try each source lazily and use Zotero's storage API only after checking the file.
const CitationFulltext = (() => {
  const pending = new Map();
  let queue = Promise.resolve();

  function pdfChild(attachment) {
    return attachment && !attachment.deleted && attachment.isFileAttachment()
      && (attachment.isPDFAttachment() || /\.pdf$/i.test(attachment.attachmentPath || ""));
  }

  async function hasPDFHeader(path) {
    const sample = await Zotero.File.getBinaryContentsAsync(path, 1024);
    return /^(?:\xEF\xBB\xBF)?\s*%PDF-\d\.\d\b/.test(sample);
  }

  async function existingPDF(item, restoreSyncedFile = false) {
    await item.loadDataType("childItems");
    const children = await Zotero.Items.getAsync(item.getAttachments());
    const missing = [];
    for (const child of children.filter(pdfChild)) {
      try {
        const path = await child.getFilePathAsync();
        if (path && await hasPDFHeader(path)) return child;
        if (!path && child.isStoredFileAttachment()) missing.push(child);
      } catch (error) {
        Zotero.debug("正文引文收藏：已有附件暂不可读 " + error);
      }
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
    const host = u.hostname.replace(/\.$/, "");
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password
        || !host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost")
        || /^[\d.]+$/.test(host) || host.includes(":")) {
      throw new Error("全文来源不是公开网站");
    }
  }

  async function* candidateFiles(item, candidate, active) {
    yield* directPDFs(item, candidate);
    // Zotero's native OA resolver is itself a function returning several URLs.
    // Validate each returned file before deciding whether to skip the others.
    const groups = [
      { list: () => Zotero.Attachments.getFileResolvers(item, ["doi", "url", "oa"], true) },
      { list: () => CitationPDFSources.providers(item, candidate), openCopy: true }
    ];
    for (const group of groups) {
      if (!active()) return;
      let sources;
      try {
        sources = group.list();
      } catch (error) {
        Zotero.debug("正文引文收藏：全文来源暂不可用 " + error);
        continue;
      }
      for (const source of sources) {
        if (!active()) return;
        if (typeof source !== "function") {
          yield source;
          continue;
        }
        try {
          for (const resolver of (await source()).slice(0, 16)) {
            yield group.openCopy ? { ...resolver, openCopy: true } : resolver;
          }
        } catch (error) {
          Zotero.debug("正文引文收藏：全文解析服务未返回候选 " + error);
        }
      }
    }
  }

  async function download(item, candidate, isActive) {
    if (!isActive() || item.deleted || !item.id) return { status: "cancelled" };
    const found = await existingPDF(item, true);
    if (found) return { status: "existing", attachmentID: found.id };
    const files = Zotero.Attachments;
    const active = () => isActive() && !item.deleted;
    const tried = new Set();
    let tmp;
    try {
      for await (const entry of candidateFiles(item, candidate, active)) {
        if (!active()) return { status: "cancelled" };
        const resolver = typeof entry === "string" ? { url: entry } : entry;
        if (!resolver?.url && !resolver?.pageURL) continue;
        const key = JSON.stringify([resolver.url, resolver.pageURL, resolver.referrer]);
        if (tried.has(key)) continue;
        tried.add(key);
        if (!tmp) tmp = await files.createTemporaryStorageDirectory();
        const path = PathUtils.join(tmp.path, "download.tmp");
        let pdfURL;
        try {
          const check = url => checkRequest(url, active);
          const result = resolver.openCopy
            ? await CitationOADownload.download(resolver, path, check)
            : await files.downloadFirstAvailableFile([resolver], path, {
                enforceFileType: true, shouldDisplayCaptcha: false, onBeforeRequest: check
              });
          if (result?.url && await hasPDFHeader(path)) pdfURL = result.url;
        } catch (error) {
          Zotero.debug("正文引文收藏：候选全文下载失败 " + error);
        }
        if (!pdfURL) {
          await IOUtils.remove(path, { ignoreAbsent: true });
          continue;
        }
        // A native Zotero sync, connector or another tab may have attached a
        // PDF while this download was underway. Keep the winner.
        const other = await existingPDF(item);
        if (other) return { status: "existing", attachmentID: other.id };
        if (!isActive() || item.deleted) return { status: "cancelled" };
        const title = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\//i.test(pdfURL) ? "PDF（arXiv 版本）" : "PDF";
        const base = files.getFileBaseNameFromItem(item, { attachmentTitle: title }) || item.key;
        const filename = await Zotero.File.rename(path, base + ".pdf");
        const child = await files.createURLAttachmentFromTemporaryStorageDirectory({
          directory: tmp.path, filename, title, url: pdfURL,
          contentType: "application/pdf", parentItemID: item.id, libraryID: item.libraryID
        });
        return { status: "added", attachmentID: child.id };
      }
      return { status: active() ? "unavailable" : "cancelled" };
    } finally {
      // On success Zotero has moved this directory into managed storage.
      if (tmp) await IOUtils.remove(tmp.path, { recursive: true, ignoreAbsent: true });
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
