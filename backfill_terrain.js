#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────────────
 * backfill_terrain.js — Remplit land_surface des MAISONS depuis la DESCRIPTION,
 * directement en base (NE TAPE PAS l'API cherchertrouver).
 *
 * Pourquoi : ~3/4 des maisons n'ont pas de land_surface structuré ; beaucoup ont
 * pourtant un terrain mentionné dans la description. Le harvester applique déjà
 * parseLandFromText() aux annonces qu'il (re)collecte, mais seulement aux biens
 * encore EN LIGNE. Ce script relit TOUTES les maisons déjà en base (en ligne ou
 * non) et complète celles dont la description contient un terrain exploitable.
 *
 * Logique d'extraction = STRICTEMENT la même que harvest.js (0 faux positif :
 * terrain toujours > surface habitable, bornes 10–2 000 000 m²).
 *
 * Env (mêmes que le harvester) :
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   DRY_RUN=1   → simule et compte, n'écrit rien (à lancer EN PREMIER)
 *
 * Usage VPS :
 *   cd ~/harvester && set -a && . ./.env && set +a
 *   DRY_RUN=1 node backfill_terrain.js          # aperçu des volumes
 *   nohup node backfill_terrain.js > backfill.log 2>&1 &   # écriture réelle
 *   tail -f backfill.log
 * Idempotent : relançable sans risque (ne touche que les maisons land_surface vide).
 * ─────────────────────────────────────────────────────────────────────────── */
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.env.DRY_RUN === "1";
if (!SB_URL || !SB_KEY) { console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_KEY manquantes."); process.exit(1); }
const REST = SB_URL.replace(/\/+$/, "") + "/rest/v1/leadia_annonces";
const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);

// ── extracteur terrain (copie verbatim de harvest.js) ──
function parseLandFromText(t) {
  if (!t) return null;
  t = String(t).replace(/ /g, " ").replace(/&nbsp;/gi, " ");
  const toNum = s => { const n = parseInt(String(s).replace(/[ .]/g, ""), 10); return isNaN(n) ? null : n; };
  const M2 = "m(?:\\u00b2|2|\\s*carr)";
  let m = t.match(new RegExp("(?:terrain|parcelle|jardin)(?:[^.\\d]{0,25}?)(\\d[\\d .]{1,7}?)\\s*" + M2, "i"));
  if (!m) m = t.match(new RegExp("(\\d[\\d .]{1,7}?)\\s*" + M2 + "\\s*(?:de\\s+)?(?:terrain|parcelle|jardin)", "i"));
  if (!m) return null;
  const n = toNum(m[1]);
  if (n == null || n < 10 || n > 2000000) return null;
  return n;
}

const PAGE = 1000;        // taille de page (keyset sur la PK source,reference)
const CONC = 5;           // PATCH en parallèle
const q = s => '"' + String(s).replace(/"/g, '\\"') + '"';

async function fetchPage(lastS, lastR) {
  let url = REST + "?select=source,reference,description,surface,land_surface"
    + "&type=eq.Maison&order=source.asc,reference.asc&limit=" + PAGE;
  if (lastS !== null) {
    url += "&or=(source.gt." + encodeURIComponent(q(lastS))
      + ",and(source.eq." + encodeURIComponent(q(lastS))
      + ",reference.gt." + encodeURIComponent(q(lastR)) + "))";
  }
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error("GET " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
async function patchOne(src, ref, val) {
  const url = REST + "?source=eq." + encodeURIComponent(q(src)) + "&reference=eq." + encodeURIComponent(q(ref));
  const r = await fetch(url, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ land_surface: val }) });
  if (!r.ok) throw new Error("PATCH " + r.status + " " + (await r.text()).slice(0, 200));
}
async function runPool(jobs) {
  let i = 0;
  async function worker() { while (i < jobs.length) { const j = jobs[i++]; await patchOne(j.s, j.r, j.v); } }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

(async () => {
  console.log((DRY ? "[DRY RUN] " : "") + new Date().toISOString().slice(11, 19) + " Backfill terrain (maisons, depuis description)…");
  let lastS = null, lastR = null, scanned = 0, filled = 0;
  for (;;) {
    const rows = await fetchPage(lastS, lastR);
    if (!rows.length) break;
    const jobs = [];
    for (const row of rows) {
      scanned++; lastS = row.source; lastR = row.reference;
      if (row.land_surface == null && row.description) {
        const n = parseLandFromText(row.description);
        const surf = num(row.surface);
        if (n != null && (surf == null || n > surf)) { jobs.push({ s: row.source, r: row.reference, v: n }); filled++; }
      }
    }
    if (!DRY && jobs.length) await runPool(jobs);
    console.log(new Date().toISOString().slice(11, 19) + " scannées=" + scanned + " · terrain ajouté=" + filled);
    await sleep(50);
  }
  console.log(new Date().toISOString().slice(11, 19) + " TERMINÉ. Maisons scannées=" + scanned
    + ", terrain renseigné depuis description=" + filled + (DRY ? "  [DRY RUN — rien écrit]" : ""));
})().catch(e => { console.error("✗ ERREUR:", e.message); process.exit(1); });
