// Outil d'audit Google Ads — expert-360.ca
// POST /api/analyse  { "url": "https://exemple.ca" }
// Renvoie : score de potentiel, volumes, CPC, concurrence, saisonnalité, mots-clés.
// Les identifiants viennent des variables d'environnement Netlify (jamais du code).

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
    const key = [k.volume, k.compIndex, k.low, k.high, k.months.join(",")].join("|");
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
    if (token.includes(w) && n / ideas.length < 0.15) brand.add(w);
  }
  if (token.length >= 3 && !freq.has(token)) brand.add(token);
  return brand;
}

const compLabel = (i) => (i === null ? "Inconnue" : i < 34 ? "Faible" : i < 67 ? "Moyenne" : "Élevée");
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non permise." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
  const site = parseSite(body.url);
  if (!site) return json({ error: "Adresse de site invalide. Exemple : votresite.ca" }, 400);

  let raw;
  try {
    const token = await getAccessToken();
    raw = await keywordIdeas(token, { siteSeed: { site: site.host } });
    if (raw.length < 10) raw = await keywordIdeas(token, { urlSeed: { url: site.url } });
    // 2e passe : élargir à partir des 3 recherches principales du secteur (sans marque),
    // pour faire ressortir davantage de concurrents. En cas d'échec, on garde la 1re passe.
    const seeds = raw
      .filter((r) => !((r.keywordAnnotations || {}).concepts || []).some((c) => /BRAND/.test(c.conceptGroup?.type || "") && c.conceptGroup.type !== "NON_BRAND"))
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

  const all = dedupe(raw.map(toIdea).filter((k) => k.keyword && k.volume > 0));
  if (all.length === 0) {
    return json({ site: site.host, empty: true, message: "Pas assez de données de recherche au Québec pour ce site." });
  }

  const brandSet = brandWords(site.host, all);
  const hostToken = norm(site.host.split(".")[0]).replace(/[^a-z0-9]/g, "");
  const isOwnName = (name) => {
    const n = norm(name).replace(/[^a-z0-9]/g, "");
    return n.length >= 3 && (hostToken.includes(n) || n.includes(hostToken) ||
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
      if (isOwnName(name) || !isRealBrand(name)) continue;
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
  const isCompetitorSearch = (k) => k.brands.some((n) => !isOwnName(n) && isRealBrand(n));
  // Recherches de produits (ex. « boîte de déménagement ») : forte concurrence mais clic bon marché = commerce en ligne.
  const isProduct = (k) => k.compIndex !== null && k.compIndex >= 67 && k.high !== null && k.high < 3.5;
  const market = all.filter((k) => !isBrand(k) && !isCompetitorSearch(k) && !isProduct(k)).sort((a, b) => b.volume - a.volume);
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
    .slice(0, 6)
    .map(fmtK);

  return json({
    site: site.host,
    zone: "Québec",
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
