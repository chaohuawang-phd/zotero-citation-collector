const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../src/fulltext.js"), "utf8");
const pdf = "%PDF-1.7\n";
const html = "<!doctype html><html><body>Preview of a %PDF-1.7 document</body></html>";

function attachment(id, filepath) {
  return {
    id, filepath, attachmentPath: "storage:test.pdf",
    isFileAttachment: () => true,
    isPDFAttachment: () => true,
    isStoredFileAttachment: () => true,
    async getFilePathAsync() { return this.filepath; },
  };
}

// Emulate Zotero's attachment APIs with in-memory file contents. No publisher
// requests, credentials, Zotero profile or OS temporary directories are used.
function environment({
  children = [], syncedPDF, fields = {}, responses = [], nativeResolvers, remote = {}, providers = [],
  onDownload,
} = {}) {
  const item = {
    id: 15, key: "TESTITEM", libraryID: 1,
    getField(name) { return fields[name] || ""; },
    async loadDataType() {},
    getAttachments: () => children.map(child => child.id),
  };
  const disk = new Map();
  const log = { downloaded: [], restored: [], attached: [], removed: [], lookups: [], directories: 0 };
  const resolvers = responses.map((bytes, index) => ({
    bytes, url: "https://example.org/papers/" + index + ".pdf",
  }));
  const zotero = {
    Items: { getAsync: async ids => children.filter(child => ids.includes(child.id)) },
    File: {
      getBinaryContentsAsync: async (file, length) => (disk.get(file) || "").slice(0, length),
      rename: async (_file, name) => name,
    },
    Sync: { Runner: {
      async downloadFile(child) {
        log.restored.push(child.id);
        if (syncedPDF) {
          child.filepath = "synced.pdf";
          disk.set(child.filepath, syncedPDF);
        }
      },
    } },
    Attachments: {
      getFileResolvers: () => nativeResolvers || resolvers,
      async createTemporaryStorageDirectory() {
        log.directories++;
        return { path: "staging" };
      },
      async downloadFirstAvailableFile([resolver], file, options) {
        const url = resolver.url || resolver.pageURL;
        await options.onBeforeRequest(url);
        log.downloaded.push(url);
        const response = remote[url] ?? resolver.bytes;
        const result = typeof response === "string" ? { bytes: response } : response;
        if (!result) return false;
        if (result.bytes !== undefined) disk.set(file, result.bytes);
        onDownload?.({ children, disk, url });
        if (result.error) throw result.error;
        if (result.unavailable) return false;
        return { url: result.finalURL || url };
      },
      getFileBaseNameFromItem: () => "Article",
      async createURLAttachmentFromTemporaryStorageDirectory(options) {
        log.attached.push(options);
        return { id: 91 };
      },
    },
    debug() {},
  };
  const api = vm.runInNewContext(source + "\nCitationFulltext;", {
    Zotero: zotero, URL, PathUtils: { join: path.posix.join },
    CitationOADownload: {
      download: (resolver, file, check) =>
        zotero.Attachments.downloadFirstAvailableFile([resolver], file, { onBeforeRequest: check }),
    },
    CitationPDFSources: {
      providers(record, candidate) {
        return providers.map((lookup, index) => async () => {
          log.lookups.push(index);
          return lookup(record, candidate);
        });
      },
    },
    IOUtils: {
      exists: async file => disk.has(file),
      remove: async (file, options) => {
        if (options?.recursive) log.removed.push(file);
        disk.delete(file);
      },
    },
  });
  return { ensure: (candidate, isActive) => api.ensure(item, candidate, isActive), item, disk, log };
}

test("an existing local PDF is reused without staging or contacting a resolver", async () => {
  const app = environment({
    children: [attachment(28, "original.pdf")], responses: [pdf], providers: [() => []],
  });
  app.disk.set("original.pdf", pdf);
  const result = await app.ensure();
  assert.equal(result.status, "existing");
  assert.equal(result.attachmentID, 28);
  assert.equal(app.log.directories, 0);
  assert.equal(app.log.downloaded.length, 0);
  assert.equal(app.log.restored.length, 0);
  assert.equal(app.log.attached.length, 0);
  assert.deepEqual(app.log.lookups, []);
});

test("an unreadable attachment does not hide another usable copy", async () => {
  const locked = attachment(27, "locked.pdf");
  locked.getFilePathAsync = async () => { throw new Error("unavailable path"); };
  const app = environment({ children: [locked, attachment(28, "readable.pdf")] });
  app.disk.set("readable.pdf", pdf);
  const result = await app.ensure();
  assert.equal(result.attachmentID, 28);
  assert.equal(app.log.directories, 0);
});

test("a synced attachment with a missing local file is restored before trying publishers", async () => {
  const app = environment({ children: [attachment(44, null)], syncedPDF: pdf, responses: [pdf] });
  const result = await app.ensure();
  assert.equal(result.status, "existing");
  assert.equal(result.attachmentID, 44);
  assert.deepEqual(app.log.restored, [44]);
  assert.equal(app.log.downloaded.length, 0);
  assert.equal(app.log.attached.length, 0);
});

test("HTML containing a PDF marker and non-PDF bytes never become Zotero attachments", async () => {
  const app = environment({ responses: [html, "PK\u0003\u0004epub"] });
  const result = await app.ensure();
  assert.equal(result.status, "unavailable");
  assert.equal(app.log.downloaded.length, 2);
  assert.equal(app.log.attached.length, 0);
  assert.deepEqual(app.log.removed, ["staging"]);
});

test("two simultaneous requests skip an invalid response and create just one PDF child", async () => {
  const app = environment({ responses: [html, pdf] });
  const [a, b] = await Promise.all([app.ensure(), app.ensure()]);
  assert.equal(a.status, "added");
  assert.equal(a.attachmentID, 91);
  assert.equal(b.attachmentID, a.attachmentID);
  assert.equal(app.log.directories, 1);
  assert.equal(app.log.downloaded.length, 2);
  assert.equal(app.log.attached.length, 1);
  const [child] = app.log.attached;
  assert.equal(child.parentItemID, 15);
  assert.equal(child.libraryID, 1);
  assert.equal(child.contentType, "application/pdf");
  assert.equal(child.url, app.log.downloaded[1]);
  assert.deepEqual(app.log.removed, ["staging"]);
});

test("an attachment arriving during download wins the final duplicate check", async () => {
  const app = environment({
    responses: [pdf],
    onDownload({ children, disk }) {
      children.push(attachment(82, "from-sync.pdf"));
      disk.set("from-sync.pdf", pdf);
    },
  });
  const result = await app.ensure();
  assert.equal(result.status, "existing");
  assert.equal(result.attachmentID, 82);
  assert.equal(app.log.attached.length, 0);
  assert.deepEqual(app.log.removed, ["staging"]);
});

const dataDiet = {
  title: "Deep Learning on a Data Diet: Finding Important Examples Early in Training",
  url: "https://openreview.net/forum?id=Uj7pF-D-YvT",
};
const openReviewPDF = "https://openreview.net/pdf?id=Uj7pF-D-YvT";
const arxivPDF = "https://arxiv.org/pdf/2107.07075";
const repositoryPDF = { url: arxivPDF, accessMethod: "repository" };

test("a working direct link or Zotero resolver finishes before any metadata lookup", async () => {
  const direct = environment({
    fields: dataDiet, remote: { [openReviewPDF]: pdf }, responses: [pdf], providers: [() => []],
  });
  assert.equal((await direct.ensure(dataDiet)).status, "added");
  assert.deepEqual(direct.log.downloaded, [openReviewPDF]);
  assert.deepEqual(direct.log.lookups, []);

  const native = environment({ responses: [pdf], providers: [() => []] });
  assert.equal((await native.ensure()).status, "added");
  assert.deepEqual(native.log.lookups, []);
});

test("a blocked OpenReview URL and failed native resolver fall through to verified alternatives", async () => {
  const mirror = "https://university.example/repository/paper.pdf";
  const landingPage = "https://publisher.example/article";
  const app = environment({
    fields: dataDiet,
    responses: [{ error: new Error("HTTP 403") }],
    remote: {
      [openReviewPDF]: html,
      [mirror]: { unavailable: true },
      [landingPage]: { error: new Error("connection reset") },
      [arxivPDF]: pdf,
    },
    providers: [
      () => { throw new Error("HTTP 429"); },
      (item, candidate) => {
        assert.equal(item.getField("title"), dataDiet.title);
        assert.equal(candidate, dataDiet);
        return [
          { url: mirror, accessMethod: "repository" },
          { pageURL: landingPage, accessMethod: "repository" },
          repositoryPDF,
        ];
      },
      () => [],
    ],
  });
  const [first, second] = await Promise.all([app.ensure(dataDiet), app.ensure(dataDiet)]);
  assert.equal(first.status, "added");
  assert.equal(second.attachmentID, first.attachmentID);
  assert.deepEqual(app.log.lookups, [0, 1]);
  assert.deepEqual(app.log.downloaded, [
    openReviewPDF, "https://example.org/papers/0.pdf", mirror, landingPage, arxivPDF,
  ]);
  assert.equal(app.log.attached.length, 1);
  assert.equal(app.log.attached[0].parentItemID, app.item.id);
  assert.equal(app.log.attached[0].libraryID, app.item.libraryID);
  assert.equal(app.log.attached[0].url, arxivPDF);
  assert.deepEqual(app.log.removed, ["staging"]);
});

test("a title-only reference can be enriched even when Zotero offers no resolver", async () => {
  const app = environment({
    fields: { title: dataDiet.title }, providers: [() => [], () => [repositoryPDF]],
    remote: { [arxivPDF]: pdf },
  });
  assert.equal((await app.ensure({ title: dataDiet.title })).status, "added");
  assert.deepEqual(app.log.lookups, [0, 1]);
  assert.equal(app.log.attached[0].url, arxivPDF);
});

test("every URL from Zotero's lazy OA resolver is checked before external lookups", async () => {
  const first = "https://example.org/view";
  let called = 0;
  const app = environment({
    nativeResolvers: [
      async () => {
        called++;
        return [{ url: first, accessMethod: "oa" }, { url: arxivPDF, accessMethod: "oa" }];
      },
    ],
    remote: { [first]: html, [arxivPDF]: pdf }, providers: [() => []],
  });
  assert.equal((await app.ensure()).status, "added");
  assert.equal(called, 1);
  assert.deepEqual(app.log.downloaded, [first, arxivPDF]);
  assert.deepEqual(app.log.lookups, []);
});

test("a failed download cannot lend its temporary PDF bytes to the next candidate", async () => {
  const empty = "https://example.org/empty";
  const app = environment({
    // The native request wrote a PDF prefix before its connection broke.
    responses: [{ bytes: pdf, error: new Error("partial response") }],
    providers: [() => [{ url: empty, accessMethod: "repository" }, repositoryPDF]],
    remote: { [empty]: {}, [arxivPDF]: pdf },
  });
  assert.equal((await app.ensure()).status, "added");
  assert.deepEqual(app.log.downloaded, ["https://example.org/papers/0.pdf", empty, arxivPDF]);
  assert.equal(app.log.attached[0].url, arxivPDF);
});

test("stopping the plugin during a source lookup prevents subsequent requests and writes", async () => {
  let running = true;
  const app = environment({
    providers: [() => { running = false; return [repositoryPDF]; }, () => []],
    remote: { [arxivPDF]: pdf },
  });
  assert.equal((await app.ensure({}, () => running)).status, "cancelled");
  assert.deepEqual(app.log.lookups, [0]);
  assert.deepEqual(app.log.downloaded, []);
  assert.deepEqual(app.log.attached, []);
});

test("an exhausted search can be retried later for the same saved item", async () => {
  let response = [];
  const app = environment({
    providers: [() => response], remote: { [arxivPDF]: pdf },
  });
  assert.equal((await app.ensure()).status, "unavailable");
  response = [repositoryPDF];
  assert.equal((await app.ensure()).status, "added");
  assert.deepEqual(app.log.lookups, [0, 0]);
  assert.equal(app.log.attached.length, 1);
});
