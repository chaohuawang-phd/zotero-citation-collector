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
function environment({ children = [], syncedPDF, responses = [], onDownload } = {}) {
  const item = {
    id: 15, key: "TESTITEM", libraryID: 1,
    getField() { return ""; },
    async loadDataType() {},
    getAttachments: () => children.map(child => child.id),
  };
  const disk = new Map();
  const log = { downloaded: [], restored: [], attached: [], removed: [], directories: 0 };
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
      getFileResolvers: () => resolvers,
      async createTemporaryStorageDirectory() {
        log.directories++;
        return { path: "staging" };
      },
      async downloadFirstAvailableFile([resolver], file, options) {
        options.onBeforeRequest(resolver.url);
        log.downloaded.push(resolver.url);
        disk.set(file, resolver.bytes);
        onDownload?.({ children, disk });
        return { url: resolver.url };
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
    IOUtils: { remove: async directory => { log.removed.push(directory); } },
  });
  return { ensure: () => api.ensure(item), disk, log };
}

test("an existing local PDF is reused without staging or contacting a resolver", async () => {
  const app = environment({ children: [attachment(28, "original.pdf")], responses: [pdf] });
  app.disk.set("original.pdf", pdf);
  const result = await app.ensure();
  assert.equal(result.status, "existing");
  assert.equal(result.attachmentID, 28);
  assert.equal(app.log.directories, 0);
  assert.equal(app.log.downloaded.length, 0);
  assert.equal(app.log.restored.length, 0);
  assert.equal(app.log.attached.length, 0);
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
