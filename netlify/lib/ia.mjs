// Étape d'intelligence de l'audit : Claude comprend le métier du site, puis trie les mots-clés
// renvoyés par Keyword Planner. Les chiffres restent ceux de Google ; Claude ne fait que juger.
// Accès par l'AI Gateway de Netlify : ANTHROPIC_API_KEY et ANTHROPIC_BASE_URL sont injectées par Netlify.

export const MODELE_COMPRENDRE = process.env.AUDIT_MODELE || "claude-sonnet-5-5";
export const MODELE_TRIER = process.env.AUDIT_MODELE_TRI || "claude-haiku-5-5";

export const iaDisponible = () => Boolean(process.env.ANTHROPIC_API_KEY);

async function appelClaude({ model, system, user, maxTokens = 1500, timeoutMs = 8000 }) {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + "/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) throw new Error("ia:" + r.status + ":" + (await r.text()).slice(0, 200));
    const j = await r.json();
    const txt = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("ia:json");
    return JSON.parse(m[0]);
  } finally {
    clearTimeout(t);
  }
}

// Texte lisible d'une page : titres et paragraphes, sans scripts ni styles.
export function texteDePage(html, max = 6000) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(h[1-4])[^>]*>/gi, "\n## ")
    .replace(/<(br|p|li|div|section|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&rsquo;/g, "’").replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
    .slice(0, max);
}

const SYSTEME_COMPRENDRE = `Tu es un analyste Google Ads senior au Québec. On te donne le texte du site web d'une entreprise.
Ta tâche : comprendre son métier comme le ferait un expert humain, puis préparer les recherches à envoyer à Google Keyword Planner.

Règles :
- Décris ce que l'entreprise VEND réellement, pas les mots de son slogan ni les rubriques de son site (contact, blogue, carrière, adresse, confidentialité).
- Liste chaque service vendu séparément, avec le vocabulaire qu'un client québécois taperait dans Google (ex. « drain français », « réparation fissure fondation », « formation licence RBQ »).
- Pour chaque service, propose 3 à 6 recherches en français, avec une intention d'achat (service, prix, soumission, ville), et 2 à 3 recherches en anglais si le site a une clientèle anglophone.
- Une recherche doit toujours être liée au secteur : jamais un mot seul ambigu (« acquisition », « sécurité », « pyrite » seul, « fondation » seul).
- Liste les sens parasites à exclure : produits vendus en quincaillerie, travaux à faire soi-même, homonymes (ex. « fondation » au sens d'organisme de charité), emplois, définitions.
- N'invente rien : si le site ne le dit pas, laisse le champ vide.

Réponds uniquement en JSON, sans texte autour :
{"entreprise":"","metier":"libellé court du métier","secteur":"","clientele":"","zone":"","atouts":[""],
 "services":[{"nom":"","fr":[""],"en":[""]}],
 "exclure":["sens ou mots à exclure"],"concurrents_attendus":"type d'entreprises concurrentes réelles"}`;

export async function comprendreSite({ host, pages, timeoutMs = 9000 }) {
  const corps = pages.map((p) => `### Page : ${p.url}\n${p.texte}`).join("\n\n").slice(0, 16000);
  const p = await appelClaude({
    model: MODELE_COMPRENDRE,
    system: SYSTEME_COMPRENDRE,
    user: `Site : ${host}\n\n${corps}`,
    maxTokens: 1800,
    timeoutMs,
  });
  // Nettoyage : on garde une structure sûre et bornée.
  const str = (v, n = 120) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const arr = (v, n, m = 80) => (Array.isArray(v) ? v : []).map((x) => str(x, m)).filter(Boolean).slice(0, n);
  return {
    entreprise: str(p.entreprise),
    metier: str(p.metier),
    secteur: str(p.secteur),
    clientele: str(p.clientele, 200),
    zone: str(p.zone),
    atouts: arr(p.atouts, 6, 120),
    services: (Array.isArray(p.services) ? p.services : []).slice(0, 10).map((s) => ({
      nom: str(s.nom, 60), fr: arr(s.fr, 6), en: arr(s.en, 3),
    })).filter((s) => s.nom && s.fr.length),
    exclure: arr(p.exclure, 15, 100),
    concurrents_attendus: str(p.concurrents_attendus, 200),
  };
}

// Valide un profil reçu du navigateur (il a été produit par comprendreSite, mais on ne lui fait pas confiance).
export function profilValide(p) {
  if (!p || typeof p !== "object" || !Array.isArray(p.services)) return null;
  const str = (v, n = 120) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const arr = (v, n, m = 80) => (Array.isArray(v) ? v : []).map((x) => str(x, m)).filter(Boolean).slice(0, n);
  const services = p.services.slice(0, 10).map((s) => ({ nom: str(s && s.nom, 60), fr: arr(s && s.fr, 6), en: arr(s && s.en, 3) }))
    .filter((s) => s.nom && s.fr.length);
  if (!services.length) return null;
  return {
    entreprise: str(p.entreprise), metier: str(p.metier), secteur: str(p.secteur), clientele: str(p.clientele, 200),
    zone: str(p.zone), atouts: arr(p.atouts, 6, 120), services, exclure: arr(p.exclure, 15, 100),
    concurrents_attendus: str(p.concurrents_attendus, 200),
  };
}

const SYSTEME_TRIER = `Tu es un analyste Google Ads senior au Québec. On te donne le profil d'une entreprise et une liste numérotée de recherches Google (avec leur volume mensuel).
Garde uniquement les recherches qu'un client potentiel de CETTE entreprise ferait pour acheter un de SES services.
Rejette : les produits vendus en magasin ou à faire soi-même, les homonymes et sens parasites, les recherches d'emploi ou de définition, les autres secteurs, les recherches trop vagues pour être liées au métier, les noms de marques.
On te donne aussi une liste de noms repérés par Google comme marques : indique lesquels sont de vrais concurrents (entreprises qui vendent le même service), et non des magasins, des organismes publics, des fabricants de produits ou des médias.
Réponds uniquement en JSON : {"garder":[numéros],"concurrents":["noms exacts"]}`;

export async function trierMotsCles({ profil, mots, marques, timeoutMs = 6000 }) {
  const resume = `Entreprise : ${profil.entreprise || "?"} — métier : ${profil.metier}. Secteur : ${profil.secteur}. Clientèle : ${profil.clientele}.
Services : ${profil.services.map((s) => s.nom).join(" ; ")}.
À exclure : ${profil.exclure.join(" ; ") || "—"}.`;
  const liste = mots.map((k, i) => `${i}. ${k.keyword} (${k.volume})`).join("\n");
  const r = await appelClaude({
    model: MODELE_TRIER,
    system: SYSTEME_TRIER,
    user: `${resume}\n\nRecherches :\n${liste}\n\nMarques repérées : ${marques.join(" ; ") || "aucune"}`,
    maxTokens: 1500,
    timeoutMs,
  });
  const garder = new Set((Array.isArray(r.garder) ? r.garder : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < mots.length));
  const concurrents = new Set((Array.isArray(r.concurrents) ? r.concurrents : []).map((x) => String(x).toLowerCase().trim()));
  return { garder, concurrents };
}
