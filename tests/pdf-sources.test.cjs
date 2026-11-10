const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = ["review", "pdf-sources"].map(name =>
  readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8")).join("\n");
const articles = [
  { title: "Deep Learning on a Data Diet: Finding Important Examples Early in Training",
    author: "Mansheej Paul", year: 2021, catalogueYear: 2021, id: "2107.07075", openAlex: "W3177900337" },
  { title: "Coverage-centric Coreset Selection for High Pruning Rates",
    author: "Haizhong Zheng", year: 2023, catalogueYear: 2022, id: "2210.15809", openAlex: "W4307783342" },
  { title: "What Neural Networks Memorize and Why: Discovering the Long Tail via Influence Estimation",
    author: "Vitaly Feldman", year: 2020, catalogueYear: 2020, id: "2008.03703", openAlex: "W3100352836" },
];

function itemFor(paper, doi) {
  const [firstName, lastName] = paper.author.split(" ");
  const fields = { title: paper.title, date: String(paper.year), DOI: doi };
  return { getField: name => fields[name] || "", getCreators: () => [{ firstName, lastName, creatorTypeID: 1 }] };
}

function workFor(paper) {
  const edition = { is_oa: true, pdf_url: "https://arxiv.org/pdf/" + paper.id, version: "submittedVersion" };
  return { id: paper.openAlex, title: paper.title, publication_year: paper.catalogueYear,
    doi: "https://doi.org/10.48550/arXiv." + paper.id,
    authorships: [{ author: { display_name: paper.author } }], best_oa_location: edition,
    locations: [edition, { ...edition, pdf_url: null, landing_page_url: "http://arxiv.org/abs/" + paper.id }] };
}

function environment(handler) {
  const calls = [];
  const Zotero = { CreatorTypes: { getPrimaryIDForType: () => 1 }, debug() {},
    HTTP: { async request(method, link, options) {
      const u = new URL(link);
      calls.push({ method, u, options });
      return { response: await handler(u, options) };
    } } };
  const api = vm.runInNewContext(source + "\nCitationPDFSources", { Zotero, URL });
  async function all(item, candidate) {
    const out = [];
    for (const provider of api.providers(item, candidate)) out.push(...await provider());
    return JSON.parse(JSON.stringify(out));
  }
  return { api, all, calls };
}

test("OpenReview records without DOIs find their public arXiv PDFs using metadata from the three example papers", async () => {
  for (const paper of articles) {
    const ctx = environment(u => {
      assert.equal(u.hostname, "api.openalex.org");
      assert.equal(u.searchParams.get("filter"), "title.search:" + paper.title);
      return { results: [workFor(paper)] };
    });
    const providers = ctx.api.providers(itemFor(paper));
    assert.equal(ctx.calls.length, 0);
    const results = await providers[0]();
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://arxiv.org/pdf/" + paper.id);
    assert.equal(results[0].accessMethod, "repository");
    assert.equal(ctx.calls[0].options.anon, true);
    assert.equal(ctx.calls[0].options.errorDelayMax, 0);
    assert.ok(ctx.calls[0].options.timeout > 0);
  }
});

test("private citation reading notes never supply DOI or arXiv identifiers to catalogues", () => {
  const ctx = environment(() => { throw new Error("unexpected request"); });
  const privateExtra = "[正文引文收藏 v1]\n阅读说明：\n│ DOI: 10.1234/private\n│ arXiv: 2012.01234\n[/正文引文收藏]";
  const item = { getField: field => field === "extra" ? privateExtra : "" };
  assert.equal(ctx.api.providers(item).length, 0);
  assert.equal(ctx.calls.length, 0);
});

test("archiveID and bibliographic Extra can supply an arXiv PDF without any title, DOI or catalogue request", async () => {
  for (const fields of [{ archiveID: "2210.15809v2" }, { extra: "arXiv: 2210.15809v2" }]) {
    const ctx = environment(() => { throw new Error("unexpected request"); });
    const found = await ctx.all({ getField: key => fields[key] || "" });
    assert.deepEqual(found, [{ url: "https://arxiv.org/pdf/2210.15809v2", accessMethod: "repository" }]);
    assert.equal(ctx.calls.length, 0);
  }
});

test("OpenAlex orders public copies by version and deduplicates direct URLs and arXiv landing variants", async () => {
  const article = articles[1];
  const work = workFor(article);
  const published = { is_oa: true, version: "publishedVersion", pdf_url: "https://conf.example/paper.pdf",
    landing_page_url: "https://conf.example/paper" };
  work.locations.push(published, { ...published, is_oa: false, pdf_url: "https://blocked.example/pay" },
    { ...published, pdf_url: "http://127.0.0.1/internal", landing_page_url: "file:///bad" },
    { ...published, pdf_url: "https://myname:password@example.com/a" });
  const { all } = environment(u => u.hostname === "api.openalex.org" ? { results: [work] } : null);
  const results = await all(itemFor(article));
  assert.deepEqual(results.map(r => r.url || r.pageURL), [
    "https://conf.example/paper.pdf", "https://arxiv.org/pdf/" + article.id, "https://conf.example/paper"
  ]);
  assert.equal(results[2].url, undefined);
});

test("article identity rejects a similar title, a different author, distant years and ambiguous works", async () => {
  const paper = articles[0];
  const work = workFor(paper);
  const testRows = [
    [{ ...work, title: paper.title + " (correction)" }],
    [{ ...work, authorships: [{ author: { display_name: "Another Author" } }] }],
    [{ ...work, publication_year: 2014 }],
    [work, { ...work, id: "W0000", doi: "10.9999/other-work" }],
  ];
  for (const rows of testRows) {
    const ctx = environment(u => u.hostname === "api.openalex.org" ? { results: rows } : null);
    assert.deepEqual(await ctx.all(itemFor(paper)), []);
  }
});

test("a failed bibliographic DOI lookup still tries title; conflicting published DOIs and arXiv IDs are rejected", async () => {
  const paper = articles[1];
  const ctx = environment(u => {
    if (u.hostname === "api.openalex.org" && u.searchParams.has("filter")) return { results: [workFor(paper)] };
    throw Object.assign(new Error("rate limited"), { status: 429 });
  });
  const found = await ctx.all(itemFor(paper, "10.9999/edition"));
  assert.equal(found[0].url, "https://arxiv.org/pdf/" + paper.id);
  const mismatch = environment(u => u.hostname === "api.openalex.org" && u.searchParams.has("filter")
    ? { results: [{ ...workFor(paper), doi: "10.9999/different-edition" }] } : null);
  assert.deepEqual(await mismatch.all(itemFor(paper, "10.9999/original")), []);
  // The caller's verified arXiv ID is offered directly; incompatible catalogue hits add nothing.
  assert.deepEqual((await ctx.all(itemFor(paper), { arxiv: "2008.03703" })).map(r => r.url), ["https://arxiv.org/pdf/2008.03703"]);
});

test("an exact DOI can resolve without an author and is preferred to a separate same-title hit", async () => {
  const paper = articles[0], work = workFor(paper);
  const item = itemFor(paper, "10.48550/arxiv." + paper.id);
  item.getCreators = () => [];
  const ctx = environment(u => {
    if (u.hostname !== "api.openalex.org") return null;
    if (u.searchParams.has("filter")) return { results: [work, { ...work, id: "W2222", doi: "10.1234/else" }] };
    return { ...work, doi: "https://doi.org/10.1234/wrong" };
  });
  // The direct identifier and the independently verified catalogue URL are the same candidate.
  assert.deepEqual([...new Set((await ctx.all(item)).map(r => r.url))], ["https://arxiv.org/pdf/" + paper.id]);
});

test("Semantic Scholar validates its DOI/title matches and can supply a verified alternative arXiv record", async () => {
  const paper = articles[0], doi = "10.9999/published";
  const row = { paperId: "S2", title: paper.title, authors: [{ name: paper.author }], year: paper.year,
    externalIds: { DOI: doi, ArXiv: paper.id }, openAccessPdf: { url: "https://uni.example/fulltext.pdf" } };
  const ctx = environment(u => {
    if (u.hostname !== "api.semanticscholar.org") return null;
    if (u.pathname.endsWith("/search")) return { data: [row] };
    return { ...row, externalIds: { DOI: "10.9999/other" } };
  });
  assert.deepEqual((await ctx.all(itemFor(paper, doi))).map(r => r.url), [
    row.openAccessPdf.url, "https://arxiv.org/pdf/" + paper.id
  ]);
});

// Use the same DOM interface exposed by Zotero.HTTP.request(responseType=document).
// Each element searches only its descendants within the requested XML namespace.
function element(namespace, name, textContent, children = []) {
  const node = { namespace, name, textContent, getElementsByTagNameNS(ns, tag) {
    return children.flatMap(child => [...(child.namespace === ns && child.name === tag ? [child] : []),
      ...child.getElementsByTagNameNS(ns, tag)]);
  } };
  return node;
}
test("arXiv Atom title search scopes author, year and ID to the same entry and supports versioned IDs", async () => {
  const atom = "http://www.w3.org/2005/Atom";
  const paper = articles[1], arxiv = paper.id + "v3";
  const tag = (name, value, children) => element(atom, name, value, children);
  const entry = (id, title) => tag("entry", "", [
    tag("id", "http://arxiv.org/abs/" + id), tag("published", "2022-09-12T00:00:00Z"), tag("title", title),
    tag("author", "", [tag("name", paper.author)]),
  ]);
  const doc = tag("feed", "", [entry("2401.01234", "Another title"), entry(arxiv, paper.title)]);
  const ctx = environment((u, options) => {
    if (u.hostname !== "export.arxiv.org") return null;
    assert.equal(options.responseType, "document");
    assert.match(u.searchParams.get("search_query"), /^ti:"Coverage-centric/);
    return doc;
  });
  assert.deepEqual((await ctx.all(itemFor(paper))).map(r => r.url), ["https://arxiv.org/pdf/" + arxiv]);
});

test("CORE only uses matching work DOI/downloadUrl; incomplete inputs produce no title-based network calls", async () => {
  const paper = articles[2], doi = "10.1000/verified";
  const ctx = environment(u => {
    if (u.hostname !== "api.core.ac.uk") return null;
    assert.equal(u.searchParams.get("q"), 'doi:"' + doi + '"');
    return { results: [
      { id: 1, doi: "10.1000/other", downloadUrl: "https://repo.example/wrong.pdf" },
      { id: 2, doi: ["https://doi.org/" + doi], downloadUrl: "https://repo.example/download/32" },
      { id: 3, doi, title: "Different paper", downloadUrl: "https://repo.example/other.pdf" },
    ] };
  });
  const bareDOI = { getField: name => name === "DOI" ? doi : name === "title" ? paper.title : "", getCreators: () => [] };
  assert.deepEqual((await ctx.all(bareDOI)).map(r => r.url), ["https://repo.example/download/32"]);
  assert.ok(!ctx.calls.some(c => c.u.searchParams.has("filter") || c.u.pathname.endsWith("/paper/search")));
});

test("non-Latin titles and given names survive matching and filter punctuation cannot inject another OpenAlex filter", async () => {
  const title = "视觉表征, 迁移学习", item = {
    getField: f => f === "title" ? title : f === "date" ? "2024" : "",
    getCreators: () => [{ lastName: "张", firstName: "宁", creatorType: "author" }]
  };
  const ctx = environment(u => {
    if (u.hostname !== "api.openalex.org") return null;
    assert.equal(u.searchParams.get("filter"), "title.search:视觉表征  迁移学习");
    return { results: [{ ...workFor(articles[1]), title, publication_year: 2024,
      authorships: [{ author: { display_name: "张宁" } }] }] };
  });
  assert.equal((await ctx.all(item)).length, 1);
});
