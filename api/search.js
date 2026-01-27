export default async function handler(req, res) {
  try {
    // ---- Inputs coming from Vanilla ----
    const q = (req.query.q ?? "").toString();
    const perPage = Math.min(Number(req.query.perPage ?? 10), 50);
    const cursor = (req.query.cursor ?? "").toString();

    // Optional simple protection: require a shared header
    const incomingKey = req.headers["x-adapter-key"];
    if (process.env.ADAPTER_KEY && incomingKey !== process.env.ADAPTER_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ---- DevRev auth/header ----
    const headers = {
      "Authorization": `Bearer ${process.env.DEVREV_TOKEN}`,
      "Content-Type": "application/json"
    };

    // ---- 1) Get the page of results we will return (search.core) ----
    // DevRev search.core supports query, namespaces, limit, cursor, mode. :contentReference[oaicite:5]{index=5}
    const pageBody = {
      query: q,
      namespaces: ["article"],
      limit: perPage,
      mode: "after"
    };
    if (cursor) pageBody.cursor = cursor;

    const pageResp = await fetch("https://api.devrev.ai/search.core", {
      method: "POST",
      headers,
      body: JSON.stringify(pageBody)
    });

    if (!pageResp.ok) {
      const txt = await pageResp.text();
      return res.status(pageResp.status).send(txt);
    }

    const pageJson = await pageResp.json();

    // ---- 2) Compute COUNT of matches for THIS QUERY (cursor-walk) ----
    // Because search.core doesn’t give total matches, we iterate using next_cursor. :contentReference[oaicite:6]{index=6}
    // To keep it safe, we cap the maximum pages we’ll count.
    const MAX_PAGES_TO_COUNT = Number(process.env.MAX_PAGES_TO_COUNT ?? 50);
    const COUNT_PAGE_SIZE = Math.min(Number(process.env.COUNT_PAGE_SIZE ?? 50), 100);

    let total = 0;
    let nextCursor = ""; // start from beginning
    let pages = 0;

    while (pages < MAX_PAGES_TO_COUNT) {
      const countBody = {
        query: q,
        namespaces: ["article"],
        limit: COUNT_PAGE_SIZE,
        mode: "after"
      };
      if (nextCursor) countBody.cursor = nextCursor;

      const r = await fetch("https://api.devrev.ai/search.core", {
        method: "POST",
        headers,
        body: JSON.stringify(countBody)
      });

      if (!r.ok) break; // fail “open” — still return page results
      const j = await r.json();

      const batch = Array.isArray(j.results) ? j.results.length : 0;
      total += batch;

      // Stop if no more pages
      if (!j.next_cursor) break;

      nextCursor = j.next_cursor;
      pages += 1;

      // Safety: If API starts returning same cursor, avoid infinite loops
      if (pages > 1 && nextCursor === "") break;
    }

    // ---- 3) Map DevRev hits -> Vanilla result items ----
    const mappedResults = (pageJson.results ?? []).map((hit) => {
      // DevRev hits often include snippet. :contentReference[oaicite:7]{index=7}
      const excerpt = hit.snippet ?? "";

      // Title and ID location can vary; common patterns are hit.article.* or hit.*.
      const article = hit.article ?? hit;
      const title = article.title ?? article.display_name ?? article.name ?? "Article";

      const id = article.id ?? article.article?.id;

      // NOTE: replace with your tenant’s correct article URL pattern if different.
      const url = id ? `https://app.devrev.ai/app/articles/${id}` : "https://app.devrev.ai/";

      return { title, url, excerpt };
    });

    // ---- 4) Vanilla-style response ----
    return res.status(200).json({
      results: {
        count: Number.isFinite(total) ? total : 0,
        next: pageJson.next_cursor ?? null,
        previous: pageJson.prev_cursor ?? null,
        results: mappedResults
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
