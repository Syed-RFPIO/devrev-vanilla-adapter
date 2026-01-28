// debug-search-fixed.js - temporary: returns error.stack when you call ?debug=1
export default async function handler(req, res) {
  // Basic CORS preflight handling
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-adapter-key",
    "Access-Control-Max-Age": "600",
  };
  if (req.method === "OPTIONS") {
    return res.status(204).set(corsHeaders).send("");
  }

  const debugMode = (req.query.debug ?? "").toString() === "1";

  try {
    // --- Inputs ---
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const cursor = (req.query.cursor ?? "").toString();

    // adapter auth: we accept header OR query param
    const incomingHeaderKey = req.headers["x-adapter-key"];
    const incomingQueryKey = (req.query.adapter_key ?? "").toString();
    // <-- FIX: define configuredKey so makePagerUrl can reference it safely
    const configuredKey = process.env.ADAPTER_KEY ?? "";

    if (configuredKey) {
      if (!(incomingHeaderKey === configuredKey || incomingQueryKey === configuredKey)) {
        res.set(corsHeaders);
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io").replace(/\/+$/, "");

    // ADAPTER_BASE detection w/ safe fallback
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const ADAPTER_BASE = (host ? `${proto}://${host}` : (process.env.ADAPTER_BASE_URL ?? null)) ?? null;

    const headers = {
      Authorization: `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json",
    };

    // helper: only include articles that have a responsive external_reference
    const hasResponsiveExternalRef = (articleObj) => {
      const ext = articleObj?.sync_metadata?.external_reference;
      return typeof ext === "string" && ext.startsWith(HELP_BASE);
    };

    // --- Fetch page from DevRev ---
    const pageBody = { query: q, namespaces: ["article"], limit: perPage, mode: "after" };
    if (cursor) pageBody.cursor = cursor;

    const pageResp = await fetch("https://api.devrev.ai/search.core", {
      method: "POST",
      headers,
      body: JSON.stringify(pageBody),
    });

    if (!pageResp.ok) {
      const txt = await pageResp.text();
      res.set(corsHeaders);
      if (debugMode) {
        return res.status(pageResp.status).json({ error: "DevRev error", status: pageResp.status, body: txt });
      }
      return res.status(pageResp.status).send(txt);
    }

    const pageJson = await pageResp.json();

    // --- Count only responsive external_reference results (cursor-walk) ---
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

    // --- Map and filter page results ---
    const mappedResults = (pageJson.results ?? [])
      .map((hit) => {
        const article = hit?.article ?? {};
        if (!hasResponsiveExternalRef(article)) return null;
        const title = article.title ?? article.display_name ?? article.name ?? "Help Center Article";
        const url = article.sync_metadata.external_reference;
        return { title, url };
      })
      .filter(Boolean);

    // --- Build next/previous full URLs w/ adapter_key if configured ---
    const makePagerUrl = (cursorToken, nextPageNumber) => {
      if (!cursorToken || !ADAPTER_BASE) return null;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("perPage", String(perPage));
      params.set("page", String(nextPageNumber ?? page + 1));
      params.set("cursor", cursorToken);
      if (configuredKey) params.set("adapter_key", configuredKey);
      return `${ADAPTER_BASE.replace(/\/+$/, "")}/api/search?${params.toString()}`;
    };

    const nextUrl = pageJson.next_cursor ? makePagerUrl(pageJson.next_cursor, page + 1) : null;
    const prevUrl = pageJson.prev_cursor ? makePagerUrl(pageJson.prev_cursor, Math.max(1, page - 1)) : null;

    res.set(corsHeaders);
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
  } catch (err) {
    // ensure CORS headers even on error
    const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
    const errCors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,x-adapter-key",
    };
    res.set(errCors);
    if (debugMode) {
      return res.status(500).json({ error: String(err?.message ?? "Server error"), stack: err?.stack ?? null });
    } else {
      return res.status(500).json({ error: "Server error" });
    }
  }
}
