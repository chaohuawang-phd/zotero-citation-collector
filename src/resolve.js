// Keep identification and lookup read-only. The controller serializes membership changes.
var CitationResolver = (() => {
  function clean(value) {
    return String(value ?? "").normalize("NFKC").replace(/\u00ad/g, "")
      .replace(/(\p{L})-\s+(?=\p{Ll})/gu, "$1").replace(/\s+/g, " ").trim();
  }

  function plain(value) {
    return clean(value).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  }

  function key(value) {
    return clean(value).normalize("NFKD").toLowerCase()
      .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  }

  const yearPattern = /\b(?:19|20)\d{2}[a-z]?\b/gi;
  const years = text => (String(text || "").match(yearPattern) || []).map(y => y.slice(0, 4));
  const words = text => String(text || "").match(/[\p{L}\p{N}]+/gu) || [];
  const unique = values => [...new Set(values.filter(Boolean))];
  const cutPeriod = text => clean(text).replace(/[.,;]+$/, "");

  function doiOf(text) {
    const match = clean(text).match(/\b10\.\d{4,9}\/[a-z0-9._;()/:+-]+/i);
    if (!match) return "";
    let doi = match[0].toLowerCase().replace(/[.;:,]+$/, "");
    while (doi.endsWith(")") && doi.split(")").length > doi.split("(").length) doi = doi.slice(0, -1);
    return doi;
  }

  function arxivOf(text) {
    return (clean(text).match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/\s*|10\.48550\/arxiv\.)(\d{4}\.\s*\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?\b/i)
      || [])[1]?.replace(/\s+/g, "").toLowerCase() || "";
  }

  function forumOf(text) {
    return (clean(text).match(/https?:\/\/openreview\.net\/(?:forum|pdf)\?\s*id=([A-Za-z0-9_-]+)/i) || [])[1] || "";
  }

  function fullName(name) {
    const parts = clean(name).split(/\s+/);
    return { lastName: parts.pop(), firstName: parts.join(" ") };
  }

  function parse(text) {
    const raw = clean(text);
    // Numbered bibliographies often start with "[23]" or "23."; don't strip a publication year.
    let rest = raw.replace(/^\s*(?:\[\d+\]|\d{1,3}[.)])\s*/, "");
    const authors = [];
    const inverted = /^(?:(?:and|&)\s+)?([\p{L}][\p{L}\p{M}’'\-]*(?:\s+[\p{L}][\p{L}\p{M}’'\-]*){0,3}),\s*((?:\p{Lu}\.(?:[- ](?=\p{Lu}\.))?){1,5})/u;
    let match;
    while ((match = inverted.exec(rest))) {
      authors.push({ lastName: match[1], firstName: match[2].trim() });
      rest = rest.slice(match[0].length).replace(/^\s*,?\s*/, "");
    }
    rest = rest.replace(/^et\s+al\.\s*/i, "");
    rest = rest.replace(/^[.(\s]*(?:19|20)\d{2}[a-z]?[).,:\s]+/i, "");
    const quoted = raw.match(/["“]([^"”]{8,500})[”"]/);
    let title = quoted ? cutPeriod(quoted[1]) : "";
    if (!title && authors.length) {
      title = cutPeriod(rest.split(/\.\s+(?=[\p{Lu}(])|\s+https?:\/\/|\s+doi:\s*/u)[0]);
      if (title === rest && /(?:19|20)\d{2}/.test(title)) title = "";
    }
    if (words(title).length < 2 || title.length > 480) title = "";
    const stripped = raw.replace(/https?:\/\/\S+|(?:arxiv|doi):\s*\S+/gi, "");
    return { raw, title, authors, year: years(stripped).at(-1) || "", mentionedYears: unique(years(stripped)),
      doi: doiOf(raw), arxiv: arxivOf(raw), forum: forumOf(raw) };
  }

  function sameID(a, b) {
    return Boolean((a.doi && a.doi === b.doi) || (a.arxiv && a.arxiv === b.arxiv)
      || (a.forum && a.forum === b.forum));
  }

  function nearYear(a, b) {
    return Boolean(a && b && Math.abs(Number(a) - Number(b)) <= 1);
  }

  function sameAuthor(a, b) {
    const left = a.authors?.[0], right = b.authors?.[0];
    if (!left?.lastName || !right?.lastName || key(left.lastName) !== key(right.lastName)) return false;
    return !left.firstName || !right.firstName || key(left.firstName)[0] === key(right.firstName)[0];
  }

  function compatibleIDs(a, b) {
    if (a.arxiv && b.arxiv && a.arxiv !== b.arxiv) return false;
    return !a.doi || !b.doi || a.doi === b.doi || a.doi.startsWith("10.48550/arxiv.") || b.doi.startsWith("10.48550/arxiv.");
  }

  function titleMatch(q, c) {
    const titleKey = key(c.title);
    if (q.title && key(q.title) === titleKey) return true;
    return titleKey.length >= 14 && words(c.title).length >= 3 && key(q.raw).includes(titleKey);
  }

  function rank(q, c) {
    if (!c.title) return 0;
    if (sameID(q, c)) {
      // A DOI in a damaged or combined reference can genuinely resolve, but to
      // the wrong work. Bare identifiers identify themselves; also check title
      // evidence when a bibliography accompanies the identifier.
      const bare = /^(?:(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+|(?:arxiv\s*:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)\S+|https?:\/\/openreview\.net\/(?:forum|pdf)\?id=[a-z0-9_-]+)[.,;]?$/i.test(q.raw);
      return compatibleIDs(q, c) && (bare || titleMatch(q, c)) ? 4 : 2;
    }
    if (!compatibleIDs(q, c)) return 0;
    if (!titleMatch(q, c)) return 0;
    const author = q.authors.length ? sameAuthor(q, c)
      : Boolean(c.authors?.[0]?.lastName && words(q.raw).slice(0, 20).some(w => key(w) === key(c.authors[0].lastName)));
    return author && q.mentionedYears.includes(c.year) ? 3 : 2;
  }

  function paperFromItem(item) {
    const field = name => String(item.getField(name) || "");
    const extra = CitationReview.bibliographicExtra(field("extra"));
    const url = field("url");
    const doi = doiOf(field("DOI") || (extra.match(/^DOI:\s*(.+)$/im) || [])[1] || "");
    const creators = item.getCreators();
    const primary = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
    const authors = creators.filter(c => c.creatorTypeID === primary);
    return { title: clean(field("title")), itemID: item.id, authors, year: years(field("date"))[0] || "",
      doi, url, arxiv: arxivOf([doi, url, extra, "arXiv:" + field("archiveID")].join(" ")), forum: forumOf(url),
      venue: field("publicationTitle") || field("proceedingsTitle"), type: item.itemType, source: "Zotero" };
  }

  async function localPapers(q, libraryID) {
    const search = new Zotero.Search();
    search.libraryID = libraryID;
    search.addCondition("joinMode", "any");
    const tokens = unique(words(q.title || q.raw).filter(w => w.length >= 4 && !/^\d+$/.test(w)))
      .sort((a, b) => b.length - a.length).slice(0, 3);
    const stable = unique([q.doi, q.arxiv, q.forum]);
    if (!stable.length && !tokens.length) return [];
    for (const token of tokens) search.addCondition("title", "contains", token);
    if (q.title) search.addCondition("title", "is", q.title);
    // "field" includes DOI, URLs, the archive ID and Extra across item types.
    for (const id of stable) search.addCondition("field", "contains", id);
    const items = await Zotero.Items.getAsync(await search.search());
    const regular = items.filter(i => i.libraryID === libraryID && !i.deleted && i.isRegularItem() && i.isTopLevelItem());
    if (regular.length) await Zotero.Items.loadDataTypes(regular, ["itemData", "creators"]);
    return regular.map(paperFromItem);
  }

  async function getJSON(url) {
    try {
      const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 7000, anon: true,
        headers: { Accept: "application/json" } });
      return xhr.response;
    } catch (error) {
      // A rate-limited or unavailable catalog must never produce an invented record.
      Zotero.debug("Citation Collector: " + url.split("/")[2] + " lookup unavailable (" + (error.status || "network") + ")");
      return null;
    }
  }

  function crossref(row) {
    const type = { "proceedings-article": "conferencePaper", "journal-article": "journalArticle",
      book: "book", "posted-content": "preprint", "book-chapter": "bookSection" }[row.type] || "document";
    return { title: plain(row.title?.[0]), authors: (row.author || []).map(a => ({ firstName: a.given || "", lastName: a.family || a.name || "" })),
      year: String((row.published || row.issued)?.["date-parts"]?.[0]?.[0] || ""),
      doi: doiOf(row.DOI), arxiv: arxivOf(row.DOI), url: row.URL || "", venue: plain(row["container-title"]?.[0]),
      type, source: "Crossref" };
  }

  function dataCite(data) {
    const a = data?.attributes;
    if (!a?.titles?.length) return null;
    const doi = doiOf(a.doi);
    return { title: plain(a.titles[0].title), authors: (a.creators || []).map(c => c.familyName
      ? { firstName: c.givenName || "", lastName: c.familyName } : fullName(c.name || "")),
      year: String(a.publicationYear || ""), doi, arxiv: arxivOf(doi), url: a.url || "", venue: "",
      type: arxivOf(doi) ? "preprint" : "document", source: "DataCite" };
  }

  function openReview(note) {
    const content = note.content || {};
    const attr = k => content[k]?.value ?? content[k];
    if (!attr("title") || note.replyto || note.ddate) return null;
    const authors = Array.isArray(attr("authors")) ? attr("authors").map(fullName) : [];
    const venue = plain(attr("venue") || attr("booktitle"));
    const year = years(venue)[0] || (note.pdate || note.cdate ? String(new Date(note.pdate || note.cdate).getUTCFullYear()) : "");
    const url = "https://openreview.net/forum?id=" + encodeURIComponent(note.forum || note.id);
    return { title: plain(attr("title")), authors, year, doi: doiOf(attr("doi")), arxiv: "", url, venue,
      forum: forumOf(url), type: venue && !/withdraw|reject|submit|under review/i.test(venue) ? "conferencePaper" : "preprint",
      source: "OpenReview", indexMirror: (attr("venueid") || "").startsWith("dblp.org/") };
  }

  async function lookup(q) {
    const enc = encodeURIComponent;
    const jobs = [];
    if (q.doi || q.arxiv) {
      const id = q.doi || "10.48550/arXiv." + q.arxiv;
      if (!id.toLowerCase().startsWith("10.48550/arxiv.")) jobs.push(getJSON("https://api.crossref.org/works/" + enc(id))
        .then(res => res?.message?.DOI ? [crossref(res.message)] : []));
      jobs.push(getJSON("https://api.datacite.org/dois/" + enc(id)).then(res => [dataCite(res?.data)]));
    }
    if (q.forum) {
      for (const host of ["api", "api2"]) {
        jobs.push(getJSON("https://" + host + ".openreview.net/notes?id=" + enc(q.forum))
          .then(res => (res?.notes || []).map(openReview)));
      }
    }
    let found = (await Promise.all(jobs)).flat().filter(Boolean);
    if (found.some(c => sameID(q, c) && c.title)) return found;
    const query = q.raw.slice(0, 680);
    const searches = [getJSON("https://api.crossref.org/works?rows=5&query.bibliographic=" + enc(query))
      .then(res => (res?.message?.items || []).map(crossref))];
    if (q.title) {
      for (const host of ["api", "api2"]) {
        searches.push(getJSON("https://" + host + ".openreview.net/notes/search?content=title&limit=5&term=" + enc(q.title))
          .then(res => (res?.notes || []).map(openReview)));
      }
    }
    return found.concat((await Promise.all(searches)).flat().filter(Boolean));
  }

  function ranked(q, candidates) {
    const ordered = candidates.map(c => ({ c, score: rank(q, c) })).filter(x => x.score)
      .sort((a, b) => b.score - a.score || Number(!!a.c.indexMirror) - Number(!!b.c.indexMirror));
    const chosen = [];
    for (const entry of ordered) {
      const duplicate = chosen.some(({ c }) => sameID(entry.c, c) || (compatibleIDs(entry.c,c)
        && key(entry.c.title) === key(c.title) && sameAuthor(entry.c,c) && nearYear(entry.c.year,c.year)));
      if (!duplicate) chosen.push(entry);
    }
    return { candidates: chosen.map(x => x.c), confident: chosen.length === 1 && chosen[0].score >= 3 };
  }

  async function resolve(text, libraryID) {
    if (!text || String(text).length > 4500) return { candidates: [], confident: false };
    const q = parse(text);
    // The native reader can return multiple references. Never funnel different identifiers into one item.
    const doiIDs = unique(Array.from(q.raw.matchAll(/\b10\.\d{4,9}\/[^\s]+/gi), m => doiOf(m[0])));
    const arxivIDs = unique(Array.from(q.raw.matchAll(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/\s*|10\.48550\/arxiv\.)(?:\d{4}\.\s*\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?\b/gi), m => arxivOf(m[0])));
    const forumIDs = unique(Array.from(q.raw.matchAll(/https?:\/\/openreview\.net\/(?:forum|pdf)\?\s*id=[A-Za-z0-9_-]+/gi), m => forumOf(m[0])));
    if (doiIDs.length > 1 || arxivIDs.length > 1 || forumIDs.length > 1
      || (!q.doi && !q.arxiv && !q.forum && words(q.raw).length < 6)) {
      return { candidates: [], confident: false };
    }
    const local = await localPapers(q, libraryID);
    const matching = ranked(q, local);
    if (matching.candidates.length) return matching;
    const remote = ranked(q, await lookup(q));
    if (remote.candidates.length) return remote;
    // Allow a person to verify a genuine parsed bibliography entry during catalog outages.
    // An author-year marker or an opaque identifier alone cannot create a bibliographic record.
    if (q.title && q.authors.length && q.year && (words(q.title).length >= 3 || q.doi || q.arxiv)) {
      return { confident: false, candidates: [{ title: q.title, authors: q.authors, year: q.year, doi: q.doi,
        arxiv: q.arxiv, forum: q.forum, venue: "", url: q.forum ? "https://openreview.net/forum?id=" + q.forum : "",
        type: "document", source: "PDF", raw: q.raw }] };
    }
    return { candidates: [], confident: false };
  }

  async function findExisting(candidate, libraryID) {
    if (candidate.itemID) {
      const item = await Zotero.Items.getAsync(candidate.itemID);
      if (item && !item.deleted && item.libraryID === libraryID && item.isRegularItem()) return item;
      throw new Error("这条文库记录已更改，请重新点击引文。");
    }
    const local = await localPapers(candidate, libraryID);
    let match = local.find(paper => sameID(candidate, paper));
    if (!match) {
      const titleHits = local.filter(paper => key(candidate.title) === key(paper.title));
      match = titleHits.find(paper => sameAuthor(candidate, paper) && nearYear(candidate.year, paper.year) && compatibleIDs(candidate, paper));
      if (!match && titleHits.length) {
        throw new Error("文库已有同题名条目，但作者、年份或标识符不足以确认。请核对已有条目。");
      }
    }
    return match ? Zotero.Items.getAsync(match.itemID) : null;
  }

  function makeItem(candidate, libraryID) {
    const item = new Zotero.Item(candidate.type || "document");
    item.libraryID = libraryID;
    item.setField("title", candidate.title);
    if (candidate.year) item.setField("date", candidate.year);
    const url = candidate.url || (candidate.doi ? "https://doi.org/" + candidate.doi : candidate.arxiv && "https://arxiv.org/abs/" + candidate.arxiv);
    if (url && /^https?:\/\//i.test(url)) item.setField("url",url);
    const extra = [];
    if (candidate.doi) {
      if (Zotero.ItemFields.isValidForType("DOI", item.itemTypeID)) item.setField("DOI", candidate.doi);
      else extra.push("DOI: " + candidate.doi);
    }
    if (candidate.arxiv) extra.push("arXiv: " + candidate.arxiv);
    if (extra.length) item.setField("extra", extra.join("\n"));
    const venueField = { conferencePaper:"proceedingsTitle", journalArticle:"publicationTitle", bookSection:"bookTitle" }[candidate.type];
    if (venueField && candidate.venue) item.setField(venueField, candidate.venue);
    if (candidate.authors?.length) item.setCreators(candidate.authors.map(person =>
      ({ creatorType: "author", firstName: person.firstName || "", lastName: person.lastName || "" })));
    return item;
  }
  return { resolve, findExisting, makeItem };
})();
