export default async function handler(req, res) {
  try {
    // ---- Inputs from Vanilla ----
    const q = (req.query.q ?? req.query.query ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);

    // Vanilla may send a numeric page. We return it back as currentPage.
    // If Vanilla doesn't send it, we default to 1 (still numeric).
    const page = Math.max(1, Number(req.query.page ?? 1));

    // Cursor-based paging support (optional param from Vanilla)
    const cursor = (req.query.cursor ?? "").toString();

    // Optional protection: Vanilla must send this header if you set ADAPTER_KEY in Vercel
    const incomingKey = req.headers["x-adapter-key"];
    if (process.env.ADAPTER_KEY && incomingKey !== process.env.ADAPTER_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const HELP_BASE = (process.env.HELP_CENTER_BASE_URL ?? "https://help.responsive.io").replace(/\/+$/, "");

    // ---- DevRev auth/header ----
    const headers = {
      Authorization: `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json",
    };

    // ---- 1) Fetch the page of results we will RETURN to Vanilla ----
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

    // ---- 2) Compute COUNT of matches for THIS QUERY (cursor-walk) ----
    // Because search.core doesn't return a total-match count, we iterate using next_cursor.
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

    // ---- 3) Map DevRev hits -> Vanilla results ----
    // Excerpt is NOT required, so we omit it.
    // URL should use external_reference (customer-facing URL), fallback to help.responsive.io.
    const mappedResults = (pageJson.results ?? []).map((hit) => {
      const article = hit.article ?? hit;

      const title =
        article.title ??
        article.display_name ??
        article.name ??
        "Help Center Article";

      const url =
        hit.external_reference ??
        article.external_reference ??
        HELP_BASE;

      return { title, url };
    });

    // ---- 4) Return Vanilla-style response including current page number ----
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
