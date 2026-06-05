/* ====================================================================
   Client API "annonces" (cherchertrouver.immo) pour Cadastre par Leadia
   --------------------------------------------------------------------
   À CONFIGURER : mettez ci-dessous l'URL de VOTRE proxy déployé
   (cf. proxy-annonces-worker.js). La clé API ne doit JAMAIS être ici :
   elle reste dans le proxy. Tant que CT_PROXY_BASE est vide, les modules
   continuent d'afficher leurs données d'exemple.
   ==================================================================== */
window.CT_PROXY_BASE = "https://leadia-annonces-proxy.netlify.app/api";
// Racine du site Netlify (pour l'Image CDN). Déduite de CT_PROXY_BASE en retirant /api.
window.CT_SITE_BASE = window.CT_PROXY_BASE.replace(/\/api\/?$/, "");

// PHOTOS — façon cadastre.com : tout passe par un service image côté serveur
// (fetch serveur => contourne l'anti-hotlink type bienici + redimensionne + cache edge => rapide).
// Source primaire : Netlify Image CDN (/.netlify/images). w = largeur cible (px).
window.CT_IMG = function (u, w) {
  if (!u || !window.CT_SITE_BASE) return u;
  return window.CT_SITE_BASE + "/.netlify/images?url=" + encodeURIComponent(u) + "&w=" + (w || 480) + "&fit=cover";
};
// Secours 1 : relais image via la fonction proxy (renvoie les octets en base64).
window.CT_IMG_PROXY = function (u) { return (window.CT_PROXY_BASE && u) ? window.CT_PROXY_BASE + "/img?u=" + encodeURIComponent(u) : u; };
// Secours 2 : URL d'origine telle quelle (chargement direct navigateur).
window.CT_IMG_RAW = function (u) { return u; };

// Hôtes anti-hotlink : renvoient un placeholder NOIR en chargement direct (HTTP 200,
// donc onerror ne se déclenche jamais) => il FAUT passer par le serveur pour ces sources.
window.CT_IMG_NEEDS_PROXY = function (u) {
  try { return /bienici|seloger|staticlbi|svdn\.fr/i.test(new URL(u).hostname); } catch (e) { return false; }
};
// Chaîne de secours ORDONNÉE et "source-aware" (= fluidité façon cadastre.com) :
//  - source permissive (leboncoin, safti, remax/maxwork, human-immobilier…) -> DIRECT d'abord
//    (instantané, cache navigateur, zéro hop serveur), Image CDN puis /img en secours.
//  - source anti-hotlink (bienici/seloger…) -> Image CDN (serveur) d'abord, /img en secours
//    (le direct = carré noir silencieux, on ne le tente donc pas).
window.CT_IMG_CHAIN = function (u, w) {
  if (!u) return [];
  var cdn = window.CT_IMG(u, w), prx = window.CT_IMG_PROXY(u);
  return window.CT_IMG_NEEDS_PROXY(u) ? [cdn, prx] : [u, cdn, prx];
};

(function () {
  if (!window.CT_PROXY_BASE || !/^https?:\/\//.test(window.CT_PROXY_BASE)) {
    console.warn("[annonces-api] CT_PROXY_BASE non configuré → données d'exemple utilisées. Renseignez l'URL du proxy dans annonces-api.js.");
    return; // on ne définit pas window.ANNONCES_API → fallback démo
  }
  const BASE = window.CT_PROXY_BASE.replace(/\/+$/, "");

  async function call(path) {
    const r = await fetch(BASE + path, { headers: { "Accept": "application/json" } });
    if (!r.ok) { let m = "API " + r.status; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
    return r.json();
  }
  // API item -> format interne commun à tous les modules
  function norm(a) {
    return {
      prix: a.price, surface: a.surface, terrain: 0, pieces: a.rooms, chambres: a.bedrooms,
      type: a.type, transaction: a.transaction_type,
      ville: a.city, cp: a.postal_code, dept: a.department, region: a.region,
      adresse: a.title || a.city || "", lat: a.latitude, lon: a.longitude,
      id: (a.source || "") + ":" + (a.reference || ""),
      agence: a.source, source: a.source, reference: a.reference,
      particulier: !!a.is_internal === false && (a.source === "leboncoin"),
      date: a.published_at, photos: a.images_count || (a.image ? 1 : 0),
      url: a.external_url, dpe: a.dpe, ges: a.ges,
      annee: a.year_built, sdb: a.bathrooms, description: a.description || "",
      images: a.images || (a.image ? [a.image] : []),
      m2: a.price_per_m2, m2color: a.price_per_m2_color, baisse: false
    };
  }
  function bboxAround(lat, lon, km) {
    const d = (km || 1.2) / 111;                 // ~ degrés
    return [lat - d, lon - d, lat + d, lon + d].join(",");
  }

  // --- API LIVE (cherchertrouver.immo via proxy) : utilisée en repli ou source directe ---
  async function liveApi(params) {
    // --- mode "comparables" (Estimation) : on utilise /annonces/map autour du point ---
    if (params && params.comparables) {
      const q = new URLSearchParams();
      q.set("bbox", bboxAround(params.lat, params.lon, params.rayon || 1.2));
      if (params.type) q.set("type", params.type);
      const j = await call("/annonces/map?" + q.toString());
      return (j.items || []).map(norm);
    }
    // --- mode "recherche" (Nouvelle Recherche / Annonces Anciens / Locations) ---
    const q = new URLSearchParams();
    if (params.types && params.types.length === 1) q.set("type", params.types[0]); // l'API = 1 type/req
    if (params.locs && params.locs[0]) q.set("ville", params.locs[0]);
    if (params.kw) q.set("q", params.kw);
    if (params.tx) q.set("transaction", String(params.tx).indexOf("location") >= 0 ? "location" : "vente");
    if (params.pMin) q.set("prix_min", params.pMin);
    if (params.pMax) q.set("prix_max", params.pMax);
    if (params.hMin) q.set("surface_min", params.hMin);
    if (params.hMax) q.set("surface_max", params.hMax);
    if (params.rMin) q.set("pieces_min", params.rMin);
    if (params.m2Min) q.set("prix_m2_min", params.m2Min);
    if (params.m2Max) q.set("prix_m2_max", params.m2Max);
    if (params.sort) q.set("sort", params.sort);
    if (params.page) q.set("page", params.page);
    q.set("page_size", "48");   // max imposé par l'API
    const j = await call("/annonces?" + q.toString());
    const out = (j.items || []).map(norm);
    out.hasMore = !!j.has_more;   // info pagination portée sur le tableau
    out.totalPage = j.page || 1;
    return out;
  }

  // ===================================================================
  //  LECTURE SUPABASE (annonces aspirées par le harvester) via /db
  //  Mêmes noms de colonnes que l'API → on réutilise norm(). DB-first,
  //  repli sur l'API live si la table a peu/pas de résultats (remplissage).
  // ===================================================================
  const DB_BASE = BASE + "/db/annonces";
  const PAGE_SZ = 48;
  const MIN_DB  = 1;             // base désormais exhaustive (France entière) → on lui fait confiance ;
                                 // repli API live seulement si la base ne renvoie RIEN (0 résultat).
                                 // (Avant =6 : un filtre serré — ex. prix exact — renvoyait peu de lignes
                                 //  et déclenchait à tort le repli live qui repolluait avec des prix voisins.)
  window.__ANNONCES_SRC = "db";  // source de la recherche courante (continuité pagination)

  function pgRange(col, lo, hi) {
    const f = [];
    if (lo != null && lo !== "") f.push(col + "=gte." + encodeURIComponent(lo));
    if (hi != null && hi !== "") f.push(col + "=lte." + encodeURIComponent(hi));
    return f;
  }
  function dbOrder(sort) {
    switch (String(sort || "")) {
      case "prix_asc": case "price_asc":  return "price.asc.nullslast";
      case "prix_desc": case "price_desc": return "price.desc.nullslast";
      case "surface_desc": return "surface.desc.nullslast";
      case "m2_asc": return "price_per_m2.asc.nullslast";
      case "m2_desc": return "price_per_m2.desc.nullslast";
      default: return "published_at.desc.nullslast";   // plus récent d'abord
    }
  }
  function buildDbQuery(params, page) {
    const f = ["select=*"];
    if (params.types && params.types.length === 1) f.push("type=eq." + encodeURIComponent(params.types[0]));
    else if (params.types && params.types.length > 1) f.push("type=in.(" + params.types.map(encodeURIComponent).join(",") + ")");
    if (params.tx) f.push("transaction_type=eq." + (String(params.tx).indexOf("location") >= 0 ? "location" : "vente"));
    if (params.locs && params.locs[0]) f.push("city=ilike.*" + encodeURIComponent(params.locs[0]) + "*");
    if (params.kw) { const k = encodeURIComponent(params.kw); f.push("or=(title.ilike.*" + k + "*,description.ilike.*" + k + "*)"); }
    f.push.apply(f, pgRange("price", params.pMin, params.pMax));
    f.push.apply(f, pgRange("surface", params.hMin, params.hMax));
    if (params.rMin != null && params.rMin !== "") f.push("rooms=gte." + encodeURIComponent(params.rMin));
    f.push.apply(f, pgRange("price_per_m2", params.m2Min, params.m2Max));
    f.push("order=" + dbOrder(params.sort));
    const p = Math.max(1, page || 1);
    f.push("limit=" + (PAGE_SZ + 1));       // +1 pour savoir s'il y a une page suivante
    f.push("offset=" + ((p - 1) * PAGE_SZ));
    return f.join("&");
  }
  async function dbCall(qs2) {
    const r = await fetch(DB_BASE + "?" + qs2, { headers: { "Accept": "application/json" } });
    if (!r.ok) { let m = "DB " + r.status; try { const j = await r.json(); m = j.message || j.error || m; } catch (e) {} throw new Error(m); }
    return r.json();
  }
  window.ANNONCES_DB = async function (params) {
    if (params && params.comparables) {
      const d = (params.rayon || 1.2) / 111;
      const f = ["select=*",
        "latitude=gte." + (params.lat - d), "latitude=lte." + (params.lat + d),
        "longitude=gte." + (params.lon - d), "longitude=lte." + (params.lon + d),
        "limit=300"];
      if (params.type) f.push("type=eq." + encodeURIComponent(params.type));
      const rows = await dbCall(f.join("&"));
      return rows.map(norm);
    }
    const page = (params && params.page) || 1;
    const rows = await dbCall(buildDbQuery(params, page));
    const more = rows.length > PAGE_SZ;
    const out = rows.slice(0, PAGE_SZ).map(norm);
    out.hasMore = more; out.totalPage = page;
    return out;
  };

  // Tous les portails où le même bien est listé (croisement base, façon cadastre.com).
  // Match : même CODE POSTAL (fiable entre portails ; la géoloc est décalée d'un portail à l'autre)
  //         + surface ±1 m² + même nb de pièces + PRIX ±3 % + même transaction.
  // Renvoie [{source, url}] dédoublonné par source.
  window.ANNONCES_PORTALS = async function (a) {
    if (!a) return [];
    const cp = a.cp != null ? String(a.cp).trim() : "";
    const ville = a.ville != null ? String(a.ville).trim() : "";
    if (!cp && !ville && (a.lat == null || a.lon == null)) return [];
    const f = ["select=source,external_url,price,postal_code,surface"];
    // Localisation : code postal d'abord (le même bien a le MÊME CP sur tous les portails,
    // alors que ses coordonnées GPS diffèrent souvent → l'ancien filtre géoloc ~50 m ratait les doublons).
    if (cp) f.push("postal_code=eq." + encodeURIComponent(cp));
    else if (ville) f.push("city=ilike." + encodeURIComponent(ville));
    else { const d = 0.01; f.push("latitude=gte." + (a.lat - d), "latitude=lte." + (a.lat + d), "longitude=gte." + (a.lon - d), "longitude=lte." + (a.lon + d)); }
    const s = a.surface;
    if (s != null && s !== "" && !isNaN(s)) { f.push("surface=gte." + (s - 1)); f.push("surface=lte." + (Number(s) + 1)); }
    if (a.pieces != null && a.pieces !== "") f.push("rooms=eq." + encodeURIComponent(a.pieces));
    // Filtre PRIX (indispensable) : sans lui, on regrouperait des biens DIFFÉRENTS du même quartier.
    // Fenêtre ±3 % (max(3 %, 1000 €)) : absorbe l'écart honoraires agence / net vendeur, rejette un voisin.
    const p = Number(a.prix != null ? a.prix : a.price);
    if (p && !isNaN(p)) {
      const tol = Math.max(Math.round(p * 0.03), 1000);
      f.push("price=gte." + (p - tol)); f.push("price=lte." + (p + tol));
    }
    if (a.transaction) f.push("transaction_type=eq." + (String(a.transaction).indexOf("location") >= 0 ? "location" : "vente"));
    f.push("limit=80");
    let rows;
    try { rows = await dbCall(f.join("&")); } catch (e) { return []; }
    const seen = new Map();
    (rows || []).forEach(r => { if (r.source && !seen.has(r.source)) seen.set(r.source, { source: r.source, url: r.external_url || "" }); });
    return [...seen.values()];
  };

  // Point d'entrée unique des modules : Supabase d'abord, repli API live.
  window.ANNONCES_API = async function (params) {
    params = params || {};
    const page = params.page || 1;

    if (params.comparables) {
      try { const d = await window.ANNONCES_DB(params); if (d && d.length) return d; }
      catch (e) { console.warn("[annonces] DB comparables KO → repli API", e); }
      return liveApi(params);
    }

    if (page <= 1) {                       // nouvelle recherche : on choisit la source
      let dbRes = null;
      try { dbRes = await window.ANNONCES_DB(params); } catch (e) { console.warn("[annonces] DB KO → repli API", e); }
      if (dbRes && dbRes.length >= MIN_DB) { window.__ANNONCES_SRC = "db"; return dbRes; }
      window.__ANNONCES_SRC = "api";       // table peu remplie → on tente l'API live
      try {
        const a = await liveApi(params);
        if ((!a || !a.length) && dbRes && dbRes.length) { window.__ANNONCES_SRC = "db"; return dbRes; }
        return a;
      } catch (e) {
        if (dbRes) { window.__ANNONCES_SRC = "db"; return dbRes; }
        throw e;
      }
    }

    // pages suivantes : on garde la source de la page 1
    if (window.__ANNONCES_SRC === "db") {
      try { return await window.ANNONCES_DB(params); } catch (e) { return liveApi(params); }
    }
    return liveApi(params);
  };

  // Bonus : recherche par zone carto (bbox) — utilisable par les vues carte
  window.ANNONCES_MAP = async function (bbox, filters) {
    const q = new URLSearchParams(); q.set("bbox", bbox);
    if (filters) Object.entries(filters).forEach(([k, v]) => v != null && q.set(k, v));
    const j = await call("/annonces/map?" + q.toString());
    return { total: j.total, capped: j.capped, items: (j.items || []).map(norm) };
  };

  console.info("[annonces-api] connecté via proxy :", BASE);
})();
