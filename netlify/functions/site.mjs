// Outil d'audit Google Ads — expert-360.ca
// POST /api/site  { "url": "https://exemple.ca" }
// Lit la page d'accueil et vérifie si le site est prêt pour la publicité :
// balises de suivi, conversions, mobile, HTTPS, titre, description, appel, formulaire, temps de réponse.

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function parseSite(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h.length > 253) return null;
    if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[") || h.includes(":")) return null;
    if (u.port && u.port !== "80" && u.port !== "443") return null;
    return u;
  } catch {
    return null;
  }
}

// Suit au plus 4 redirections, en revalidant chaque adresse (pas d'IP, pas de réseau interne).
async function lire(u) {
  let url = u, t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(7000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Expert360-Audit/1.0; +https://expert-360.ca/audit-google-ads)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.6",
      },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      const next = parseSite(new URL(r.headers.get("location"), url).href);
      if (!next) throw new Error("redirect");
      url = next;
      continue;
    }
    if (!r.ok) throw new Error("http:" + r.status);
    // On lit au plus 1,5 Mo
    const reader = r.body.getReader();
    let size = 0, chunks = [];
    while (size < 1_500_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { html, final: url, ms: Date.now() - t0, poids: size };
  }
  throw new Error("redirects");
}

const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non permise." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
  const u = parseSite(body.url);
  if (!u) return json({ error: "Adresse invalide." }, 400);

  let page;
  try {
    page = await lire(new URL(u.origin + "/"));
  } catch (e) {
    console.error("site", u.hostname, String(e.message || e));
    return json({ ok: false, message: "Votre site bloque les lectures automatiques : la vérification se fera à la main dans le rapport." });
  }
  const h = page.html;
  const has = (re) => re.test(h);

  const ads = has(/AW-\d{6,}/);
  const gtm = has(/GTM-[A-Z0-9]{4,}/);
  const ga4 = has(/['"]G-[A-Z0-9]{6,}['"]/) || has(/gtag\/js\?id=G-/);
  const conv = has(/send_to['"]?\s*:\s*['"]AW-\d+\/[\w-]+/) || has(/['"]event['"]\s*,\s*['"]conversion['"]/);
  const meta = has(/connect\.facebook\.net\/[^"']*fbevents\.js/) || has(/fbq\(\s*['"]init['"]/);
  const linkedin = has(/snap\.licdn\.com|_linkedin_partner_id/);
  const bing = has(/bat\.bing\.com/);
  const tel = has(/href\s*=\s*["']tel:/i);
  const form = has(/<form[\s>]/i);
  const viewport = has(/<meta[^>]+name\s*=\s*["']viewport["']/i);
  const title = strip((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const desc = ((h.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i) ||
    h.match(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i) || [])[1] || "").trim();
  const h1 = (h.match(/<h1[\s>]/gi) || []).length;
  const https = page.final.protocol === "https:";

  const viaGtm = " Si vous passez par Google Tag Manager, elle peut y être sans être visible dans la page.";
  const verifs = [
    {
      nom: "Balise Google Ads",
      statut: ads ? "ok" : gtm ? "warn" : "bad",
      detail: ads ? "Installée : Google peut mesurer vos visites issues de la pub." :
        "Introuvable dans la page." + (gtm ? viaGtm : " Sans elle, impossible de savoir quelles annonces rapportent."),
    },
    {
      nom: "Suivi des conversions",
      statut: conv ? "ok" : (ads || gtm) ? "warn" : "bad",
      detail: conv ? "Un événement de conversion Google Ads est déclaré." :
        "Aucune conversion détectée sur l'accueil (appel, formulaire, achat). C'est la donnée qui permet à Google d'optimiser vos enchères.",
    },
    {
      nom: "Google Analytics 4",
      statut: ga4 ? "ok" : gtm ? "warn" : "bad",
      detail: ga4 ? "Installé." : "Introuvable dans la page." + (gtm ? viaGtm : " Vous ne voyez pas d'où viennent vos visiteurs."),
    },
    { nom: "Google Tag Manager", statut: gtm ? "ok" : "warn", detail: gtm ? "Installé : les balises se gèrent sans toucher au code." : "Absent. Pas bloquant, mais il simplifie l'ajout des suivis." },
    { nom: "Pixel Meta (Facebook, Instagram)", statut: meta ? "ok" : "warn", detail: meta ? "Installé : vous pouvez recibler vos visiteurs." : "Absent : impossible de recibler vos visiteurs sur Facebook et Instagram." },
    { nom: "Bouton d'appel cliquable", statut: tel ? "ok" : "bad", detail: tel ? "Présent : un mobile peut vous appeler en un geste." : "Aucun numéro cliquable : sur mobile, chaque appel perdu est un client perdu." },
    { nom: "Formulaire sur l'accueil", statut: form ? "ok" : "warn", detail: form ? "Présent." : "Aucun formulaire sur l'accueil : la page d'arrivée de vos annonces doit en avoir un." },
    { nom: "Version mobile", statut: viewport ? "ok" : "bad", detail: viewport ? "La page s'adapte aux téléphones." : "La page ne déclare pas d'affichage mobile." },
    { nom: "Connexion sécurisée (HTTPS)", statut: https ? "ok" : "bad", detail: https ? "Oui." : "Non : Chrome affiche « Non sécurisé », la confiance chute." },
    {
      nom: "Titre de la page",
      statut: title.length >= 25 && title.length <= 65 ? "ok" : title ? "warn" : "bad",
      detail: title ? "« " + title.slice(0, 90) + " » (" + title.length + " caractères, idéal 25 à 65)." : "Aucun titre.",
    },
    {
      nom: "Description pour Google",
      statut: desc.length >= 70 && desc.length <= 165 ? "ok" : desc ? "warn" : "bad",
      detail: desc ? desc.length + " caractères (idéal 70 à 160)." : "Aucune description : Google en invente une.",
    },
    { nom: "Titre principal (H1)", statut: h1 === 1 ? "ok" : "warn", detail: h1 === 1 ? "Un seul H1, c'est parfait." : h1 + " titre(s) H1 sur la page (idéal : un seul)." },
    {
      nom: "Temps de réponse du serveur",
      statut: page.ms < 1200 ? "ok" : page.ms < 3000 ? "warn" : "bad",
      detail: (page.ms / 1000).toFixed(1).replace(".", ",") + " s pour recevoir la page" + (page.ms < 1200 ? "." : " : chaque seconde de plus fait fuir des visiteurs payés."),
    },
  ];
  // Le suivi pèse plus lourd : sans lui, la pub dépense à l'aveugle.
  const POIDS = { "Balise Google Ads": 3, "Suivi des conversions": 3, "Google Analytics 4": 2 };
  let pts = 0, max = 0;
  for (const v of verifs) {
    const w = POIDS[v.nom] || 1;
    max += w; pts += w * (v.statut === "ok" ? 1 : v.statut === "warn" ? 0.4 : 0);
  }

  return json({
    ok: true,
    site: page.final.hostname.replace(/^www\./, ""),
    score: Math.round((pts / max) * 100),
    aCorriger: verifs.filter((v) => v.statut !== "ok").length,
    autres: { linkedin, bing },
    verifs,
  });
};

export const config = { path: "/api/site" };
