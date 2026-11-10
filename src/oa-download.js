// Public repository links can redirect. Fetch them without cookies and check
// every destination before making a request, including links on landing pages.
const CitationOADownload = (() => {
  const redirects = new Set([301, 302, 303, 307, 308]);

  function absoluteURL(value, base) {
    const url = new URL(value, base);
    url.hash = "";
    if (url.protocol === "http:") url.protocol = "https:";
    return url.href;
  }

  async function articlePDFLink(blob, pageURL) {
    const html = await blob.slice(0, 512 * 1024).text();
    if (!/citation_pdf_url|application\/pdf/i.test(html)) return null;

    // Template contents stay inert; image/iframe URLs and scripts from this
    // remote HTML are never added to a live document.
    const template = Zotero.getMainWindow().document.createElementNS("http://www.w3.org/1999/xhtml", "template");
    template.innerHTML = html;
    const selectors = [
      ['meta[name="citation_pdf_url" i]', "content"],
      ['link[rel~="alternate" i][type="application/pdf" i]', "href"]
    ];
    for (const [selector, attribute] of selectors) {
      const urls = new Set();
      for (const tag of template.content.querySelectorAll(selector)) {
        const value = tag.getAttribute(attribute)?.trim();
        if (!value) continue;
        try { urls.add(absoluteURL(value, pageURL)); } catch { /* Invalid metadata URL. */ }
      }
      if (urls.size) return urls.size === 1 ? urls.values().next().value : null;
    }
    return null;
  }

  async function download(resolver, path, check) {
    let url = absoluteURL(resolver.url || resolver.pageURL);
    const visited = new Set();
    let followedArticleLink = false;
    while (visited.size < 8 && !visited.has(url)) {
      await check(url);
      visited.add(url);
      const response = await Zotero.HTTP.request("GET", url, {
        responseType: "blob", anon: true, followRedirects: false,
        timeout: 20000, errorDelayMax: 0, noRetryOnThrottle: true
      });
      if (redirects.has(response.status)) {
        const location = response.getResponseHeader("Location");
        if (!location) return false;
        url = absoluteURL(location, url);
        continue;
      }
      const blob = response.response;
      // A partial response starting at byte zero can have a valid PDF header.
      if (![200, 203].includes(response.status) || !blob?.size) return false;
      const finalURL = absoluteURL(response.responseURL || url);
      await check(finalURL);
      const prefix = await blob.slice(0, 1024).text();
      if (/^\s*%PDF-\d\.\d\b/.test(prefix)) {
        await Zotero.File.putContentsAsync(path, blob);
        return { url: finalURL };
      }
      // Only follow explicit PDF metadata from one HTML page per candidate.
      const contentType = response.getResponseHeader("Content-Type") || blob.type || "";
      if (followedArticleLink || !/\b(?:html|xhtml)\b/i.test(contentType) && !/^\s*<(?:!doctype\s+html|html)\b/i.test(prefix)) return false;
      url = await articlePDFLink(blob, finalURL);
      if (!url) return false;
      followedArticleLink = true;
    }
    return false;
  }

  return { download };
})();
