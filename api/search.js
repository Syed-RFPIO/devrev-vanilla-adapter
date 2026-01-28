export default async function handler(req, res) {
  try {
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const cursor = (req.query.cursor ?? "").toString();

    // auth (optional)
    const incomingKey = req.headers["x-adapter-key"];
    if (process.env.ADAPTER_KEY && incomingKey !== process.env.ADAPTER_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io").replace(/\/+$/, "");

    // adapter base detection for building absolute pager URLs
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const ADAPTER_BASE = (host ? `${proto}://${host}` : (process.env.ADAPTER_BASE_URL ?? null)) ?? null;

    const headers = {
      Authorization: `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json",
    };

    // helper: true if this article has a Responsive Help Center URL we want to expose
    const hasResponsiveExternalRef = (articleObj) => {
      const ext = articleObj?.sync_metadata?.external_reference;
      return typeof ext === "string" && ext.startsWith(HELP_BASE);
    };

    // 1) fetch page of results (the page we'll return)
    const pageBody = { query: q, namespaces: ["article"], limit: perPage, mode: "after" };
    if (cursor) pageBody.cursor = cursor;

    const pageResp = await fetch("https://api.devrev.ai/search.core", {
      method: "POST",
      headers,
      body: JSON.stringify(pageBody),
    });
    if (!pageResp.ok) {
      const txt = await pageResp.text();
      return res.status(pageResp.status).send(txt);
    }
    const pageJson = await pageResp.json();

    // 2) Count only items that have a valid Responsive external_reference
    const MAX_PAGES_TO_COUNT = Number(process.env.MAX_PAGES_TO_COUNT ?? 50);
    const COUNT_PAGE_SIZE = Math.min(Number(process.env.COUNT_PAGE_SIZE ?? 50), 100);

    let total = 0;
    let nextCursor = "";
    let loops = 0;

    while (loops < MAX_PAGES_TO_COUNT) {
      const countBody = { query: q, namespaces: ["article"], limit: COUNT_PAGE_SIZE, mode: "after" };
      if (nextCursor) countBody.cursor = nextCursor;

      const r = await fetch("https://api.devrev.ai/search.core", {
        method: "POST",
        headers,
        body: JSON.stringify(countBody),
      });

      if (!r.ok) break;
      const j = await r.json();

      const pageCount = Array.isArray(j.results)
        ? j.results.reduce((acc, item) => {
            const articleObj = item?.article ?? item;
            return acc + (hasResponsiveExternalRef(articleObj) ? 1 : 0);
          }, 0)
        : 0;

      total += pageCount;

      if (!j.next_cursor) break;
      nextCursor = j.next_cursor;
      loops += 1;
    }

    // 3) Map + FILTER page results to include only Responsive external links
    const mappedResults = (pageJson.results ?? [])
      .map((hit) => {
        const article = hit?.article ?? {};
        if (!hasResponsiveExternalRef(article)) return null;

        const title = article.title ?? article.display_name ?? article.name ?? "Help Center Article";
        const url = article.sync_metadata.external_reference;
        return { title, url };
      })
      .filter(Boolean);

    // 4) Build absolute next/previous URLs for Vanilla to call (Vanilla expects full URLs)
    const makePagerUrl = (cursorToken, nextPageNumber) => {
      if (!cursorToken || !ADAPTER_BASE) return null;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("perPage", String(perPage));
      params.set("page", String(nextPageNumber ?? page + 1));
      params.set("cursor", cursorToken);
      return `${ADAPTER_BASE.replace(/\/+$/, "")}/api/search?${params.toString()}`;
    };

    const nextUrl = pageJson.next_cursor ? makePagerUrl(pageJson.next_cursor, page + 1) : null;
    const prevUrl = pageJson.prev_cursor ? makePagerUrl(pageJson.prev_cursor, Math.max(1, page - 1)) : null;

    // 5) Return response
    return res.status(200).json({
      results: {
        count: Number.isFinite(total) ? total : 0,
        currentPage: page,
        perPage,
        next: nextUrl,
        previous: prevUrl,
        results: mappedResults,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
