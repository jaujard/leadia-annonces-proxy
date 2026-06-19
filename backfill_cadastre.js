#!/usr/bin/env node
/**
 * Backfill cadastre — « Cadastre par Leadia »
 * Pour chaque TERRAIN sans aucune surface (land_surface ET surface vides) mais
 * geolocalise, interroge l'API CADASTRE de l'IGN (APICarto) avec le point
 * lat/long, recupere la parcelle qui contient ce point et sa CONTENANCE (m2),
 * puis stocke le resultat dans des colonnes DEDIEES (jamais par-dessus land_surface) :
 *   - land_surface_cadastre (numeric)  : contenance de la parcelle (m2)
 *   - cadastre_parcelle     (text)     : identifiant cadastral (idu) pour tracabilite
 *   - cadastre_checked_at   (timestamptz) : horodatage du lookup (rend le batch RESUMABLE)
 *
 * ⚠️ DONNEE INDICATIVE, PAS LA SURFACE ANNONCEE. Les coordonnees des annonces sont
 * arrondies (~100 m) et floutees (leboncoin) : le point peut tomber sur une parcelle
 * voisine. On filtre les valeurs aberrantes (> MAX_CADASTRE) mais on horodate quand meme
 * la ligne pour ne pas la re-tester en boucle.
 *
 * ENV requis : SUPABASE_URL, SUPABASE_SERVICE_KEY
 * ENV options : BATCH (def 200), MAX (0 = illimite), DELAY_MS (def 220), MAX_CADASTRE
 *               (def 50000 m2 ; au-dela = stocke parcelle + checked_at mais land_surface_cadastre=null),
 *               TABLE_PREFIX (def leadia_), DRY_RUN (1 = aucune ecriture), VERBOSE (1)
 */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const CADASTRE_API = process.env.CADASTRE_API || "https://apicarto.ign.fr/api/cadastre/parcelle";
const TBL = (process.env.TABLE_PREFIX != null ? process.env.TABLE_PREFIX : "leadia_") + "annonces";
const BATCH = int0(process.env.BATCH, 200);
const MAX = int0(process.env.MAX, 0);
const DELAY_MS = int0(process.env.DELAY_MS, 220);
const MAX_CADASTRE = int0(process.env.MAX_CADASTRE, 50000);
const DRY_RUN = process.env.DRY_RUN === "1";
const VERBOSE = process.env.VERBOSE === "1";

if (!SB_URL || !SB_KEY) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY manquantes."); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
function int0(v, d) { const n = parseInt(v, 10); return isNaN(n) ? d : n; }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function sbFetch(path, opts = {}) {
  const url = SB_URL.replace(/\/$/, "") + path;
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try {
      r = await fetch(url, { ...opts, headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, ...(opts.headers || {}) } });
    } catch (e) { lastErr = e && e.message ? e.message : String(e); await sleep(800 * (attempt + 1)); continue; }
    if (r.status >= 500 || r.status === 429) { lastErr = "HTTP " + r.status; await sleep(800 * (attempt + 1)); continue; }
    return r;
  }
  throw new Error("Supabase injoignable apres retries (" + lastErr + ")");
}

// Candidats : terrain a blanc, geolocalise, pas encore teste par le cadastre.
async function fetchCandidates(limit) {
  const sel = "source,reference,city,latitude,longitude";
  const flt = "type=eq.Terrain"
    + "&land_surface=is.null"
    + "&surface=is.null"
    + "&latitude=not.is.null"
    + "&longitude=not.is.null"
    + "&cadastre_checked_at=is.null";
  const r = await sbFetch("/rest/v1/" + TBL + "?select=" + sel + "&" + flt + "&order=reference&limit=" + limit);
  if (!r.ok) throw new Error("fetchCandidates " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  return r.json();
}

async function lookupCadastre(lon, lat) {
  const geom = encodeURIComponent(JSON.stringify({ type: "Point", coordinates: [lon, lat] }));
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try { r = await fetch(CADASTRE_API + "?geom=" + geom, { headers: { Accept: "application/json" } }); }
    catch (e) { await sleep(1000 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const f = j && j.features && j.features[0];
    if (!f || !f.properties) return { contenance: null, idu: null };
    return { contenance: f.properties.contenance != null ? Number(f.properties.contenance) : null, idu: f.properties.idu || null };
  }
  return null; // echec reseau -> on NE marque pas la ligne (sera re-tentee au prochain run)
}

async function updateRow(source, reference, fields) {
  if (DRY_RUN) return;
  const flt = "source=eq." + encodeURIComponent(source) + "&reference=eq." + encodeURIComponent(reference);
  const r = await sbFetch("/rest/v1/" + TBL + "?" + flt, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify(fields)
  });
  if (!r.ok) throw new Error("update " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
}

(async function main() {
  const t0 = Date.now();
  log(`Backfill cadastre — table=${TBL} batch=${BATCH} delay=${DELAY_MS}ms maxCadastre=${MAX_CADASTRE} dry=${DRY_RUN}`);
  let done = 0, withSurface = 0, noParcel = 0, aberrant = 0, netFail = 0;

  while (true) {
    let rows;
    try { rows = await fetchCandidates(BATCH); }
    catch (e) { log("fetchCandidates KO: " + e.message + " — pause 5s"); await sleep(5000); continue; }
    if (!rows.length) { log("Plus de candidats."); break; }

    for (const row of rows) {
      if (MAX && done >= MAX) { log(`MAX=${MAX} atteint.`); break; }
      const res = await lookupCadastre(Number(row.longitude), Number(row.latitude));
      if (res === null) { netFail++; if (VERBOSE) log(`  net-fail ${row.reference} (${row.city}) — non marque`); await sleep(DELAY_MS); continue; }

      const now = new Date().toISOString();
      let lsc = null;
      if (res.contenance != null && res.contenance > 0) {
        if (res.contenance <= MAX_CADASTRE) { lsc = res.contenance; withSurface++; }
        else { aberrant++; } // parcelle trop grande -> probablement mauvaise parcelle : on garde l'idu mais pas la surface
      } else { noParcel++; }

      try {
        await updateRow(row.source, row.reference, {
          land_surface_cadastre: lsc,
          cadastre_parcelle: res.idu,
          cadastre_checked_at: now
        });
      } catch (e) { log(`  update KO ${row.reference}: ${e.message}`); await sleep(DELAY_MS); continue; }

      done++;
      if (VERBOSE) log(`  ${row.reference} ${row.city} -> ${lsc != null ? lsc + " m2" : (res.contenance ? res.contenance + " m2 (aberrant, ignore)" : "pas de parcelle")} [${res.idu || "-"}]`);
      if (done % 100 === 0) log(`  ... ${done} traites (surface:${withSurface} aberrant:${aberrant} sansParcelle:${noParcel} netFail:${netFail})`);
      await sleep(DELAY_MS);
    }
    if (MAX && done >= MAX) break;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  log(`Termine en ${dt}s — traites:${done} avecSurface:${withSurface} aberrants:${aberrant} sansParcelle:${noParcel} echecsReseau:${netFail}${DRY_RUN ? " (DRY_RUN)" : ""}`);
})().catch(e => { console.error("Fatal :", e); process.exit(1); });
