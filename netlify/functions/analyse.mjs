// Outil d'audit Google Ads — expert-360.ca
// POST /api/analyse  { "url": "https://exemple.ca" }
// Renvoie : score de potentiel, volumes, CPC, concurrence, saisonnalité, mots-clés.
// Les identifiants viennent des variables d'environnement Netlify (jamais du code).

import { lirePage, extraireMetier, liensServices, NEGATIFS, MOTS_LARGES, parseSite as parseUrl } from "../lib/lecture.mjs";

const API = "https://googleads.googleapis.com/v24";
const GEO_QUEBEC = "geoTargetConstants/20123";
const LANG_FR = "languageConstants/1002";
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTH_INDEX = { JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5, JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11 };

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function parseSite(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.includes(".") || u.hostname.length > 253) return null;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)(localhost|local|internal)$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    return { host, url: `https://${u.hostname}${u.pathname}` };
  } catch {
    return null;
  }
}

async function getAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error("oauth");
  return (await r.json()).access_token;
}

async function keywordIdeas(token, seed) {
  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const r = await fetch(`${API}/customers/${cid}:generateKeywordIdeas`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "login-customer-id": cid,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      language: LANG_FR,
      geoTargetConstants: [GEO_QUEBEC],
      keywordPlanNetwork: "GOOGLE_SEARCH",
      includeAdultKeywords: false,
      keywordAnnotation: ["KEYWORD_CONCEPT"],
      pageSize: 500,
      ...seed,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("ads:" + r.status + ":" + t.slice(0, 300));
  }
  return (await r.json()).results || [];
}

function toIdea(res) {
  const m = res.keywordIdeaMetrics || {};
  const months = new Array(12).fill(null);
  for (const v of m.monthlySearchVolumes || []) {
    const i = MONTH_INDEX[v.month];
    if (i !== undefined) months[i] = Number(v.monthlySearches || 0);
  }
  return {
    keyword: res.text,
    volume: Number(m.avgMonthlySearches || 0),
    compIndex: m.competitionIndex !== undefined ? Number(m.competitionIndex) : null,
    competition: m.competition || "UNSPECIFIED",
    low: m.lowTopOfPageBidMicros ? Number(m.lowTopOfPageBidMicros) / 1e6 : null,
    high: m.highTopOfPageBidMicros ? Number(m.highTopOfPageBidMicros) / 1e6 : null,
    months,
    // Concepts de marque détectés par Google (filtre « Marque » du Keyword Planner)
    brands: ((res.keywordAnnotations || {}).concepts || [])
      .filter((c) => c.conceptGroup && /BRAND/.test(c.conceptGroup.type || "") && c.conceptGroup.type !== "NON_BRAND")
      .map((c) => c.name)
      .filter(Boolean),
    generic: ((res.keywordAnnotations || {}).concepts || [])
      .filter((c) => !c.conceptGroup || !/BRAND/.test(c.conceptGroup.type || "") || c.conceptGroup.type === "NON_BRAND")
      .map((c) => c.name)
      .filter(Boolean),
  };
}

// Keyword Planner renvoie des variantes proches avec des chiffres identiques : on n'en garde qu'une.
function dedupe(ideas) {
  const seen = new Set();
  return ideas.filter((k) => {
    const c = (v) => (v === null ? "-" : Math.round(v * 10));
    const key = [k.volume, c(k.low), c(k.high)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Mots de la marque : présents dans le domaine mais rares dans l'ensemble des idées.
function brandWords(host, ideas) {
  const token = norm(host.split(".")[0]).replace(/[^a-z0-9]/g, "");
  const freq = new Map();
  for (const k of ideas) {
    for (const w of new Set(norm(k.keyword).split(/[^a-z0-9]+/))) {
      if (w.length >= 3) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const brand = new Set();
  for (const [w, n] of freq) {
    // Le mot doit couvrir une bonne part du nom (« sol » ne représente pas « genisol »).
    if (token.includes(w) && w.length >= Math.max(4, Math.ceil(token.length * 0.6)) && n / ideas.length < 0.15) brand.add(w);
  }
  if (token.length >= 3 && !freq.has(token)) brand.add(token);
  return brand;
}


// Villes du Québec pour la répartition régionale (codes géo résolus une fois, puis gardés en mémoire).
const VILLES = ["Montréal", "Québec", "Laval", "Gatineau", "Longueuil", "Sherbrooke", "Trois-Rivières", "Saguenay", "Lévis", "Terrebonne"];
let villesCache = null;

function adsHeaders(token) {
  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  return { Authorization: `Bearer ${token}`, "login-customer-id": cid, "Content-Type": "application/json" };
}

async function villesGeo(token) {
  if (villesCache) return villesCache;
  const r = await fetch(`${API}/geoTargetConstants:suggest`, {
    method: "POST",
    headers: adsHeaders(token),
    body: JSON.stringify({ locale: "fr", countryCode: "CA", locationNames: { names: VILLES } }),
  });
  if (!r.ok) throw new Error("geo:" + r.status);
  const out = [];
  const sugg = (await r.json()).geoTargetConstantSuggestions || [];
  for (const nom of VILLES) {
    const hit = sugg.find((g) => g.searchTerm === nom && g.geoTargetConstant?.targetType === "City" &&
      /Quebec,Canada$/.test(g.geoTargetConstant?.canonicalName || ""));
    if (hit) out.push({ nom, geo: hit.geoTargetConstant.resourceName });
  }
  villesCache = out;
  return out;
}

async function volumesParVille(token, keywords) {
  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const villes = await villesGeo(token);
  const res = await Promise.allSettled(villes.map(async (v) => {
    const r = await fetch(`${API}/customers/${cid}:generateKeywordHistoricalMetrics`, {
      method: "POST",
      headers: adsHeaders(token),
      body: JSON.stringify({ keywords, language: LANG_FR, geoTargetConstants: [v.geo], keywordPlanNetwork: "GOOGLE_SEARCH" }),
    });
    if (!r.ok) throw new Error("hist:" + r.status);
    const j = await r.json();
    const total = (j.results || []).reduce((s, x) => s + Number(x.keywordMetrics?.avgMonthlySearches || 0), 0);
    return { ville: v.nom, recherches: total };
  }));
  return res.filter((x) => x.status === "fulfilled" && x.value.recherches > 0).map((x) => x.value)
    .sort((a, b) => b.recherches - a.recherches);
}


// Part mobile / ordinateur / tablette sur les recherches principales du secteur.
async function appareils(token, keywords) {
  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const r = await fetch(`${API}/customers/${cid}:generateKeywordHistoricalMetrics`, {
    method: "POST",
    headers: adsHeaders(token),
    body: JSON.stringify({
      keywords, language: LANG_FR, geoTargetConstants: [GEO_QUEBEC], keywordPlanNetwork: "GOOGLE_SEARCH",
      aggregateMetrics: { aggregateMetricTypes: ["DEVICE"] },
    }),
  });
  if (!r.ok) throw new Error("device:" + r.status);
  const list = ((await r.json()).aggregateMetricResults || {}).deviceSearches || [];
  const NOMS = { MOBILE: "Mobile", DESKTOP: "Ordinateur", TABLET: "Tablette" };
  const total = list.reduce((t, d) => t + Number(d.searchCount || 0), 0);
  if (!total) return [];
  return list.filter((d) => NOMS[d.device])
    .map((d) => ({ appareil: NOMS[d.device], part: Math.round((Number(d.searchCount || 0) / total) * 100) }))
    .sort((a, b) => b.part - a.part);
}

// Prévision Google (Keyword Planner) : clics et impressions pour un budget mensuel donné,
// en stratégie « Maximiser les clics », sur les 30 prochains jours.
async function prevision(token, keywords, budgetMois) {
  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`${API}/customers/${cid}:generateKeywordForecastMetrics`, {
    method: "POST",
    headers: adsHeaders(token),
    body: JSON.stringify({
      currencyCode: "CAD",
      forecastPeriod: { startDate: d(1), endDate: d(30) },
      campaign: {
        languageConstants: [LANG_FR],
        geoModifiers: [{ geoTargetConstant: GEO_QUEBEC }],
        keywordPlanNetwork: "GOOGLE_SEARCH",
        biddingStrategy: { maximizeClicksBiddingStrategy: { dailyTargetSpendMicros: String(Math.round((budgetMois / 30) * 1e6)) } },
        adGroups: [{ biddedKeywords: keywords.map((text) => ({ keyword: { text, matchType: "PHRASE" } })) }],
      },
    }),
  });
  if (!r.ok) throw new Error("forecast:" + r.status + ":" + (await r.text()).slice(0, 200));
  const m = (await r.json()).campaignForecastMetrics || {};
  const clics = Math.round(Number(m.clicks || 0));
  if (!clics) throw new Error("forecast:vide");
  return {
    budget: budgetMois,
    clics,
    impressions: Math.round(Number(m.impressions || 0)),
    cout: Math.round(Number(m.costMicros || 0) / 1e6),
    cpc: m.averageCpcMicros ? round(Number(m.averageCpcMicros) / 1e6) : round(Number(m.costMicros || 0) / 1e6 / clics),
    source: "google",
  };
}

// Intention derrière chaque recherche (classement par expressions courantes).
const INTENTIONS = [
  ["Prix et soumission", /\b(prix|cout|couts|tarif|tarifs|soumission|soumissions|devis|combien|pas cher|abordable|estimation)\b/],
  ["Urgence", /\b(urgence|urgent|24h|24 h|24\/7|rapide|aujourd hui|soir|weekend|fin de semaine)\b/],
  ["Comparaison et avis", /\b(meilleur|meilleure|meilleurs|avis|top|comparatif|comparaison|vs|recommande)\b/],
  ["Information", /\b(comment|pourquoi|quoi|quand|qu est ce|guide|conseil|conseils|definition|c est quoi|exemple)\b/],
  ["Recherche locale", /\b(pres de moi|proche|montreal|laval|quebec|gatineau|longueuil|sherbrooke|trois rivieres|saguenay|levis|terrebonne|rive sud|rive nord|region|ville)\b/],
];
function intention(kw) {
  const t = " " + norm(kw).replace(/[^a-z0-9/]+/g, " ") + " ";
  for (const [nom, re] of INTENTIONS) if (re.test(t)) return nom;
  return "Recherche du service";
}


// Racines du métier : 6 premières lettres des mots porteurs de sens.
// En français, le premier mot porte le métier (« évaluation environnementale », « décontamination des sols ») :
// il est « fort ». Les suivants qualifient (« environnementale », « sols ») : « faibles », ils ne suffisent pas
// seuls à rendre une recherche pertinente (ex. « météo environnement canada »).
function racines(metier) {
  const fortes = new Set(), faibles = new Set();
  for (const m of metier) {
    const mots = norm(m).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !MOTS_LARGES.has(w) && !/^\d+$/.test(w)).map((w) => w.slice(0, 6));
    mots.forEach((r, i) => (i === 0 ? fortes : faibles).add(r));
  }
  for (const r of fortes) faibles.delete(r);
  return { fortes, faibles };
}
function pertinent(texte, { fortes, faibles }) {
  const mots = norm(texte).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 6));
  return { fort: mots.some((r) => fortes.has(r)), faible: mots.some((r) => faibles.has(r)) };
}
// Organismes et sites qui ne sont pas des concurrents.
const PAS_CONCURRENT = /^(environnement canada|gouvernement|gouv|ministere|ville de|meteomedia|meteo|wikipedia|google|youtube|facebook|instagram|kijiji|indeed|jobboom|revenu quebec|service canada|statistique canada|canada|quebec|montreal|radio canada|la presse|le devoir|tva)/;

const compLabel = (i) => (i === null ? "Inconnue" : i < 34 ? "Faible" : i < 67 ? "Moyenne" : "Élevée");
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non permise." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
  const site = parseSite(body.url);
  if (!site) return json({ error: "Adresse de site invalide. Exemple : votresite.ca" }, 400);

  // 1. Le métier : ce que le site vend, lu dans son titre, sa description, ses titres et son menu.
  //    Le visiteur peut aussi le préciser lui-même (champ « metier », séparé par des virgules).
  const precise = String(body.metier || "").split(",").map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 60).slice(0, 8);
  // Pages lues : l'accueil, puis les pages « Expertise » / « Services » trouvées dans le menu,
  // ou à défaut aux adresses courantes (/expertise, /services…).
  const CHEMINS = ["/expertise", "/expertises", "/services", "/nos-services", "/solutions"];
  const lecture = precise.length ? Promise.resolve({ metier: precise, pagesServices: [], faible: false })
    : lirePage(new URL(parseUrl(site.url).origin + "/"), 5000).then(async (p) => {
      let liens = liensServices(p.html, p.final);
      if (!liens.length) liens = CHEMINS.map((c) => p.final.origin + c);
      const lues = (await Promise.all(liens.slice(0, 5).map((h) =>
        lirePage(new URL(h), 3000).then((r) => ({ url: h, html: r.html })).catch(() => null)))).filter(Boolean).slice(0, 2);
      const metierLu = extraireMetier(p.html, site.host, lues.map((x) => x.html));
      // Site construit en JavaScript : les titres des services ne sont pas dans le code reçu.
      const titres = lues.reduce((t, x) => t + (x.html.match(/<h[2-4][\s>]/gi) || []).length, 0);
      return { metier: metierLu, pagesServices: lues.map((x) => x.url), faible: metierLu.length < 5 || (lues.length > 0 && titres < 3) };
    }).catch((e) => {
      console.error("analyse:lecture", site.host, String(e.message || e));
      return { metier: [], pagesServices: [], faible: true };
    });

  let raw, token, metier = [];
  try {
    let lu;
    [token, lu] = await Promise.all([getAccessToken(), lecture]);
    metier = lu.metier;
    // 2. Quand la lecture du site est pauvre, on demande à Google de lire la page des services
    //    (son robot affiche les sites en JavaScript) et on en tire les métiers.
    if (lu.faible) {
      const pageGoogle = lu.pagesServices[0] || site.url;
      try {
        const viaGoogle = await keywordIdeas(token, { urlSeed: { url: pageGoogle } });
        const tetes = new Set(metier.map((m) => norm(m).split(/[^a-z0-9]+/)[0]));
        const ajout = [];
        viaGoogle
          .filter((r) => !((r.keywordAnnotations || {}).concepts || []).some((c) => /BRAND/.test(c.conceptGroup?.type || "") && c.conceptGroup.type !== "NON_BRAND"))
          .filter((r) => !NEGATIFS.test(" " + norm(r.text).replace(/[^a-z0-9]+/g, " ") + " "))
          .sort((x, y) => Number(y.keywordIdeaMetrics?.avgMonthlySearches || 0) - Number(x.keywordIdeaMetrics?.avgMonthlySearches || 0))
          .forEach((r) => {
            const mots = norm(r.text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !MOTS_LARGES.has(w));
            const tete = mots[0];
            if (!tete || tetes.has(tete) || ajout.length >= 8 || r.text.split(" ").length > 4) return;
            tetes.add(tete); ajout.push(r.text);
          });
        metier = [...ajout, ...metier].slice(0, 10);
        raw = viaGoogle;
      } catch (e) {
        console.error("analyse:urlseed", site.host, String(e.message || e));
      }
    }
    // 3. Les recherches partent du métier. Sans métier lisible, on se rabat sur le site lui-même.
    if (metier.length >= 2) {
      const parMetier = await keywordIdeas(token, { keywordSeed: { keywords: metier.slice(0, 10) } });
      const known = new Set((raw || []).map((r) => r.text));
      raw = (raw || []).concat(parMetier.filter((r) => !known.has(r.text)));
    }
    if (!raw || raw.length < 10) {
      raw = await keywordIdeas(token, { siteSeed: { site: site.host } });
      if (raw.length < 10) raw = await keywordIdeas(token, { urlSeed: { url: site.url } });
      if (metier.length < 2) metier = [];
    }
  // 2e passe : élargir à partir des 3 recherches principales du métier (sans marque),
    // pour faire ressortir davantage de concurrents. En cas d'échec, on garde la 1re passe.
    const seeds = raw
      .filter((r) => !((r.keywordAnnotations || {}).concepts || []).some((c) => /BRAND/.test(c.conceptGroup?.type || "") && c.conceptGroup.type !== "NON_BRAND"))
      .filter((r) => !NEGATIFS.test(" " + norm(r.text).replace(/[^a-z0-9]+/g, " ") + " "))
      .filter((r) => !metier.length || pertinent(r.text, racines(metier)).fort)
      .sort((a, b) => Number(b.keywordIdeaMetrics?.avgMonthlySearches || 0) - Number(a.keywordIdeaMetrics?.avgMonthlySearches || 0))
      .slice(0, 3)
      .map((r) => r.text);
    if (seeds.length) {
      try {
        const more = await keywordIdeas(token, { keywordSeed: { keywords: seeds } });
        const known = new Set(raw.map((r) => r.text));
        raw = raw.concat(more.filter((r) => !known.has(r.text)));
      } catch (e) {
        console.error("analyse:seed2", site.host, String(e.message || e));
      }
    }
  } catch (e) {
    console.error("analyse", site.host, String(e.message || e));
    return json({ error: "L'analyse est momentanément indisponible. Réessayez dans quelques minutes." }, 502);
  }

  const neg = (k) => NEGATIFS.test(" " + norm(k.keyword).replace(/[^a-z0-9]+/g, " ") + " ");
  const all = dedupe(raw.map(toIdea).filter((k) => k.keyword && k.volume > 0 && !neg(k)));
  const rac = metier.length ? racines(metier) : null;
  // Recherche liée au métier : contient un mot porteur du métier (pas seulement un qualificatif).
  // Si le filtre est trop strict pour ce site (moins de 15 recherches), on le relâche.
  let duMetier = (k) => !rac || pertinent(k.keyword, rac).fort;
  if (rac && all.filter(duMetier).length < 15) duMetier = (k) => { const p = pertinent(k.keyword, rac); return p.fort || p.faible; };
  if (rac && all.filter(duMetier).length < 15) duMetier = () => true;
  if (all.length === 0) {
    return json({ site: site.host, empty: true, message: "Pas assez de données de recherche au Québec pour ce site." });
  }

  const brandSet = brandWords(site.host, all);
  const hostToken = norm(site.host.split(".")[0]).replace(/[^a-z0-9]/g, "");
  const isOwnName = (name) => {
    const n = norm(name).replace(/[^a-z0-9]/g, "");
    return n.length >= 3 && ((hostToken.includes(n) && n.length >= Math.max(4, Math.ceil(hostToken.length * 0.6))) || n.includes(hostToken) ||
      norm(name).split(/[^a-z0-9]+/).some((w) => brandSet.has(w)));
  };
  const isBrand = (k) =>
    norm(k.keyword).split(/[^a-z0-9]+/).some((w) => brandSet.has(w)) || k.brands.some(isOwnName);

  // Concurrents : marques repérées par Google dans les recherches du secteur (hors votre marque).
  // Google marque aussi des expressions génériques (« déménagement rive sud ») : on ne garde
  // que les noms qui contiennent un mot distinctif, rare dans l'ensemble des recherches.
  // Vocabulaire générique : concepts « Ville / Activité / Autres » de Google, mots les plus
  // fréquents du secteur et une liste de mots courants. Une marque réelle doit contenir
  // au moins un mot hors de ce vocabulaire (ex. « Transat », « Doyle », « La Capitale »).
  const GENERIC = new Set(("les des pour avec and the inc ltee cie chez aux sur une dans par mon ma mes son vos votre " +
    "petit petite grand grande pro professionnel professionnels expert experts express rapide efficace economique fiable " +
    "meilleur meilleure prix cout soumission soumissions devis avis service services entreprise compagnie " +
    "nord sud est ouest rive centre ville region distance longue grande local locale " +
    "piano equipement location camion boite boites carton cartons " +
    "monteregie laurentides lanaudiere estrie mauricie outaouais abitibi gaspesie saguenay beauce charlevoix " +
    "saint sainte paris france belgique suisse canada quebec montreal").split(" "));
  for (const k of all) {
    for (const g of k.generic) for (const w of norm(g).split(/[^a-z0-9]+/)) if (w) GENERIC.add(w);
  }
  // Un mot qui revient dans au moins 2 recherches sans marque est un mot du secteur, pas un nom.
  const nonBrandFreq = new Map();
  for (const k of all) {
    if (k.brands.length) continue;
    for (const w of new Set(norm(k.keyword).split(/[^a-z0-9]+/))) if (w) nonBrandFreq.set(w, (nonBrandFreq.get(w) || 0) + 1);
  }
  for (const [w, n] of nonBrandFreq) if (n >= 2) GENERIC.add(w);
  const isRealBrand = (name) =>
    norm(name).split(/[^a-z0-9]+/).some((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC.has(w));
  const titleCase = (s) => /^\S{2,3}$/.test(s) ? s.toUpperCase() : s.replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

  const compMap = new Map();
  for (const k of all) {
    if (isBrand(k)) continue;
    for (const name of new Set(k.brands)) {
      if (isOwnName(name) || !isRealBrand(name) || PAS_CONCURRENT.test(norm(name))) continue;
      // La recherche doit toucher le métier, ou n'être que le nom du concurrent.
      if (rac && !duMetier(k) && !pertinent(k.keyword, rac).faible && norm(k.keyword).replace(/[^a-z0-9]/g, "") !== norm(name).replace(/[^a-z0-9]/g, "")) continue;
      const e = compMap.get(name) || { nom: name, recherches: 0, motCle: k.keyword, top: 0 };
      e.recherches += k.volume;
      if (k.volume > e.top) { e.top = k.volume; e.motCle = k.keyword; }
      compMap.set(name, e);
    }
  }
  const concurrents = [...compMap.values()]
    .filter((c) => c.recherches >= 30)
    .sort((a, b) => b.recherches - a.recherches)
    .slice(0, 8)
    .map(({ nom, recherches, motCle }) => ({ nom: titleCase(nom), recherches, motCle }));

  const brand = all.filter(isBrand);
  // Le marché exclut votre marque et les recherches sur le nom d'un concurrent.
  const isCompetitorSearch = (k) => k.brands.some((n) => !isOwnName(n) && (isRealBrand(n) || PAS_CONCURRENT.test(norm(n))));
  // Recherches de produits (ex. « boîte de déménagement ») : forte concurrence mais clic bon marché = commerce en ligne.
  const isProduct = (k) => k.compIndex !== null && k.compIndex >= 67 && ((k.high !== null && k.high < 3.5) || (k.low !== null && k.low < 0.6));
  const market = all.filter((k) => duMetier(k) && !isBrand(k) && !isCompetitorSearch(k) && !isProduct(k)).sort((a, b) => b.volume - a.volume);
  if (!market.length) {
    return json({ site: site.host, empty: true, message: "Pas assez de recherches Google au Québec pour ce métier." });
  }
  const top = market.slice(0, 50);

  const totalVolume = top.reduce((s, k) => s + k.volume, 0);
  const withBids = top.filter((k) => k.low !== null && k.high !== null);
  const bidWeight = withBids.reduce((s, k) => s + k.volume, 0) || 1;
  const cpc = withBids.reduce((s, k) => s + ((k.low + k.high) / 2) * k.volume, 0) / bidWeight;
  const withComp = top.filter((k) => k.compIndex !== null);
  const compWeight = withComp.reduce((s, k) => s + k.volume, 0) || 1;
  const comp = withComp.reduce((s, k) => s + k.compIndex * k.volume, 0) / compWeight;

  const season = new Array(12).fill(0);
  for (const k of top) k.months.forEach((v, i) => { season[i] += v || 0; });
  const maxS = Math.max(...season), minS = Math.min(...season.filter((v) => v > 0));
  const peak = season.indexOf(maxS), low = season.indexOf(minS);

  // Score de potentiel /100 : volume (45), valeur commerciale du clic (30), concurrence (25).
  // Volume sur une échelle log de 100 à 50 000 recherches/mois ; CPC plafonné à 10 $.
  const sVolume = clamp((Math.log10(Math.max(totalVolume, 1)) - 2) / (Math.log10(50000) - 2)) * 45;
  const sValue = clamp(cpc / 10) * 30;
  const sComp = (1 - clamp(comp / 100)) * 25;
  const score = Math.round(sVolume + sValue + sComp);
  const scoreLabel = score >= 70 ? "Fort potentiel" : score >= 45 ? "Bon potentiel" : "Potentiel limité";

  // Budget de départ indicatif : environ 5 % des recherches converties en clics.
  const clicks = Math.round(totalVolume * 0.05);
  const budget = Math.max(300, Math.round((clicks * cpc) / 100) * 100);

  const fmtK = (k) => ({
    mot: k.keyword,
    volume: k.volume,
    cpcBas: k.low !== null ? round(k.low) : null,
    cpcHaut: k.high !== null ? round(k.high) : null,
    concurrence: compLabel(k.compIndex),
  });

  const opportunites = market
    .filter((k) => k.compIndex !== null && k.compIndex < 34 && k.volume >= 50)
    .slice(0, 8)
    .map(fmtK);

  // Répartitions pour les graphes
  const share = (groups) => {
    const tot = groups.reduce((t, g) => t + g.recherches, 0) || 1;
    return groups.filter((g) => g.recherches > 0).map((g) => ({ ...g, part: Math.round((g.recherches / tot) * 100) }));
  };
  const intentMap = new Map();
  for (const k of top) { const n = intention(k.keyword); intentMap.set(n, (intentMap.get(n) || 0) + k.volume); }
  const intentions = share([...intentMap].map(([nom, recherches]) => ({ nom, recherches })).sort((a, b) => b.recherches - a.recherches));
  const compMix = share(["Faible", "Moyenne", "Élevée"].map((nom) => ({
    nom, recherches: top.filter((k) => compLabel(k.compIndex) === nom).reduce((t, k) => t + k.volume, 0),
  })));
  const TRANCHES = [["Moins de 1 $", 0, 1], ["1 à 3 $", 1, 3], ["3 à 6 $", 3, 6], ["6 à 10 $", 6, 10], ["10 $ et plus", 10, 1e9]];
  const cpcMix = share(TRANCHES.map(([nom, a, b]) => ({
    nom, recherches: withBids.filter((k) => { const m = (k.low + k.high) / 2; return m >= a && m < b; }).reduce((t, k) => t + k.volume, 0),
  })));

  // Scénarios de budget à l'échelle d'une PME : petit marché 300 / 750 / 1 500 $, sinon 750 / 1 500 / 3 000 $.
  const budgets = budget < 1500 ? [300, 750, 1500] : [750, 1500, 3000];
  const estimer = (b) => {
    const cl = Math.min(Math.round(b / Math.max(cpc, 0.3)), Math.round(totalVolume * 0.12));
    return { budget: b, clics: cl, impressions: Math.round(cl / 0.05), cout: Math.min(b, Math.round(cl * cpc)), cpc: round(cpc), source: "estimation" };
  };
  const kwPrev = top.filter((k) => k.low !== null).slice(0, 20).map((k) => k.keyword);

  const [regRes, devRes, ...prevRes] = await Promise.allSettled([
    volumesParVille(token, top.slice(0, 20).map((k) => k.keyword)),
    appareils(token, top.slice(0, 20).map((k) => k.keyword)),
    ...budgets.map((b) => prevision(token, kwPrev, b)),
  ]);
  const regions = regRes.status === "fulfilled" ? regRes.value : [];
  if (regRes.status === "rejected") console.error("analyse:regions", site.host, String(regRes.reason?.message || regRes.reason));
  const devices = devRes.status === "fulfilled" ? devRes.value : [];
  if (devRes.status === "rejected") console.error("analyse:devices", site.host, String(devRes.reason?.message || devRes.reason));
  const scenarios = prevRes.map((p, i) => {
    if (p.status === "fulfilled") return p.value;
    console.error("analyse:forecast", site.host, String(p.reason?.message || p.reason));
    return estimer(budgets[i]);
  });

  return json({
    site: site.host,
    zone: "Québec",
    metier,
    langue: "français",
    apercu: {
      score,
      scoreLabel,
      recherchesMois: totalVolume,
      cpcMoyen: round(cpc),
      concurrence: compLabel(comp),
      concurrenceIndice: Math.round(comp),
      motsClesPhares: top.slice(0, 4).map(fmtK),
      concurrents: concurrents.slice(0, 5),
    },
    regions,
    graphes: { intentions, concurrence: compMix, cpc: cpcMix, appareils: devices },
    scenarios,
    rapport: {
      recherchesMarque: brand.reduce((s, k) => s + k.volume, 0),
      motsCles: top.slice(0, 15).map(fmtK),
      opportunites,
      concurrents,
      saisonnalite: season.map((v, i) => ({ mois: MOIS[i], recherches: v })),
      moisFort: MOIS[peak],
      moisFaible: MOIS[low],
      budgetIndicatif: budget,
      clicsEstimes: clicks,
      nbIdees: all.length,
    },
  });
};

export const config = { path: "/api/analyse" };
