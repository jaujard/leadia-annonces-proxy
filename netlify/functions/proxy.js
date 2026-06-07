/**
 * Proxy « annonces » — Netlify Function
 * Reçoit /api/* (via redirect netlify.toml) → relaie vers cherchertrouver.immo
 * en ajoutant la clé (secret CT_API_KEY). CORS inclus. Clé jamais exposée au navigateur.
 * Route /db/annonces : lecture seule de la table Supabase leadia_annonces (clé Supabase serveur).
 * Route /db/carreau : lecture seule de la table Supabase leadia_carreau (Insee carreaux 200m).
 * Route /insee : relais API INSEE Mélodi (population/logement/revenus), anonyme ou Bearer INSEE_TOKEN.
 * Route /sat : relais image satellite/plan Mapbox Static (token MAPBOX_TOKEN serveur, jamais exposé).
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

  // --- Relais satellite/plan Mapbox Static : /api/sat?bbox=minLon,minLat,maxLon,maxLat&w=&h=&style= ---
  if (path === "sat") {
    const TK = process.env.MAPBOX_TOKEN;
    if (!TK) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "MAPBOX_TOKEN non configurée", code: "SAT_NO_KEY" }) };
    const p = event.queryStringParameters || {};
    const bbox = p.bbox || "";
    const w = Math.min(1280, Math.max(1, parseInt(p.w, 10) || 600));
    const h = Math.min(1280, Math.max(1, parseInt(p.h, 10) || 400));
    const style = /^[a-z0-9-]+$/i.test(p.style || "") ? p.style : "satellite-v9";
    if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "bbox invalide", code: "SAT_BAD_BBOX" }) };
    const url = "https://api.mapbox.com/styles/v1/mapbox/" + style + "/static/[" + bbox + "]/" + w + "x" + h + "@2x?access_token=" + encodeURIComponent(TK) + "&attribution=false&logo=false&padding=0";
    try {
      const ri = await fetch(url, { headers: { "Accept": "image/*,*/*" } });
      if (!ri.ok) return { statusCode: ri.status, headers: cors, body: JSON.stringify({ error: "Mapbox " + ri.status, code: "SAT_UPSTREAM" }) };
      const ct = ri.headers.get("content-type") || "image/png";
      const buf = Buffer.from(await ri.arrayBuffer());
      return { statusCode: 200, headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=86400, s-maxage=86400" }, body: buf.toString("base64"), isBase64Encoded: true };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Mapbox injoignable", code: "SAT_FETCH" }) };
    }
  }

  // --- Lecture Supabase : /api/db/annonces?<filtres PostgREST> (table verrouillée, GET only) ---
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

  // --- Lecture Supabase : /api/db/carreau?<filtres PostgREST> (carreaux INSEE 200m, GET only) ---
  if (path === "db/carreau") {
    const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_KEY;
    if (!SB_URL || !SB_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "SUPABASE_URL / SUPABASE_KEY non configurées", code: "DB_NO_KEY" }) };
    try {
      const r = await fetch(SB_URL.replace(/\/$/, "") + "/rest/v1/leadia_carreau" + qs, {
        headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Accept: "application/json" }
      });
      const body = await r.text();
      return { statusCode: r.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400, s-maxage=86400" }, body };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Supabase injoignable", code: "DB_UPSTREAM" }) };
    }
  }

  // --- Relais INSEE Mélodi : /api/insee/<chemin melodi>?<query> ---
  if (path === "insee" || path.startsWith("insee/")) {
    const sub = path.replace(/^insee\/?/, "");
    if (!sub) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Chemin Mélodi manquant", code: "INSEE_NO_PATH" }) };
    const url = "https://api.insee.fr/melodi/" + sub + qs;
    const h = { "Accept": "application/json" };
    if (process.env.INSEE_TOKEN) h["Authorization"] = "Bearer " + process.env.INSEE_TOKEN;
    try {
      const r = await fetch(url, { headers: h });
      const body = await r.text();
      return { statusCode: r.status, headers: { ...cors, "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "public, max-age=86400, s-maxage=86400" }, body };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "INSEE injoignable", code: "INSEE_UPSTREAM" }) };
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
