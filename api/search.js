export default async function handler(req, res) {
  try {
    // ---- Inputs from Vanilla ----
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const cursor = (req.query.cursor ?? "").toString();

    // Optional protection: require x-adapter-key header if ADAPTER_KEY is set
    const incomingKey = req.headers["x-adapter-key"];
    if (process.env.ADAPTER_KEY && incomingKey !== process.env.ADAPTER_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io")
      .replace(/\/+$/, "");

    const headers = {
      Authorization: `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json",
    };

    // ---- 1) Fetch page of results from DevRev search.core ----
    const pageBody = {
      query: q,
      namespaces: ["article"],
      limit: perPage,
      mode: "after",
    };
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

    // ---- 2) Compute total matches for this query (cursor-walk) ----
    // search.core doesn't provide total count, so we walk next_cursor and sum results.length.
    const MAX_PAGES_TO_COUNT = Number(process.env.MAX_PAGES_TO_COUNT ?? 50);
    const COUNT_PAGE_SIZE = Math.min(Number(process.env.COUNT_PAGE_SIZE ?? 50), 100);

    let total = 0;
    let nextCursor = "";
    let loops = 0;

    while (loops < MAX_PAGES_TO_COUNT) {
      const countBody = {
        query: q,
        namespaces: ["article"],
        limit: COUNT_PAGE_SIZE,
        mode: "after",
      };
      if (nextCursor) countBody.cursor = nextCursor;

      const r = await fetch("https://api.devrev.ai/search.core", {
        method: "POST",
        headers,
        body: JSON.stringify(countBody),
      });

      if (!r.ok) break;
      const j = await r.json();

      total += Array.isArray(j.results) ? j.results.length : 0;

      if (!j.next_cursor) break;
      nextCursor = j.next_cursor;
      loops += 1;
    }

    // ---- 3) Map results to Vanilla format ----
    // URL is in article.sync_metadata.external_reference (per your sample response).
    const mappedResults = (pageJson.results ?? []).map((hit) => {
      const article = hit?.article ?? {};

      const title = article.title ?? "Help Center Article";

      const externalRef = article?.sync_metadata?.external_reference ?? null;

      // Only return customer-facing Responsive help center URLs; otherwise fall back.
      const url =
        typeof externalRef === "string" && externalRef.startsWith(HELP_BASE)
          ? externalRef
          : HELP_BASE;

      return { title, url };
    });

    // ---- 4) Return response to Vanilla including numeric currentPage ----
    return res.status(200).json({
      results: {
        count: Number.isFinite(total) ? total : 0,
        currentPage: page,
        perPage,
        next: pageJson.next_cursor ?? null,
        previous: pageJson.prev_cursor ?? null,
        results: mappedResults,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
