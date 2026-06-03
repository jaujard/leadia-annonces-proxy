/**
 * Proxy "annonces" - Netlify Function
 * Recoit /api/* (via redirect netlify.toml) -> relaie vers cherchertrouver.immo
 * en ajoutant la cle (secret CT_API_KEY). CORS inclus. Cle jamais exposee au navigateur.
 */
const API_BASE = "https://cherchertrouver.immo/api/v1";
const ALLOWED = /^(ping|annonces|annonces\/map|annonces\/[^/]+\/[^/]+|ptz\/zone)$/;

exports.handler = async (event) => {
    const origin = process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN.length ? process.env.ALLOWED_ORIGIN : "*";
    const cors = {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Cache-Control": "no-store"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };
    if (event.httpMethod !== "GET") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Methode non autorisee", code: "METHOD_NOT_ALLOWED" }) };

    const path = ((event.path || "").replace(/^.*\/api\//, "").split("?")[0].replace(/\/+$/, "")) || "ping";
    const qs = event.rawQuery ? "?" + event.rawQuery : "";

    // --- Relais image : /api/img?u=<url> ---
    // Fetch cote serveur SANS Referer navigateur -> contourne l'anti-hotlink
    // (bienici/seloger renvoient un placeholder noir sinon). Cache edge 24h.
    if (path === "img") {
          const u = (event.queryStringParameters && event.queryStringParameters.u) || "";
          if (!/^https?:\/\//i.test(u)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Parametre u invalide", code: "IMG_BAD_URL" }) };
          try {
                  const ri = await fetch(u, { headers: { "Accept": "image/*,*/*", "User-Agent": "Mozilla/5.0 (compatible; LeadiaProxy/1.0)" } });
                  if (!ri.ok) return { statusCode: ri.status, headers: cors, body: JSON.stringify({ error: "Image " + ri.status, code: "IMG_UPSTREAM" }) };
                  const ct = ri.headers.get("content-type") || "image/jpeg";
                  const buf = Buffer.from(await ri.arrayBuffer());
                  return { statusCode: 200, headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=86400, s-maxage=86400" }, body: buf.toString("base64"), isBase64Encoded: true };
          } catch (e) {
                  return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Image injoignable", code: "IMG_FETCH" }) };
          }
    }

    if (!ALLOWED.test(path)) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Endpoint non autorise", code: "PROXY_FORBIDDEN" }) };
    if (!process.env.CT_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "CT_API_KEY non configuree", code: "PROXY_NO_KEY" }) };

    try {
          const r = await fetch(API_BASE + "/" + path + qs, { headers: { "X-Api-Key": process.env.CT_API_KEY, "Accept": "application/json" } });
          const body = await r.text();
          const extra = {};
          ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-Quota-Items-Limit", "X-Quota-Items-Used"].forEach(h => { const v = r.headers.get(h); if (v) extra[h] = v; });
          return { statusCode: r.status, headers: { ...cors, ...extra, "Content-Type": r.headers.get("content-type") || "application/json" }, body };
    } catch (e) {
          return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Upstream injoignable", code: "PROXY_UPSTREAM" }) };
    }
};
