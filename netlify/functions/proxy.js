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
