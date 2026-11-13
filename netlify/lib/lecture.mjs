// Outils partagés par les fonctions d'audit : lecture sécurisée d'une page et détection du métier.

export const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Adresse publique uniquement : pas d'IP, pas de réseau interne, ports standard.
export function parseSite(input) {
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

// Lit une page HTML : 4 redirections au plus (chacune revalidée), 7 s, 1,5 Mo.
export async function lirePage(u, timeout = 7000) {
  let url = u;
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
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
    const reader = r.body.getReader();
    let size = 0;
    const chunks = [];
    while (size < 1_500_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { html: Buffer.concat(chunks).toString("utf8"), final: url, ms: Date.now() - t0, poids: size };
  }
  throw new Error("redirects");
}

export const decode = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;|&#8217;|&apos;/g, "'")
  .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à").replace(/&ccedil;/g, "ç")
  .replace(/&ecirc;/g, "ê").replace(/&ocirc;/g, "ô").replace(/&icirc;/g, "î").replace(/&ucirc;/g, "û")
  .replace(/&laquo;|&raquo;|&quot;|&#8211;|&#8212;|&ndash;|&mdash;/g, " | ")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, " ").trim();

// Mots vides et rubriques de navigation qui ne disent rien du métier.
const VIDES = new Set(("le la les l un une des du de d et ou a au aux en dans pour par sur avec sans chez nos notre votre vos " +
  "son sa ses leur leurs ce cet cette ces qui que quoi dont est sont vous nous on plus tres tout tous toute toutes " +
  "the and of for to in our your with").split(" "));
const RUBRIQUES = new Set([
  "accueil", "home", "contact", "contactez-nous", "contactez nous", "nous joindre", "joindre", "a propos", "a propos de nous",
  "qui sommes-nous", "qui sommes nous", "blogue", "blog", "nouvelles", "actualites", "carrieres", "carriere", "emplois", "emploi",
  "equipe", "notre equipe", "soumission", "demande de soumission", "demander une soumission", "soumission gratuite", "faq",
  "english", "francais", "fr", "en", "politique de confidentialite", "confidentialite", "menu", "realisations", "projets", "nos projets",
  "services", "nos services", "service", "en savoir plus", "lire la suite", "voir plus", "decouvrir", "temoignages", "avis",
  "clients", "nos clients", "partenaires", "mission", "valeurs", "histoire", "fermer", "rechercher", "recherche", "connexion",
  "mon compte", "panier", "boutique", "plan du site", "conditions", "mentions legales", "galerie", "photos", "videos",
  "ressources", "documentation", "telechargements", "evenements", "infolettre", "abonnez-vous", "suivez-nous", "facebook",
  "instagram", "linkedin", "youtube", "twitter", "appelez-nous", "ecrivez-nous", "prendre rendez-vous", "rendez-vous",
  "expertise", "nos expertises", "expertises", "approche", "notre approche", "portfolio", "portefeuille", "a propos", "equipe", "secteurs", "secteurs d'activite", "industries", "solutions", "nos solutions",
]);
const LIEUX = new Set(("quebec montreal laval gatineau longueuil sherbrooke levis saguenay terrebonne canada region province " +
  "rive-sud rive-nord sud nord monteregie laurentides lanaudiere estrie mauricie outaouais").split(" "));
// Mots trop larges pour définir un métier à eux seuls.
// Mots qui ne font pas un métier à eux seuls, mais qui peuvent en ouvrir un (« analyse de superficie »).
const GENERIQUES = new Set(("analyse analyses etude etudes approche mesure innovation innovant qualite performance excellence numerique " +
  "strategie strategies donnees data croissance transformation gestion planification developpement accompagnement optimisation " +
  "digital technologie technologies resultats succes valeur vision mission avenir impact efficacite").split(" "));
export const MOTS_LARGES = new Set(("service services entreprise entreprises compagnie professionnel professionnels expert experts " +
  "specialiste specialistes expertise expertises leader solution solutions qualite quebec montreal canada region travaux client clients projet projets " +
  "residentiel commercial industriel institutionnel gestion conseil conseils groupe inc ltee").split(" "));

// Détecte les métiers à partir du titre, de la description, des titres et du menu.
// Renvoie au plus 8 expressions, triées par importance.
export function extraireMetier(html, host, pagesServices = []) {
  const brand = norm(host.replace(/^www\./, "").split(".")[0]).replace(/[^a-z0-9]/g, "");
  const scores = new Map();
  const ajouter = (texte, poids) => {
    for (let seg of decode(texte).split(/[|–—·•:;,\/!?()«»"“”\[\]{}+]| - | et | & | ou /i)) {
      seg = seg.trim();
      // Mots d'origine (avec accents) et mots normalisés, alignés un à un.
      const orig = seg.split(/[\s'’]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
      let mots = orig.map((w) => norm(w).replace(/[^a-z0-9-]/g, ""));
      if (!mots.length || mots.some((w) => !w)) continue;
      // Nom de l'entreprise : on écarte tout le segment.
      if (brand.length >= 3 && mots.join("").includes(brand)) continue;
      // On retire en tête les mots vides et larges (« experts en »), en queue les mots vides et les lieux (« au Québec »).
      let i0 = 0, i1 = mots.length;
      while (i0 < i1 && (VIDES.has(mots[i0]) || MOTS_LARGES.has(mots[i0]))) i0++;
      while (i1 > i0 && (VIDES.has(mots[i1 - 1]) || LIEUX.has(mots[i1 - 1]))) i1--;
      mots = mots.slice(i0, i1);
      const o = orig.slice(i0, i1);
      if (!mots.length || mots.length > 6) continue;
      // Slogans adressés au client (« donner vie à vos projets ») : pas un métier.
      if (mots.some((w) => /^(vos|votre|vous|nous|notre|nos)$/.test(w))) continue;
      const n = mots.join(" ");
      if (n.length < 4 || n.length > 55 || RUBRIQUES.has(n) || /^\d/.test(n)) continue;
      const utiles = mots.filter((w) => w.length >= 4 && !VIDES.has(w) && !MOTS_LARGES.has(w) && !/^\d+$/.test(w));
      if (!utiles.length || utiles.every((w) => GENERIQUES.has(w))) continue;
      if (mots.length === 1 && n.length < 6) continue;
      // Forme affichée : accents d'origine, élisions recollées (« test d'étanchéité »).
      let affiche = "";
      o.forEach((w, k) => { affiche += w.toLowerCase() + (/^(l|d|qu|n|s|j|c)$/i.test(w) && k < o.length - 1 ? "'" : " "); });
      affiche = affiche.trim();
      const e = scores.get(n) || { cle: n, texte: affiche, score: 0 };
      e.score += poids;
      scores.set(n, e);
    }
  };
  const tous = (re) => [...html.matchAll(re)].map((m) => m[1]);
  const titre = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  ajouter(titre, 3);
  for (const c of tous(/<meta[^>]+(?:name|property)\s*=\s*["'](?:description|og:title|og:description)["'][^>]*content\s*=\s*["']([^"']*)["']/gi)) ajouter(c, 2);
  for (const c of tous(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*(?:name|property)\s*=\s*["'](?:description|og:title|og:description)["']/gi)) ajouter(c, 2);
  for (const c of tous(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) ajouter(c, 3);
  for (const c of tous(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)) ajouter(c, 2);
  for (const c of tous(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)) ajouter(c, 1);
  // Menu : liens dans <nav> et <header>, plus tout lien vers une page de service.
  for (const bloc of tous(/<(?:nav|header)[^>]*>([\s\S]*?)<\/(?:nav|header)>/gi)) {
    for (const a of bloc.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) ajouter(a[1], 2);
  }
  for (const a of html.matchAll(/<a[^>]+href\s*=\s*["'][^"']*\/(?:services?|expertises?|solutions?)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)) ajouter(a[1], 3);
  // Pages « Expertise », « Services »… : leurs titres et leurs cartes sont la liste des métiers.
  for (const ph of pagesServices) {
    const t = (re) => [...ph.matchAll(re)].map((m) => m[1]);
    for (const c of t(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) ajouter(c, 2);
    for (const c of t(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi)) ajouter(c, 4);
    for (const c of t(/<(?:div|span|p|a)[^>]+class\s*=\s*["'][^"']*(?:title|titre|heading|card|service|expertise)[^"']*["'][^>]*>([^<]{4,80})</gi)) ajouter(c, 3);
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.cle.length - b.cle.length)
    .filter((e, i, arr) => !arr.slice(0, i).some((p) => p.cle === e.cle))
    .slice(0, 12)
    .map((e) => e.texte);
}

// Recherches qui ne mènent jamais à un client (emploi, études, météo…) : exclues comme des mots-clés négatifs.
export const NEGATIFS = /\b(emploi|emplois|job|jobs|salaire|salaires|stage|stages|carriere|carrieres|offre d emploi|cours|formation|formations|universite|cegep|etudes|etudiant|diplome|meteo|wikipedia|definition|synonyme|pdf|memoire|these|examen|quiz|gratuit en ligne|youtube|reddit|kijiji|marketplace|indeed|jobboom|recrutement|benevolat|bourse|salary|hiring|career|careers|course|courses|training|weather|meaning|free download)\b/;

// Liens vers les pages qui décrivent les services (« Expertise », « Services », « Solutions »…), au plus 2.
const PAGE_SERVICES = /(expertises?|services?|solutions?|prestations|offres?|competences|domaines|savoir-faire|what-we-do|our-services)/i;
export function liensServices(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    const chemin = norm(decodeURIComponent(u.pathname)), texte = norm(decode(m[2]));
    if (u.pathname === "/" || /\.(pdf|jpg|png|zip)$/i.test(u.pathname)) continue;
    // Une page de premier niveau (/expertise, /services) : la page qui liste tous les services.
    const niveau = u.pathname.split("/").filter(Boolean).length;
    if (niveau > 2 || !(PAGE_SERVICES.test(chemin) || PAGE_SERVICES.test(texte))) continue;
    const href = u.origin + u.pathname;
    if (!out.some((x) => x.href === href)) out.push({ href, niveau });
  }
  return out.sort((a, b) => a.niveau - b.niveau).slice(0, 2).map((x) => x.href);
}

// Version anglaise du site : balise hreflang, ou lien « EN » / « English » dans l'en-tête.
export function lienAnglais(html, base) {
  const alt = html.match(/<link[^>]+hreflang\s*=\s*["']en(?:-[a-z]+)?["'][^>]*href\s*=\s*["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*hreflang\s*=\s*["']en(?:-[a-z]+)?["']/i);
  const tests = [];
  if (alt) tests.push(alt[1]);
  for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = norm(decode(m[2])).trim();
    if (/^(en|english|anglais|eng)$/.test(t) || /^\/en(\/|$)/.test(m[1])) tests.push(m[1]);
  }
  for (const h of tests) {
    try {
      const u = new URL(h, base);
      if (u.hostname.replace(/^www\./, "").split(".").slice(-2).join(".") === base.hostname.replace(/^www\./, "").split(".").slice(-2).join(".")) return u.href;
    } catch {}
  }
  return null;
}
