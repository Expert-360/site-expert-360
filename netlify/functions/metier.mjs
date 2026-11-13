// Diagnostic : GET /api/metier?site=exemple.ca
// Montre ce que l'outil lit pour détecter le métier (pages lues, titres trouvés, métiers retenus).
import { parseSite, lirePage, extraireMetier, liensServices, decode } from "../lib/lecture.mjs";

export default async (req) => {
  const u = parseSite(new URL(req.url).searchParams.get("site"));
  if (!u) return Response.json({ error: "Paramètre site manquant ou invalide." }, { status: 400 });
  const out = { site: u.hostname, pages: [] };
  const resume = (url, html) => ({
    url,
    taille: html.length,
    texteVisible: decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")).length,
    titre: decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""),
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(m[1])).slice(0, 5),
    h2h4: [...html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi)].map((m) => decode(m[1])).filter(Boolean).slice(0, 30),
    liens: [...html.matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]).slice(0, 40),
  });
  try {
    const p = await lirePage(new URL(u.origin + "/"), 6000);
    out.pages.push(resume(p.final.href, p.html));
    const liens = liensServices(p.html, p.final);
    out.pagesServicesTrouvees = liens;
    const pages = [];
    for (const h of liens) {
      try { const r = await lirePage(new URL(h), 5000); pages.push(r.html); out.pages.push(resume(h, r.html)); }
      catch (e) { out.pages.push({ url: h, erreur: String(e.message || e) }); }
    }
    out.metierDetecte = extraireMetier(p.html, u.hostname, pages);
  } catch (e) {
    out.erreur = String(e.message || e);
  }
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/metier" };
