// Étape d'intelligence de l'audit : Claude comprend le métier du site, puis trie les mots-clés
// renvoyés par Keyword Planner. Les chiffres restent ceux de Google ; Claude ne fait que juger.
// Accès par l'AI Gateway de Netlify : ANTHROPIC_API_KEY et ANTHROPIC_BASE_URL sont injectées par Netlify.

import { estBruit, sansLieux } from "./filtre.mjs";

export const MODELE_COMPRENDRE = process.env.AUDIT_MODELE || "claude-sonnet-5-5";
export const MODELE_TRIER = process.env.AUDIT_MODELE_TRI || "claude-sonnet-5-5";

// Repli : si Netlify n'injecte pas ANTHROPIC_*, on utilise les variables de l'AI Gateway, toujours définies.
const cleIA = () => process.env.ANTHROPIC_API_KEY || process.env.NETLIFY_AI_GATEWAY_KEY || "";
const baseIA = () => process.env.ANTHROPIC_API_KEY
  ? (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com")
  : process.env.NETLIFY_AI_GATEWAY_BASE_URL ? process.env.NETLIFY_AI_GATEWAY_BASE_URL.replace(/\/$/, "") + "/anthropic" : "";
export const iaDisponible = () => Boolean(cleIA() && baseIA());

let temperatureRefusee = false;

async function appelClaude({ model, system, user, maxTokens = 1500, timeoutMs = 8000 }) {
  const base = baseIA().replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const envoyer = (avecTemperature) => fetch(base + "/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cleIA(),
        authorization: "Bearer " + cleIA(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }],
        ...(avecTemperature ? { temperature: 0 } : {}),
        ...(process.env.AUDIT_REFLEXION === "on" ? {} : { thinking: { type: "between_tools" } }) }),
    });
    // Température 0 : des réponses aussi constantes que possible. Si le modèle la refuse, on réessaie sans.
    let r = await envoyer(process.env.AUDIT_TEMPERATURE !== "off" && !temperatureRefusee);
    if (r.status === 400) {
      const txt = await r.clone().text();
      if (/temperature/i.test(txt)) { temperatureRefusee = true; r = await envoyer(false); }
    }
    if (!r.ok) throw new Error("ia:" + r.status + ":" + (await r.text()).slice(0, 200));
    const j = await r.json();
    if (process.env.AUDIT_DEBUG) console.log("ia", model, j.usage, j.stop_reason);
    const txt = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("ia:json:" + (j.stop_reason || ""));
    try { return JSON.parse(m[0]); } catch (e) { throw new Error("ia:json:" + (j.stop_reason || "") + ":" + e.message); }
  } finally {
    clearTimeout(t);
  }
}

// Texte lisible d'une page : titres et paragraphes, sans scripts ni styles.
export function texteDePage(html, max = 6000) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|iframe|footer|address)[\s\S]*?<\/\1>/gi, " ")
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
- Ignore l'adresse, la ville du siège social, le pied de page, les coordonnées et les noms de lieux : ils ne décrivent pas un service. N'en tire jamais une recherche.
- Au plus 8 services. Pour chaque service, donne 3 à 4 recherches COURTES en français (2 à 3 mots), le terme principal tel qu'un client le tape, sans ville ni prix : ex. « drain français », « fissure fondation », « réparation fondation », « licence rbq », « photographe drone ». Keyword Planner élargira lui-même vers les variantes (prix, ville, soumission).
- Donne TOUJOURS 2 recherches courtes en anglais par service (ex. « foundation repair », « french drain »), que le site soit en français ou en anglais : le marché québécois cherche dans les deux langues. Les recherches en français sont aussi toujours données, même si le site est en anglais.
- Chaque recherche décrit un service vendu : jamais un nom de ville, de lieu ou de commerce seul (« hôtel », « Boucherville »).
- Une recherche doit toujours être liée au secteur : jamais un mot seul ambigu (« acquisition », « sécurité », « pyrite » seul, « fondation » seul). Préfère le vocabulaire courant du client au jargon du site.
- Liste les sens parasites à exclure : produits vendus en quincaillerie, travaux à faire soi-même, homonymes (ex. « fondation » au sens d'organisme de charité), emplois, définitions.
- N'invente rien : si le site ne le dit pas, laisse le champ vide.
- Sois bref : chaque texte en quelques mots, au plus 8 éléments dans « exclure ».

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
    maxTokens: 3500,
    timeoutMs,
  });
  // Nettoyage : on garde une structure sûre et bornée.
  const str = (v, n = 120) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const arr = (v, n, m = 80) => (Array.isArray(v) ? v : []).map((x) => str(x, m)).filter(Boolean).slice(0, n);
  const depart = (a, n) => [...new Set(a.map(sansLieux))].filter((x) => x && !estBruit(x, { metier: p.metier, secteur: p.secteur, services: [] })).slice(0, n);
  return {
    entreprise: str(p.entreprise),
    metier: str(p.metier),
    secteur: str(p.secteur),
    clientele: str(p.clientele, 200),
    zone: str(p.zone),
    atouts: arr(p.atouts, 6, 120),
    services: (Array.isArray(p.services) ? p.services : []).slice(0, 10).map((s) => ({
      nom: str(s.nom, 60), fr: depart(arr(s.fr, 8), 6), en: depart(arr(s.en, 6), 3),
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
  const depart = (a, n) => [...new Set(a.map(sansLieux))].filter((x) => x && !estBruit(x, { metier: p.metier, secteur: p.secteur, services: [] })).slice(0, n);
  const services = p.services.slice(0, 10).map((s) => ({ nom: str(s && s.nom, 60), fr: depart(arr(s && s.fr, 8), 6), en: depart(arr(s && s.en, 6), 3) }))
    .filter((s) => s.nom && s.fr.length);
  if (!services.length) return null;
  return {
    entreprise: str(p.entreprise), metier: str(p.metier), secteur: str(p.secteur), clientele: str(p.clientele, 200),
    zone: str(p.zone), atouts: arr(p.atouts, 6, 120), services, exclure: arr(p.exclure, 15, 100),
    concurrents_attendus: str(p.concurrents_attendus, 200),
    deja: p.deja && typeof p.deja === "object" ? {
      pagesService: Math.min(20, Number(p.deja.pagesService) || 0),
      formulaireSurPagesService: Math.min(20, Number(p.deja.formulaireSurPagesService) || 0),
      telephoneCliquable: Boolean(p.deja.telephoneCliquable),
      versionAnglaise: Boolean(p.deja.versionAnglaise),
    } : null,
  };
}

const SYSTEME_TRIER = `Tu es un analyste Google Ads senior au Québec. On te donne le profil d'une entreprise et une liste numérotée de recherches Google (avec leur volume mensuel).
Pour chaque recherche, pose-toi UNE seule question : « la personne qui tape ça cherche-t-elle à acheter ou à demander un des services de CETTE entreprise (numérotés dans le profil) ? ». Si ce n'est pas clairement oui, rejette. En cas de doute, rejette.

Garde seulement :
- une recherche qui nomme un service du profil, ou le besoin précis que ce service règle ;
- une recherche qui mêle un service et un lieu (ex. « forage Boucherville », « déménageur Montréal ») : le lieu est utile s'il accompagne un service.
Une recherche liée à un service du profil reste gardée même avec « gratuit », « free », « prix », « modèle » ou « générateur » (ex. « création de logo gratuite », « créer un site web gratuit ») : c'est un intérêt réel pour le service, qu'on traitera ensuite avec des mots-clés négatifs. Des variantes de la même recherche (accents, singulier/pluriel, anglais/français : « scie à béton », « scie a beton », « sciage de béton ») reçoivent la même décision.
Rejette toujours :
- une recherche qui n'est qu'un lieu, une ville, un commerce ou un service public (ex. « Boucherville », « hôtel de ville », « hôtel », « restaurant ») : elle n'exprime aucun besoin lié aux services de l'entreprise ;
- les produits vendus en magasin ou à faire soi-même, les homonymes et sens parasites, les recherches d'emploi, de définition ou de formation générale, les autres secteurs, les recherches trop vagues pour être liées au métier, les noms de marques ;
- un terme large très recherché qui mélange surtout des intentions de bricolage ou d'achat de produit (ex. « pieux vissés » pour un patio, « vide sanitaire » pour l'isolation), sauf si la recherche précise le service de l'entreprise (ex. « pieux fondation maison »).
Un mot ou une recherche en anglais se juge de la même façon qu'un mot français.
On te donne aussi une liste de noms repérés par Google comme marques : indique lesquels sont de vrais concurrents (entreprises qui vendent le même service), et non des magasins, des organismes publics, des fabricants de produits ou des médias.
Pour chaque recherche, dans l'ordre, donne le numéro du service de l'entreprise auquel elle correspond (services numérotés à partir de 0), ou -1 pour la rejeter.
Réponds uniquement avec ce JSON, sans aucune explication ni texte autour : {"s":[un nombre par recherche],"concurrents":["noms exacts"]}`;

async function trierLot({ resume, mots, decalage, marques, timeoutMs }) {
  const liste = mots.map((k, i) => `${i}. ${k.keyword} (${k.volume})`).join("\n");
  const r = await appelClaude({
    model: MODELE_TRIER,
    system: SYSTEME_TRIER,
    user: `${resume}\n\nRecherches :\n${liste}\n\nMarques repérées : ${marques.join(" ; ") || "aucune"}`,
    maxTokens: 4000,
    timeoutMs,
  });
  if (!Array.isArray(r.s)) throw new Error("ia:format");
  const service = new Map();
  mots.forEach((_, i) => { const n = Number(r.s[i]); service.set(i + decalage, Number.isInteger(n) ? n : -1); });
  return { service, concurrents: Array.isArray(r.concurrents) ? r.concurrents : [] };
}

// Tri en paquets de 50, en parallèle : plus rapide qu'une seule longue liste.
export async function trierMotsCles({ profil, mots, marques, timeoutMs = 6000 }) {
  const resume = `Entreprise : ${profil.entreprise || "?"} — métier : ${profil.metier}. Secteur : ${profil.secteur}. Clientèle : ${profil.clientele}.
Services : ${profil.services.map((s, i) => i + ". " + s.nom).join(" ; ")}.
À exclure : ${profil.exclure.join(" ; ") || "—"}.`;
  const lots = [];
  for (let i = 0; i < mots.length; i += 50) lots.push(trierLot({ resume, mots: mots.slice(i, i + 50), decalage: i, marques: i === 0 ? marques : [], timeoutMs }));
  const res = await Promise.allSettled(lots);
  if (res.every((r) => r.status === "rejected")) throw res[0].reason;
  // Un paquet en échec : ses recherches ne sont pas jugées (incertaines), l'appelant décide.
  const incertains = new Set();
  res.forEach((r, j) => { if (r.status === "rejected") for (let i = j * 50; i < Math.min(mots.length, j * 50 + 50); i++) incertains.add(i); });
  const ok = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const service = new Map(ok.flatMap((r) => [...r.service]));
  const nS = profil.services.length;
  const garder = new Set(mots.map((_, i) => i).filter((i) => !incertains.has(i) && service.has(i) && service.get(i) >= 0 && service.get(i) < nS));
  const concurrents = new Set(ok.flatMap((r) => r.concurrents).map((x) => String(x).toLowerCase().trim()));
  return { garder, concurrents, incertains, service };
}

// Rédaction des sections « Ce que je remarque » et « Budget indicatif », à partir des chiffres de Google
// et du guide de bonnes pratiques d'Expert 360. Claude ne crée aucun chiffre de marché.
const SYSTEME_REDIGER = `Tu es un expert Google Ads senior d'Expert 360 (Québec). Tu rédiges, en français, deux sections d'un audit Google Ads pour un prospect, à partir de son profil et des chiffres de Google Keyword Planner qu'on te donne.

Bonnes pratiques d'Expert 360 à appliquer :
- Pages de destination dédiées par service (formulaire court sur la page, bouton d'appel, sans menu), jamais la page d'accueil. Si le site a déjà des pages de service, ne dis pas « il vous faut des pages » : propose de les décliner en pages de soumission.
- Ciblage géographique : ne pas restreindre trop étroitement (le CPC flambe) ; élargir si le marché est concurrentiel.
- Démarrage des enchères en « Maximiser les clics » avec plafond de CPC, 2 à 3 semaines d'apprentissage ; CPA cible seulement après 15 à 30 conversions par mois.
- Suivi : appels réels et entrées dans le CRM, pas seulement les conversions Google (la bannière Loi 25 en masque 40 à 60 %).
- Mots-clés négatifs dès le départ ; concordance exacte et expression en priorité.
- Campagne de marque seulement si le nom est cherché ou attaqué par des concurrents.
- Budget qui suit la saisonnalité ; pas de variation de plus de 15 à 20 % d'un coup.

Règles d'écriture :
- Chaque observation : un titre court en gras d'idée (champ "titre") et une ou deux phrases concrètes (champ "texte"), appuyées sur les chiffres fournis. Ton direct, professionnel, sans jargon inutile, sans promesse de résultat.
- N'invente aucun volume ni CPC : utilise seulement ceux fournis. Les montants de budget sont des estimations raisonnables à partir des CPC et volumes fournis.
- Ne recommande pas ce que l'entreprise a déjà (voir « déjà en place »).
- 5 observations, chacune en 2 phrases au plus.
- Budget : un budget de DÉMARRAGE réaliste pour une PME québécoise, qui vise une part des recherches qualifiées (pas leur totalité). Calcule environ 25 à 40 % des recherches × 5 % de clics × CPC moyen, arrondis ; le total se situe d'habitude entre 1 000 et 4 000 $ par mois. Concentre le budget sur les services à fort volume ; un service à moins de 100 recherches par mois n'a pas de campagne seule.
- Mots-clés négatifs : jamais un terme qui décrit un service de l'entreprise, ni une langue que le site sert (si le site a une version anglaise, n'exclus pas les recherches en anglais). Un budget par campagne (2 à 4 campagnes, regroupant les services), avec une fourchette mensuelle et l'ajustement saisonnier. 6 à 12 mots-clés négatifs. Inclure au départ les termes d'intention non commerciale (« gratuit », « free », « modèle », « template », « emploi », « cours »), sauf si l'entreprise les vend ; ils filtrent les recherches « gratuites » qui restent dans les volumes.

Réponds uniquement en JSON, sans texte autour :
{"observations":[{"titre":"","texte":""}],"budget":[{"campagne":"","min":0,"max":0,"saison":""}],"budget_note":"","negatifs":[""]}`;

export async function redigerAudit({ donnees, timeoutMs = 20000 }) {
  const r = await appelClaude({ model: MODELE_COMPRENDRE, system: SYSTEME_REDIGER, user: JSON.stringify(donnees), maxTokens: 3000, timeoutMs });
  const str = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const num = (v) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  return {
    observations: (Array.isArray(r.observations) ? r.observations : []).slice(0, 7)
      .map((o) => ({ titre: str(o && o.titre, 90), texte: str(o && o.texte, 420) })).filter((o) => o.titre && o.texte),
    budget: (Array.isArray(r.budget) ? r.budget : []).slice(0, 5)
      .map((b) => ({ campagne: str(b && b.campagne, 90), min: num(b && b.min), max: num(b && b.max), saison: str(b && b.saison, 120) })).filter((b) => b.campagne && b.max),
    budget_note: str(r.budget_note, 500),
    negatifs: (Array.isArray(r.negatifs) ? r.negatifs : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 15),
  };
}
