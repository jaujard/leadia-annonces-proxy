/**
 * Proxy « annonces » — Netlify Function
 * Reçoit /api/*  (via redirect netlify.toml) → relaie vers cherchertrouver.immo
 * en ajoutant la clé (secret CT_API_KEY). CORS inclus. Clé jamais exposée au navigateur.
 * Route /db/annonces : lecture seule de la table Supabase leadia_annonces (clé Supabase serveur).
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
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Méthode non autorisée", code: "METHOD_NOT_ALLOWED" }) };

  const path = ((event.path || "").replace(/^.*\/api\//, "").split("?")[0].replace(/\/+$/, "")) || "ping";
  const qs = event.rawQuery ? "?" + event.rawQuery : "";

  // --- Relais image : /api/img?u=<url> ---
  // Fetch côté serveur SANS Referer navigateur -> contourne l'anti-hotlink
  // (bienici/seloger renvoient un placeholder noir sinon). Cache edge 24h.
  if (path === "img") {
    const u = (event.queryStringParameters && event.queryStringParameters.u) || "";
    if (!/^https?:\/\//i.test(u)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Paramètre u invalide", code: "IMG_BAD_URL" }) };
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

  // --- Lecture Supabase : /api/db/annonces?<filtres PostgREST> ---
  // Relaie une requête LECTURE SEULE vers PostgREST (table verrouillée leadia_annonces).
  // La clé Supabase reste côté serveur (secret SUPABASE_KEY). GET uniquement (déjà imposé).
  if (path === "db/annonces") {
    const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_KEY;
    if (!SB_URL || !SB_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "SUPABASE_URL / SUPABASE_KEY non configurées", code: "DB_NO_KEY" }) };
    try {
      const r = await fetch(SB_URL.replace(/\/$/, "") + "/rest/v1/leadia_annonces" + qs, {
        headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Accept: "application/json", Prefer: "count=planned" }
      });
      const body = await r.text();
      const cr = r.headers.get("content-range");
      return { statusCode: r.status, headers: { ...cors, "Content-Type": "application/json", "Access-Control-Expose-Headers": "Content-Range", ...(cr ? { "Content-Range": cr } : {}) }, body };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Supabase injoignable", code: "DB_UPSTREAM" }) };
    }
  }

  if (!ALLOWED.test(path)) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Endpoint non autorisé", code: "PROXY_FORBIDDEN" }) };
  if (!process.env.CT_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "CT_API_KEY non configurée", code: "PROXY_NO_KEY" }) };

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
