const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../src/oa-download.js"), "utf8");
const origin = "https://repository.example.org";
const cdn = "https://files.example.org";
const pdf = "%PDF-1.7\nbody\n%%EOF";

function response(status, body = "", headers = {}) {
  return { status, response: new Blob([body]), getResponseHeader: key => headers[key] || null };
}

function environment(responses, window) {
  const requested = [], written = [];
  const Zotero = {
    getMainWindow: () => window,
    HTTP: { async request(method, url, options) {
      assert.equal(method, "GET");
      assert.equal(options.anon, true);
      assert.equal(options.followRedirects, false);
      assert.equal(options.responseType, "blob");
      assert.equal(options.errorDelayMax, 0);
      assert.equal(options.noRetryOnThrottle, true);
      assert.ok(options.timeout > 0);
      requested.push(url);
      assert.ok(Object.hasOwn(responses, url), "unexpected HTTP request: " + url);
      return responses[url];
    } },
    File: { async putContentsAsync(file, blob) { written.push([file, await blob.text()]); } }
  };
  const api = vm.runInNewContext(source + "\nCitationOADownload", { Zotero, URL });
  const check = url => {
    if (!url.startsWith(origin + "/") && !url.startsWith(cdn + "/")) throw Error("blocked: " + url);
  };
  return { requested, written, run: resolver => api.download(resolver, "download.tmp", check) };
}

test("checks relative and cross-host redirects and stores the genuine PDF with its final URL", async () => {
  const ctx = environment({
    [origin + "/article/1"]: response(302, "", { Location: "../v2/1" }),
    [origin + "/v2/1"]: response(308, "", { Location: cdn + "/main.pdf#page=1" }),
    [cdn + "/main.pdf"]: response(200, pdf, { "Content-Type": "application/octet-stream" })
  });
  const result = await ctx.run({ url: origin + "/article/1" });
  assert.equal(result.url, cdn + "/main.pdf");
  assert.deepEqual(ctx.requested, [origin + "/article/1", origin + "/v2/1", cdn + "/main.pdf"]);
  assert.deepEqual(ctx.written, [["download.tmp", pdf]]);
});

test("rejects a redirect to a private address before making a second request", async () => {
  const url = origin + "/trick";
  const ctx = environment({ [url]: response(301, "", { Location: "http://127.0.0.1/private" }) });
  await assert.rejects(ctx.run({ url }), /blocked/);
  assert.deepEqual(ctx.requested, [url]);
  assert.deepEqual(ctx.written, []);
});

test("checks an unexpected final URL before storing and rejects partial PDFs", async () => {
  const url = origin + "/trick";
  const leaked = Object.assign(response(200, pdf), { responseURL: "https://127.0.0.1/private.pdf" });
  const ctx = environment({ [url]: leaked });
  await assert.rejects(ctx.run({ url }), /blocked/);
  assert.deepEqual(ctx.written, []);
  const partial = environment({ [url]: response(206, pdf) });
  assert.equal(await partial.run({ url }), false);
  assert.deepEqual(partial.written, []);
});

test("skips login HTML with an arbitrary PDF link, and never loops on redirects", async () => {
  const url = origin + "/page";
  const ctx = environment({ [url]: response(200, '<html><a href="other.pdf">Download</a></html>', { "Content-Type": "text/html" }) });
  assert.equal(await ctx.run({ url }), false);
  assert.deepEqual(ctx.requested, [url]);
  assert.deepEqual(ctx.written, []);
  const loop = environment({ [url]: response(307, "", { Location: "/page#loop" }) });
  assert.equal(await loop.run({ url }), false);
  assert.deepEqual(loop.requested, [url]);
});

test("uses a scholarly PDF metatag from an inert landing page and resolves its relative URL", async () => {
  const html = '<meta name="citation_pdf_url" content="../paper.pdf">';
  const window = { document: { createElementNS(ns, element) {
    assert.equal(element, "template");
    assert.equal(ns, "http://www.w3.org/1999/xhtml");
    return {
      set innerHTML(value) { assert.equal(value, html); },
      content: { querySelectorAll(selector) {
        assert.match(selector, /^meta\[name="citation_pdf_url"/);
        return [{ getAttribute: name => name === "content" ? "../paper.pdf" : null }];
      } }
    };
  } } };
  const ctx = environment({
    [origin + "/landing/paper"]: response(200, html, { "Content-Type": "text/html" }),
    [origin + "/paper.pdf"]: response(200, pdf)
  }, window);
  assert.equal((await ctx.run({ pageURL: origin + "/landing/paper" })).url, origin + "/paper.pdf");
  assert.deepEqual(ctx.written, [["download.tmp", pdf]]);
});
