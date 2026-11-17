// Audit Google Ads — étape 1 : comprendre le métier du site avec Claude.
// POST /api/comprendre  { "url": "exemple.ca" }  →  { profil }
import { lirePage, liensServices, lienAnglais, parseSite } from "../lib/lecture.mjs";
import { comprendreSite, texteDePage, iaDisponible } from "../lib/ia.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const CHEMINS = ["/services", "/nos-services", "/expertise", "/expertises", "/solutions"];

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non permise." }, 405);
  const origine = req.headers.get("origin") || req.headers.get("referer") || "";
  if (origine && !/^https:\/\/([a-z0-9-]+\.)*(expert-360\.ca|netlify\.app)(\/|$)/i.test(origine)) return json({ error: "Origine refusée." }, 403);
  if (!iaDisponible()) return json({ error: "ia-indisponible" }, 503);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
  const u = parseSite(body.url);
  if (!u) return json({ error: "Adresse de site invalide. Exemple : votresite.ca" }, 400);
  const site = { host: u.hostname.replace(/^www\./, ""), url: u.origin + "/" };

  const t0 = Date.now();
  try {
    const accueil = await lirePage(new URL(site.url), 4000);
    const memeSite = (h) => { try { return new URL(h).hostname.replace(/^www\./, "") === accueil.final.hostname.replace(/^www\./, ""); } catch { return false; } };
    let liens = liensServices(accueil.html, accueil.final);
    if (!liens.length) liens = CHEMINS.map((c) => accueil.final.origin + c);
    // Pages de services liées depuis l'accueil (sous-pages d'un menu « Services » incluses).
    const sous = [...accueil.html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => { try { return new URL(m[1], accueil.final).href; } catch { return null; } })
      .filter((h) => h && memeSite(h) && /(services?|expertises?|solutions?|prestations|nos-services|formations?)\/[^/]+/i.test(h));
    const candidats = [...new Set([...liens, ...sous])].slice(0, 6);
    const lues = (await Promise.all(candidats.map((h) => { const v = parseSite(h); return v ? lirePage(v, 2500).then((r) => ({ url: h, html: r.html })).catch(() => null) : null; }))).filter(Boolean);
    const pages = [{ url: accueil.final.href, texte: texteDePage(accueil.html, 5000) }]
      .concat(lues.map((p) => ({ url: p.url, texte: texteDePage(p.html, 2200) })));
    const restant = Math.max(6000, 22000 - (Date.now() - t0));
    const profil = await comprendreSite({ host: site.host, pages, timeoutMs: restant });
    if (!profil.services.length) return json({ error: "metier-introuvable" }, 422);
    return json({ site: site.host, profil, anglais: Boolean(lienAnglais(accueil.html, accueil.final)), ms: Date.now() - t0 });
  } catch (e) {
    console.error("comprendre", site.host, String(e.message || e));
    return json({ error: "comprendre-echec", raison: String(e.name === "AbortError" ? "delai" : (e.message || e)).slice(0, 160), ms: Date.now() - t0 }, 502);
  }
};

export const config = { path: "/api/comprendre" };
