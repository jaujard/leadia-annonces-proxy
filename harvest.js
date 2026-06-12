#!/usr/bin/env node
/**
 * Harvester d'annonces cherchertrouver.immo -> Supabase (« Cadastre par Leadia »)
 * Aspiration EXHAUSTIVE : subdivision recursive par tranche de prix pour contourner
 * le plafond de pagination de l'API. Cles uniquement en variables d'environnement.
 * ENV : CT_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (requis sauf DRY_RUN)
 * Options : MODE, TRANSACTIONS, DEPARTMENTS, SORT, MAX_PAGES, UPSERT_CHUNK, KEEP_RAW,
 * SPLIT_AT, MIN_BAND, MAX_DEPTH, MIN_DELAY_MS, INCR_GRACE, INCR_BOOTSTRAP_DAYS, DRY_RUN
 *
 * ROUTAGE API (MAJ 11 juin 2026) : appel via le PROXY Netlify par defaut, AVEC REPLI AUTO
 * sur l'API DIRECTE cherchertrouver.immo si le proxy est injoignable (le runner GitHub ne
 * pouvait plus joindre le proxy Netlify -> 0 upsert silencieux depuis ~7 juin). En direct,
 * la cle CT_API_KEY doit etre une cle premium valide (le proxy, lui, l'ignorait).
 * FAIL-LOUD : si AUCUNE requete API n'aboutit (reqCount==0), le job sort en erreur (rouge)
 * au lieu de "reussir" a vide.
 */

// PROXY Netlify par defaut (cle premium cote serveur). Repli DIRECT auto si injoignable.
const API_BASE = process.env.CT_API_BASE || "https://leadia-annonces-proxy.netlify.app/api";
const DIRECT_BASE = process.env.CT_DIRECT_BASE || "https://cherchertrouver.immo/api/v1";
const API_KEY = process.env.CT_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const TBL_PREFIX = process.env.SB_TABLE_PREFIX != null ? process.env.SB_TABLE_PREFIX : "leadia_";
const T_ANNONCES = TBL_PREFIX + "annonces";
const T_STATE = TBL_PREFIX + "harvest_state";
const T_RUNS = TBL_PREFIX + "harvest_runs";

const PAGE_SIZE = 48;
const PAGE_CAP = 50; // plafond DUR de l'API : page <= 50 (sinon HTTP 400)
const MAX_PAGES = Math.min(int0(process.env.MAX_PAGES, 50), PAGE_CAP);
const MIN_DELAY_MS = int0(process.env.MIN_DELAY_MS, 120);
const INCR_GRACE = int0(process.env.INCR_GRACE, 2);
// Au 1er passage incremental (pas encore de watermark updated_at en base), on ne refait
// PAS une passe complete (couteuse) : on borne a now - N jours. La base etant deja
// exhaustive, ce filet rattrape juste l'ecart depuis la derniere passe complete.
const INCR_BOOTSTRAP_DAYS = int0(process.env.INCR_BOOTSTRAP_DAYS, 3);
const UPSERT_CHUNK = Math.max(1, int0(process.env.UPSERT_CHUNK, 50));
const KEEP_RAW = process.env.KEEP_RAW === "1";
const SPLIT_AT = int0(process.env.SPLIT_AT, 2000); // filet de securite : subdivise si on s'approche du plafond (cap=50*48=2400)
const MIN_BAND = int0(process.env.MIN_BAND, 2000); // largeur min d'une tranche de prix
const MAX_DEPTH = int0(process.env.MAX_DEPTH, 22); // profondeur max de bisection
const DRY_RUN = process.env.DRY_RUN === "1";
const SORT = process.env.SORT || "";
let MODE = (process.env.MODE || "auto").toLowerCase();
const TRANSACTIONS = (process.env.TRANSACTIONS || "vente,location")
  .split(",").map(s => s.trim()).filter(Boolean);

const DEPARTMENTS = (process.env.DEPARTMENTS || "").trim()
  ? process.env.DEPARTMENTS.split(",").map(s => s.trim()).filter(Boolean)
  : buildDepartments();

const VENTE_BANDS = [0,50000,80000,110000,140000,170000,200000,240000,290000,
  350000,430000,550000,750000,1100000,2000000,5000000,null];
const LOC_BANDS = [0,400,550,700,850,1000,1200,1500,2000,3000,5000,null];

if (!API_KEY) { console.error("CT_API_KEY manquante."); process.exit(1); }
if (!DRY_RUN && (!SB_URL || !SB_KEY)) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY manquantes (ou DRY_RUN=1).");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function int0(v, d) { const n = parseInt(v, 10); return isNaN(n) ? d : n; }
const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
const int = v => { const n = num(v); return n == null ? null : Math.round(n); };
const int4 = v => { const n = int(v); return (n == null || n > 2147483647 || n < -2147483648) ? null : n; };
function buildDepartments() {
  const d = [];
  for (let i = 1; i <= 95; i++) { if (i === 20) continue; d.push(String(i).padStart(2, "0")); }
  d.push("2A", "2B");
  ["971","972","973","974","976"].forEach(x => d.push(x));
  return d;
}
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

let reqCount = 0, itemCount = 0, upsertCount = 0, quotaRemaining = null;
let apiBase = API_BASE;          // bascule auto vers DIRECT_BASE si le proxy est injoignable
let switchedToDirect = false;
const maxPub = {};
const maxUpd = {};

async function apiGet(params) {
  const q = new URLSearchParams(params).toString();
  // pass 0 = base courante (proxy puis direct si deja bascule) ; si tout throw sur le proxy,
  // on bascule sur l'API directe et on re-tente (pass 1).
  for (let pass = 0; pass < 2; pass++) {
    const url = apiBase + "/annonces?" + q;
    let threwEvery = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      let r;
      try {
        r = await fetch(url, { headers: { "X-Api-Key": API_KEY, "Accept": "application/json" } });
      } catch (e) { await sleep(1000 * (attempt + 1)); continue; }
      threwEvery = false;
      reqCount++;
      const rem = r.headers.get("X-RateLimit-Remaining");
      if (rem != null) quotaRemaining = rem;
      if (r.status === 429) { const ra = int0(r.headers.get("Retry-After"), 5); await sleep((ra || 5) * 1000); continue; }
      if (r.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("API " + r.status + " " + t.slice(0, 200)); }
      return r.json();
    }
    // tous les essais ont throw (connexion impossible) sur cette base
    if (threwEvery && !switchedToDirect && apiBase !== DIRECT_BASE) {
      apiBase = DIRECT_BASE; switchedToDirect = true;
      log("Proxy injoignable (connexion) -> bascule sur l'API directe " + DIRECT_BASE);
      continue; // re-tente immediatement en direct
    }
    break;
  }
  throw new Error("API : echec apres retries (base=" + apiBase + ")");
}

async function sbFetch(path, opts = {}) {
  const url = SB_URL.replace(/\/$/, "") + path;
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        ...opts,
        headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, ...(opts.headers || {}) }
      });
    } catch (e) {
      lastErr = (e && e.message ? e.message : String(e)) + (e && e.cause ? " / cause: " + (e.cause.message || e.cause) : "");
      await sleep(800 * (attempt + 1)); continue;
    }
    if (r.status >= 500 || r.status === 429) { lastErr = "HTTP " + r.status; await sleep(800 * (attempt + 1)); continue; }
    return r;
  }
  throw new Error("Supabase : injoignable apres retries (" + lastErr + ")");
}

async function warmupDb() {
  if (DRY_RUN) return;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await sbFetch("/rest/v1/" + T_ANNONCES + "?select=source&limit=1");
      if (r.status < 500) { log("Supabase pret (warmup, HTTP " + r.status + ")"); return; }
    } catch (e) { log("  warmup Supabase... " + e.message); }
    await sleep(3000);
  }
  log("Supabase warmup sans reponse claire — on continue.");
}

async function upsert(rows) {
  if (DRY_RUN || !rows.length) return;
  const seen = new Map();
  for (const r of rows) seen.set(r.source + " " + r.reference, r);
  rows = [...seen.values()];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const r = await sbFetch("/rest/v1/" + T_ANNONCES + "?on_conflict=source,reference", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk)
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Supabase upsert " + r.status + " " + t.slice(0, 300)); }
    upsertCount += chunk.length;
  }
}

async function sbCount() {
  if (DRY_RUN) return 0;
  const r = await sbFetch("/rest/v1/" + T_ANNONCES + "?select=source&limit=1", { headers: { Prefer: "count=exact", Range: "0-0" } });
  const cr = r.headers.get("content-range") || "";
  const total = cr.includes("/") ? parseInt(cr.split("/")[1], 10) : 0;
  return isNaN(total) ? 0 : total;
}
async function getState(key) {
  if (DRY_RUN) return null;
  const r = await sbFetch("/rest/v1/" + T_STATE + "?key=eq." + encodeURIComponent(key) + "&select=value");
  if (!r.ok) return null;
  const a = await r.json().catch(() => []);
  return (a && a[0]) ? a[0].value : null;
}
async function setState(key, value) {
  if (DRY_RUN) return;
  await sbFetch("/rest/v1/" + T_STATE + "?on_conflict=key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }])
  });
}
async function logRun(rec) {
  if (DRY_RUN) return;
  await sbFetch("/rest/v1/" + T_RUNS + "", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify([rec])
  }).catch(() => {});
}

function mapRow(a, transaction) {
  return {
    source: a.source || "inconnu",
    reference: String(a.reference != null ? a.reference : (a.id != null ? a.id : "")),
    transaction_type: a.transaction_type || transaction,
    type: a.type != null ? a.type : null,
    price: num(a.price),
    price_per_m2: num(a.price_per_m2),
    price_per_m2_color: a.price_per_m2_color != null ? a.price_per_m2_color : null,
    surface: num(a.surface),
    land_surface: num(a.land_surface),
    living_room_surface: num(a.living_room_surface),
    rooms: int4(a.rooms),
    bedrooms: int4(a.bedrooms),
    bathrooms: int4(a.bathrooms),
    toilets: int4(a.toilets),
    year_built: int4(a.year_built),
    elevator: a.elevator == null ? null : !!a.elevator,
    parking: a.parking == null ? null : !!a.parking,
    cellar: a.cellar == null ? null : !!a.cellar,
    garden: a.garden == null ? null : !!a.garden,
    seller_type: a.seller_type != null ? a.seller_type : null,
    seller_name: a.seller_name != null ? a.seller_name : null,
    real_estate_network: a.real_estate_network != null ? a.real_estate_network : null,
    exclusive: a.exclusive == null ? null : !!a.exclusive,
    city: a.city != null ? a.city : null,
    postal_code: a.postal_code != null ? a.postal_code : null,
    department: a.department != null ? a.department : null,
    region: a.region != null ? a.region : null,
    latitude: num(a.latitude),
    longitude: num(a.longitude),
    dpe: a.dpe != null ? a.dpe : null,
    ges: a.ges != null ? a.ges : null,
    images_count: int4(a.images_count) != null ? int4(a.images_count) : (Array.isArray(a.images) ? a.images.length : null),
    images: a.images || (a.image ? [a.image] : []),
    external_url: a.external_url != null ? a.external_url : null,
    title: a.title != null ? a.title : null,
    description: a.description != null ? a.description : null,
    is_internal: !!a.is_internal,
    published_at: a.published_at || null,
    last_seen_at: new Date().toISOString(),
    raw: KEEP_RAW ? a : null
  };
}
function trackPub(a, transaction) {
  if (!a.published_at) return;
  const t = Date.parse(a.published_at);
  if (isNaN(t)) return;
  if (!maxPub[transaction] || t > maxPub[transaction]) maxPub[transaction] = t;
}
// Suit le plus grand updated_at vu (fallback published_at) -> sert de watermark incremental.
function trackUpd(a, transaction) {
  const v = a.updated_at || a.published_at;
  if (!v) return;
  const t = Date.parse(v);
  if (isNaN(t)) return;
  if (!maxUpd[transaction] || t > maxUpd[transaction]) maxUpd[transaction] = t;
}
// Horodatage de reference d'une annonce pour l'arret anticipe (updated_at d'abord).
function rowTimeMs(a) {
  const v = a.updated_at || a.published_at;
  const t = v ? Date.parse(v) : NaN;
  return isNaN(t) ? 0 : t;
}

async function harvestCell(transaction, dept, band, watermarkMs) {
  const base = { transaction, dept, page_size: String(PAGE_SIZE) };
  if (band) {
    if (band[0] != null) base.prix_min = String(band[0]);
    if (band[1] != null) base.prix_max = String(band[1]);
  }
  if (SORT) base.sort = SORT;

  // L'API trie par updated_at DESC par defaut : l'arret anticipe est fiable tant qu'on
  // ne force pas un autre tri. Si SORT est defini, on desactive l'arret (ordre non garanti).
  const useIncr = !!watermarkMs && !SORT;
  let page = 1, got = 0, batch = [], oldPages = 0;

  while (page <= MAX_PAGES) {
    base.page = String(page);
    const j = await apiGet(base);
    const items = j.items || j.results || [];
    if (!items.length) break;

    let newestOnPage = 0;
    for (const a of items) {
      itemCount++; got++;
      trackPub(a, transaction);
      trackUpd(a, transaction);
      const t = rowTimeMs(a);
      if (t > newestOnPage) newestOnPage = t;
      batch.push(mapRow(a, transaction));
    }
    if (batch.length >= UPSERT_CHUNK) { await upsert(batch); batch = []; }

    if (useIncr) {
      if (newestOnPage && newestOnPage <= watermarkMs) { oldPages++; if (oldPages > INCR_GRACE) break; }
      else oldPages = 0;
    }

    const hasMore = (j.has_more != null) ? !!j.has_more : (items.length >= PAGE_SIZE);
    if (!hasMore) break;
    page++;
    if (MIN_DELAY_MS) await sleep(MIN_DELAY_MS);
  }
  if (batch.length) await upsert(batch);
  return { got, capped: page > MAX_PAGES };
}

// Subdivision RECURSIVE par tranche de prix : l'API plafonne la pagination profonde,
// donc une tranche "pleine" (capped, ou >= SPLIT_AT) est probablement tronquee => on la coupe en deux.
async function harvestRange(transaction, dept, min, max, watermarkMs, depth) {
  const r = await harvestCell(transaction, dept, [min, max], watermarkMs);
  const full = r.capped || r.got >= SPLIT_AT; // capped = page 50 atteinte avec suite => tranche tronquee
  if (full && (max - min) > MIN_BAND && depth < MAX_DEPTH) {
    const mid = Math.floor((min + max) / 2);
    if (mid > min && mid < max) {
      await harvestRange(transaction, dept, min, mid, watermarkMs, depth + 1);
      await harvestRange(transaction, dept, mid + 1, max, watermarkMs, depth + 1);
      return;
    }
  }
  if (r.got) log(`  ${transaction} ${dept} ${min}-${max} : ${r.got}${full ? " (plein)" : ""}`);
}

async function harvestDept(transaction, dept, watermarkMs) {
  const whole = await harvestCell(transaction, dept, null, watermarkMs);
  if (!whole.capped && whole.got < SPLIT_AT) { log(`  ${transaction} ${dept} : ${whole.got}`); return; }
  log(`  ${transaction} ${dept} : ${whole.got}+ (plafonne) -> subdivision prix`);
  const bands = transaction === "vente" ? VENTE_BANDS : LOC_BANDS;
  for (let i = 0; i < bands.length - 1; i++) {
    const min = bands[i] || 0;
    const max = bands[i + 1] == null ? 20000000 : bands[i + 1];
    await harvestRange(transaction, dept, min, max, watermarkMs, 0);
  }
}

(async function main() {
  const t0 = Date.now();
  // Decalage aleatoire au demarrage : evite que les 3 jobs de la matrix cognent Supabase
  // au meme instant (cold-start) -> cause des echecs ~1m45s du run #16 (6 juin).
  const jitter = Math.floor(Math.random() * int0(process.env.START_JITTER_MS, 30000));
  if (jitter) { log(`Demarrage differe de ${(jitter / 1000).toFixed(0)}s (anti-collision matrix).`); await sleep(jitter); }
  await warmupDb();
  if (MODE === "auto") {
    let n = 0;
    try { n = await sbCount(); }
    catch (e) { log(`sbCount indisponible (${e.message}) -> on suppose la base non vide (incremental).`); n = 1; }
    MODE = n > 0 ? "incremental" : "full";
    log(`Mode auto -> ${MODE} (table : ${n} annonces existantes)`);
  }
  if (MODE === "incremental" && SORT) {
    log("Incremental avec SORT personnalise : arret anticipe DESACTIVE (passe complete idempotente). Retirez SORT pour l'incremental rapide.");
  }
  log(`Harvester — mode=${MODE} dry=${DRY_RUN} depts=${DEPARTMENTS.length} tx=${TRANSACTIONS.join("+")} chunk=${UPSERT_CHUNK} keepRaw=${KEEP_RAW} splitAt=${SPLIT_AT} base=${apiBase}`);

  for (const tx of TRANSACTIONS) {
    let watermarkMs = null;
    if (MODE === "incremental") {
      let st = null;
      try { st = await getState("watermark:" + tx); }
      catch (e) { log(`getState indisponible (${e.message}) -> repli bootstrap.`); st = null; }
      if (st && st.max_updated_at) {
        const t = Date.parse(st.max_updated_at);
        if (!isNaN(t)) watermarkMs = t;
      }
      if (watermarkMs == null) {
        // Pas de watermark updated_at (1er passage apres MAJ API) : bootstrap borne,
        // on ne refait pas une passe complete couteuse.
        watermarkMs = Date.now() - INCR_BOOTSTRAP_DAYS * 86400000;
        log(`Transaction ${tx} — pas de watermark updated_at : bootstrap a ${new Date(watermarkMs).toISOString()} (-${INCR_BOOTSTRAP_DAYS}j)`);
      } else {
        log(`Transaction ${tx} — watermark updated_at : ${new Date(watermarkMs).toISOString()}`);
      }
    }
    for (const dept of DEPARTMENTS) {
      try { await harvestDept(tx, dept, watermarkMs); }
      catch (e) { console.error(`  ! ${tx} ${dept} : ${e.message}`); }
      if (quotaRemaining != null) log(`  quota API restant : ${quotaRemaining}`);
    }
    if (maxUpd[tx]) {
      try {
        await setState("watermark:" + tx, {
          max_updated_at: new Date(maxUpd[tx]).toISOString(),
          max_published_at: maxPub[tx] ? new Date(maxPub[tx]).toISOString() : null,
          updated_at: new Date().toISOString()
        });
      } catch (e) { log(`setState watermark échec (${e.message}) — données déjà upsertées, le prochain run rattrapera.`); }
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  log(`Termine en ${dt}s — base=${apiBase} requetes:${reqCount} annonces vues:${itemCount} upserts:${upsertCount} quota restant:${quotaRemaining}`);
  await logRun({
    finished_at: new Date().toISOString(), mode: MODE, requests: reqCount,
    items_seen: itemCount, upserts: upsertCount, quota_remaining: quotaRemaining == null ? null : String(quotaRemaining),
    note: `depts=${DEPARTMENTS.length} tx=${TRANSACTIONS.join("+")} base=${apiBase} ${dt}s`
  });

  // FAIL-LOUD : aucune requete API n'a abouti (proxy ET direct injoignables) -> job ROUGE
  // (sinon le try/catch par dept masque une panne totale en "succes" a 0 upsert).
  if (!DRY_RUN && reqCount === 0) {
    console.error("ÉCHEC : aucune requête API aboutie (proxy ET direct injoignables) — 0 annonce, 0 upsert. Voir les '! ... echec apres retries' ci-dessus.");
    process.exit(1);
  }
})().catch(e => { console.error("Fatal :", e); process.exit(1); });
