export default async function handler(req, res) {
  try {
    // ---- Inputs ----
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const cursor = (req.query.cursor ?? "").toString();

    // Auth header (optional)
    const incomingKey = req.headers["x-adapter-key"];
    if (process.env.ADAPTER_KEY && incomingKey !== process.env.ADAPTER_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Base help center used as fallback
    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io").replace(/\/+$/, "");

    // Build absolute base URL for this adapter using request headers (so we return full URLs)
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const adapterBase = host ? `${proto}://${host}` : (process.env.ADAPTER_BASE_URL ?? null);
    // If ADAPTER_BASE_URL env var is set (optional), use it as a fallback.
    const ADAPTER_BASE = adapterBase ?? process.env.ADAPTER_BASE_URL ?? null;
    if (!ADAPTER_BASE) {
      // We still proceed, but next/previous will be null to avoid malformed URLs.
      console.warn("Adapter base URL not detected; you may want to set ADAPTER_BASE_URL env var.");
    }

    const headers = {
      Authorization: `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Helper: determine if an article is archived (robust - checks several common fields)
    const isArchived = (articleObj) => {
      if (!articleObj || typeof articleObj !== "object") return false;
      const lowerKeys = (obj, k) => obj && obj[k];
      // Common fields across tenants:
      if (articleObj.is_archived === true) return true;
      if (articleObj.archived === true) return true;
      if (articleObj.status && String(articleObj.status).toLowerCase() === "archived") return true;
      // sync_metadata or sync unit flags (some tenants embed archive info here)
      if (articleObj.sync_metadata?.is_archived === true) return true;
      if (articleObj.sync_metadata?.last_sync_in?.sync_unit?.is_archived === true) return true;
      // resource-level archived flag
      if (articleObj.resource?.is_archived === true) return true;
      return false;
    };

    // ---- 1) Fetch page of results that we'll return ----
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

    // ---- 2) Compute total matches for this query (cursor-walk) but ONLY count non-archived items ----
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

      // Sum only non-archived results
      const pageCount = Array.isArray(j.results)
        ? j.results.reduce((acc, item) => {
            const articleObj = item?.article ?? item;
            return acc + (isArchived(articleObj) ? 0 : 1);
          }, 0)
        : 0;

      total += pageCount;

      if (!j.next_cursor) break;
      nextCursor = j.next_cursor;
      loops += 1;
    }

    // ---- 3) Map and FILTER results for the page we return (exclude archived items) ----
    const mappedResults = (pageJson.results ?? [])
      .map((hit) => {
        const article = hit?.article ?? {};
        if (isArchived(article)) return null; // filter out archived

        const title = article.title ?? article.display_name ?? article.name ?? "Help Center Article";

        // Use sync_metadata.external_reference if present (per sample)
        const externalRef = article?.sync_metadata?.external_reference ?? null;

        // Accept customer-facing URL only if it starts with HELP_BASE (avoid other-brand links).
        const url = typeof externalRef === "string" && externalRef.startsWith(HELP_BASE) ? externalRef : HELP_BASE;

        return { title, url };
      })
      .filter(Boolean);

    // ---- 4) Build absolute next/previous URLs that Vanilla can call ----
    const makePagerUrl = (cursorToken, nextPageNumber) => {
      if (!cursorToken || !ADAPTER_BASE) return null;
      // include q, perPage, page (so adapter can return currentPage if called directly)
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("perPage", String(perPage));
      params.set("page", String(nextPageNumber ?? page + 1));
      params.set("cursor", cursorToken);
      return `${ADAPTER_BASE.replace(/\/+$/, "")}/api/search?${params.toString()}`;
    };

    const nextUrl = pageJson.next_cursor ? makePagerUrl(pageJson.next_cursor, page + 1) : null;
    const prevUrl = pageJson.prev_cursor ? makePagerUrl(pageJson.prev_cursor, Math.max(1, page - 1)) : null;

    // ---- 5) Return Vanilla-style response ----
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
