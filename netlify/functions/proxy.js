const API_BASE = "https://cherchertrouver.immo/api/v1";
const ALLOWED = /^(ping|annonces|annonces\/map|annonces\/[^/]+\/[^/]+|ptz\/zone|img)$/;

exports.handler = async (event) => {
  const origin = process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN.length ? process.env.ALLOWED_ORIGIN : "*";
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Methode non autorisee" }) };

  const path = ((event.path || "").replace(/^.*\/api\//, "").split("?")[0].replace(/\/+$/, "")) || "ping";
  if (!ALLOWED.test(path)) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Endpoint non autorise" }) };

  if (path === "img") {
    const u = (event.queryStringParameters && event.queryStringParameters.u) || "";
    if (!/^https?:\/\//.test(u)) return { statusCode: 400, headers: cors, body: "bad url" };
    try {
      const ref = new URL(u).origin + "/";
      const ir = await fetch(u, { headers: { "Referer": ref, "User-Agent": "Mozilla/5.0" } });
      const ct = ir.headers.get("content-type") || "image/jpeg";
      if (!/^image\//.test(ct)) return { statusCode: 415, headers: cors, body: "not an image" };
      const buf = Buffer.from(await ir.arrayBuffer());
      return { statusCode: ir.status, headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=86400" }, body: buf.toString("base64"), isBase64Encoded: true };
    } catch (e) { return { statusCode: 502, headers: cors, body: "img error" }; }
  }

  if (!process.env.CT_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "CT_API_KEY non configuree" }) };
  const qs = event.rawQuery ? "?" + event.rawQuery : "";
  try {
    const r = await fetch(API_BASE + "/" + path + qs, { headers: { "X-Api-Key": process.env.CT_API_KEY, "Accept": "application/json" } });
    const body = await r.text();
    return { statusCode: r.status, headers: { ...cors, "Content-Type": r.headers.get("content-type") || "application/json" }, body };
  } catch (e) { return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Upstream injoignable" }) }; }
};
