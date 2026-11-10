// Additional public catalogues for a citation whose native Zotero routes failed.
const CitationPDFSources = (() => {
  const limit = 5;
  const atom = "http://www.w3.org/2005/Atom";
  const arxivNS = "http://arxiv.org/schemas/atom";
  const arxivPattern = /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i;
  const openAlexFields = "id,doi,title,authorships,publication_year,locations,best_oa_location";
  const semanticFields = "title,year,authors,externalIds,openAccessPdf";

  function normalized(value) {
    return String(value || "").normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function doiID(value) {
    const id = String(value || "").trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
    return /^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(id) ? id.toLowerCase() : "";
  }

  function arxivID(value) {
    const id = String(value || "").trim().replace(/^(?:https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.|arxiv:\s*)/i, "")
      .replace(/\.pdf$/i, "");
    return arxivPattern.test(id) ? id.toLowerCase() : "";
  }

  function identity(item, candidate) {
    const field = name => String(item.getField(name) || "").trim();
    const extra = CitationReview.bibliographicExtra(field("extra"));
    const doi = doiID(field("DOI")) || doiID(extra.match(/^DOI:\s*(\S+)/im)?.[1]) || doiID(candidate.doi);
    const arxiv = arxivID(field("archiveID")) || arxivID(extra.match(/^arXiv:\s*(\S+)/im)?.[1])
      || arxivID(field("url")) || arxivID(doi) || arxivID(candidate.arxiv) || arxivID(candidate.url);
    const creators = item.getCreators?.() || [];
    const primary = Zotero.CreatorTypes?.getPrimaryIDForType(item.itemTypeID);
    const first = creators.find(c => c.creatorType === "author" || (primary != null && c.creatorTypeID === primary))
      || candidate.authors?.[0];
    const title = field("title") || String(candidate.title || "").trim();
    const year = (field("date") || String(candidate.year || "")).match(/\b(?:18|19|20)\d{2}\b/)?.[0];
    return { title, titleKey: normalized(title), doi, arxiv, year: Number(year) || 0,
      first: first?.firstName || "", last: first?.lastName || first?.name || "" };
  }

  function authorMatches(name, work) {
    // Compare the full family name at a word boundary, including multiword names.
    const parts = String(name || "").replace(/\./g, " ").trim().split(/[\s,]+/).filter(Boolean);
    const family = normalized(work.last);
    for (let i = 0; i < parts.length; i++) {
      if (normalized(parts.slice(i).join(" ")) === family) {
        return !work.first || i === 0 || normalized(parts[0])[0] === normalized(work.first)[0];
      }
    }
    // Some providers return "family, given" or an unspaced Chinese name.
    const inverted = String(name || "").split(",");
    return (inverted.length === 2 && normalized(inverted[0]) === family
      && (!work.first || normalized(inverted[1])[0] === normalized(work.first)[0]))
      || (!!work.first && normalized(name) === normalized(work.last + work.first));
  }

  function matches(work, row) {
    const arxiv = id => id.replace(/v\d+$/, "");
    if (work.arxiv && row.arxiv && arxiv(work.arxiv) !== arxiv(row.arxiv)) return false;
    const exactDOI = !!work.doi && work.doi === row.doi;
    if (work.doi && row.doi && !exactDOI && !arxivID(work.doi) && !arxivID(row.doi)) return false;
    const exactID = exactDOI || (work.arxiv && row.arxiv && arxiv(work.arxiv) === arxiv(row.arxiv));
    if (work.titleKey && row.title && work.titleKey !== normalized(row.title)) return false;
    if (exactID) return true;
    if (work.titleKey.length < 4 || work.titleKey !== normalized(row.title)) return false;
    if (work.year && (!row.year || Math.abs(work.year - row.year) > 1)) return false;
    if (work.last && !authorMatches(row.author, work)) return false;
    return Boolean(work.last || work.year);
  }

  function publicURL(value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
          || !url.hostname.includes(".") || /(?:^|\.)(?:local|localhost)\.?$/i.test(url.hostname)
          || /^[.\d]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
      url.hash = "";
      return url;
    } catch { return null; }
  }

  // Zotero treats a URL as a file and a pageURL as an article landing page.
  function locations(entries, work) {
    const seen = new Set(), files = [];
    for (const entry of entries) {
      const parsed = publicURL(entry.url || entry.pageURL);
      if (!parsed) continue;
      const arxiv = arxivID(parsed.origin + parsed.pathname);
      if (work.arxiv && arxiv && work.arxiv.replace(/v\d+$/, "") !== arxiv.replace(/v\d+$/, "")) continue;
      const url = arxiv ? "https://arxiv.org/pdf/" + arxiv : parsed.href;
      if (seen.has(url)) continue;
      seen.add(url);
      files.push({ [arxiv || entry.url ? "url" : "pageURL"]: url, accessMethod: "repository" });
      if (files.length >= 16) break;
    }
    return files;
  }

  function candidates(work, rows) {
    let matching = rows.filter(row => matches(work, row));
    if (!matching.length) return [];
    // Prefer a verified identifier to a title collision elsewhere in the list.
    const anchored = matching.filter(row => (work.doi && row.doi === work.doi)
      || (work.arxiv && row.arxiv && work.arxiv.replace(/v\d+$/, "") === row.arxiv.replace(/v\d+$/, "")));
    if (anchored.length) matching = anchored;
    // Exact title/year collisions can be distinct papers. Only coalesce records
    // carrying the same identifier.
    const keys = new Set(matching.map(row => row.doi || row.arxiv || row.id));
    if (keys.size !== 1 || (!matching[0].id && !matching[0].doi && !matching[0].arxiv && matching.length > 1)) return [];
    return locations(matching.flatMap(row => row.locations), work);
  }

  async function request(url, document = false) {
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        responseType: document ? "document" : "json", timeout: 7000, errorDelayMax: 0, anon: true,
        headers: { Accept: document ? "application/atom+xml, application/xml" : "application/json" }
      });
      return xhr.response;
    } catch (error) {
      Zotero.debug("正文引文收藏：" + new URL(url).hostname + " 全文检索暂不可用（" + (error.status || "network") + "）");
      return null;
    }
  }

  function openAlexRow(row) {
    const doi = doiID(row.doi);
    const versionRank = v => ({ publishedVersion: 0, acceptedVersion: 1, submittedVersion: 2 })[v] ?? 3;
    const copies = [row.best_oa_location, ...(row.locations || [])].filter(l => l?.is_oa === true)
      .sort((a, b) => versionRank(a.version) - versionRank(b.version));
    return { id: row.id, doi, arxiv: arxivID(doi), title: row.title, year: Number(row.publication_year),
      author: row.authorships?.[0]?.author?.display_name,
      locations: [...copies.map(l => ({ url: l.pdf_url })), ...copies.map(l => ({ pageURL: l.landing_page_url }))] };
  }

  function semanticRow(row) {
    const doi = doiID(row.externalIds?.DOI);
    const arxiv = arxivID(row.externalIds?.ArXiv) || arxivID(doi);
    const copies = [{ url: row.openAccessPdf?.url }];
    if (arxiv) copies.push({ url: "https://arxiv.org/pdf/" + arxiv });
    return { id: row.paperId, doi, arxiv, title: row.title, year: Number(row.year),
      author: row.authors?.[0]?.name, locations: copies };
  }

  function atomRows(doc) {
    if (!doc?.getElementsByTagNameNS) return [];
    return Array.from(doc.getElementsByTagNameNS(atom, "entry")).slice(0, limit).map(entry => {
      const value = (name, ns = atom) => entry.getElementsByTagNameNS(ns, name)[0]?.textContent.trim() || "";
      const arxiv = arxivID(value("id"));
      const author = entry.getElementsByTagNameNS(atom, "author")[0]?.getElementsByTagNameNS(atom, "name")[0];
      return { id: arxiv, arxiv, doi: doiID(value("doi", arxivNS)), title: value("title"),
        year: Number(value("published").slice(0, 4)), author: author?.textContent,
        locations: arxiv ? [{ url: "https://arxiv.org/pdf/" + arxiv }] : [] };
    });
  }

  function providers(item, candidate = {}) {
    const work = identity(item, candidate);
    const lookupTitle = work.titleKey.length >= 4 && work.title.length <= 700 && (work.year || work.last);
    const enc = encodeURIComponent, jobs = [];
    const oa = "https://api.openalex.org/works";
    const s2 = "https://api.semanticscholar.org/graph/v1/paper";
    if (work.arxiv) {
      jobs.push(async () => [{ url: "https://arxiv.org/pdf/" + work.arxiv, accessMethod: "repository" }]);
    }
    if (work.doi) jobs.push(async () => {
      const row = await request(oa + "/https://doi.org/" + enc(work.doi) + "?select=" + openAlexFields);
      return row && doiID(row.doi) === work.doi ? candidates(work, [openAlexRow(row)]) : [];
    });
    if (lookupTitle) jobs.push(async () => {
      // Commas and pipes have syntactic meaning even in a URL-encoded OpenAlex filter.
      const title = work.title.replace(/[,|]/g, " ");
      const res = await request(oa + "?filter=" + enc("title.search:" + title) + "&per_page=" + limit + "&select=" + openAlexFields);
      return candidates(work, (res?.results || []).map(openAlexRow));
    }, async () => {
      const query = 'ti:"' + work.title.replace(/["\\]/g, " ") + '"';
      const doc = await request("https://export.arxiv.org/api/query?search_query=" + enc(query) + "&max_results=" + limit, true);
      return candidates(work, atomRows(doc));
    });
    if (work.doi) jobs.push(async () => {
      const row = await request(s2 + "/DOI:" + enc(work.doi) + "?fields=" + semanticFields);
      return row && doiID(row.externalIds?.DOI) === work.doi ? candidates(work, [semanticRow(row)]) : [];
    });
    if (lookupTitle) jobs.push(async () => {
      const res = await request(s2 + "/search?query=" + enc(work.title) + "&limit=" + limit + "&fields=" + semanticFields);
      return candidates(work, (res?.data || []).map(semanticRow));
    });
    if (work.doi) jobs.push(async () => {
      const query = 'doi:"' + work.doi + '"';
      const res = await request("https://api.core.ac.uk/v3/search/works?q=" + enc(query) + "&limit=" + limit);
      const rows = (res?.results || []).filter(r => [r.doi].flat().some(id => doiID(id) === work.doi))
        .map(r => ({ id: r.id, doi: work.doi, title: r.title, locations: [{ url: r.downloadUrl }] }));
      return candidates(work, rows);
    });
    return jobs;
  }
  return { providers };
})();
