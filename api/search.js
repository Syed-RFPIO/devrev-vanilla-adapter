// search.js - supports header OR query param adapter_key; adds CORS; appends adapter_key to pager URLs
export default async function handler(req, res) {
  try {
    // --- CORS: respond to preflight immediately and add headers on all responses ---
    const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*"; // tighten later to your community origin
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,x-adapter-key",
      "Access-Control-Max-Age": "600",
    };
    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      return res.status(204).set(corsHeaders).send("");
    }

    // Set CORS headers for the response (will be merged into the result)
    // We'll apply them at the end via res.set
    // --- Inputs ---
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const cursor = (req.query.cursor ?? "").toString();

    // --- Adapter auth: accept header OR query param ---
    const incomingHeaderKey = req.headers["x-adapter-key"];
    const incomingQueryKey = (req.query.adapter_key ?? "").toString();
    const configuredKey = process.env.ADAPTER_KEY ?? "";

    // If ADAPTER_KEY is set, require either header or query param to match
    if (configuredKey) {
      if (!(incomingHeaderKey === configuredKey || incomingQueryKey === configuredKey)) {
        res.set(corsHeaders);
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io").replace(/\/+$/, "");

    // adapter base detection or fallback to env var
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

    // 1) fetch page
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
      return res.status(pageResp.status).send(txt);
    }
    const pageJson = await pageResp.json();

    // 2) count only items with responsive external_reference
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

    // 3) map + filter page results
    const mappedResults = (pageJson.results ?? [])
      .map((hit) => {
        const article = hit?.article ?? {};
        if (!hasResponsiveExternalRef(article)) return null;
        const title = article.title ?? article.display_name ?? article.name ?? "Help Center Article";
        const url = article.sync_metadata.external_reference;
        return { title, url };
      })
      .filter(Boolean);

    // 4) build next/prev full urls and append adapter_key if configured (so Vanilla front-end can call them)
    const makePagerUrl = (cursorToken, nextPageNumber) => {
      if (!cursorToken || !ADAPTER_BASE) return null;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("perPage", String(perPage));
      params.set("page", String(nextPageNumber ?? page + 1));
      params.set("cursor", cursorToken);
      // append adapter_key to the query string if configured so vanilla front-end calls will be authorized
      if (configuredKey) params.set("adapter_key", configuredKey);
      return `${ADAPTER_BASE.replace(/\/+$/, "")}/api/search?${params.toString()}`;
    };

    const nextUrl = pageJson.next_cursor ? makePagerUrl(pageJson.next_cursor, page + 1) : null;
    const prevUrl = pageJson.prev_cursor ? makePagerUrl(pageJson.prev_cursor, Math.max(1, page - 1)) : null;

    // 5) return response with CORS headers
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
  } catch (e) {
    // ensure CORS headers even on error
    const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
    res.set({
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,x-adapter-key",
    });
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
