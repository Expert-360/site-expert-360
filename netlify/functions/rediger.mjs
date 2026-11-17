// Audit Google Ads — étape 3 : rédiger « Ce que je remarque » et « Budget indicatif » avec Claude.
// POST /api/rediger  { profil, chiffres }  →  { observations, budget, budget_note, negatifs }
import { profilValide, redigerAudit, iaDisponible } from "../lib/ia.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non permise." }, 405);
  const origine = req.headers.get("origin") || req.headers.get("referer") || "";
  if (origine && !/^https:\/\/([a-z0-9-]+\.)*(expert-360\.ca|netlify\.app)(\/|$)/i.test(origine)) return json({ error: "Origine refusée." }, 403);
  if (!iaDisponible()) return json({ error: "ia-indisponible" }, 503);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
  const profil = profilValide(body.profil);
  const c = body.chiffres || {};
  if (!profil || typeof c !== "object") return json({ error: "Requête invalide." }, 400);
  // On ne transmet à Claude que des chiffres bornés, venus de l'analyse Google.
  const n = (v) => Math.max(0, Math.min(1e7, Number(v) || 0));
  const t = (v, m = 80) => String(v || "").slice(0, m);
  const donnees = {
    profil: { entreprise: profil.entreprise, metier: profil.metier, secteur: profil.secteur, clientele: profil.clientele, zone: profil.zone, atouts: profil.atouts, services: profil.services.map((s) => s.nom) },
    deja_en_place: profil.deja,
    marche: {
      recherchesQualifieesParMois: n(c.total),
      cpcMoyen: n(c.cpcMoyen),
      concurrence: t(c.concurrence, 20),
      parService: (Array.isArray(c.services) ? c.services : []).slice(0, 10).map((s) => ({ service: t(s.nom), volume: n(s.volume) })),
      recherchesPrincipales: (Array.isArray(c.motsCles) ? c.motsCles : []).slice(0, 15).map((k) => ({ mot: t(k.mot), volume: n(k.volume), cpcBas: n(k.cpcBas), cpcHaut: n(k.cpcHaut), concurrence: t(k.concurrence, 12) })),
      recherchesEcartees: (Array.isArray(c.ecartes) ? c.ecartes : []).slice(0, 6).map((k) => ({ mot: t(k.mot), volume: n(k.volume) })),
      moisFort: t(c.moisFort, 10), moisFaible: t(c.moisFaible, 10),
      regions: (Array.isArray(c.regions) ? c.regions : []).slice(0, 6).map((r) => ({ ville: t(r.ville, 40), recherches: n(r.recherches) })),
      concurrents: (Array.isArray(c.concurrents) ? c.concurrents : []).slice(0, 6).map((x) => ({ nom: t(x.nom, 60), recherches: n(x.recherches) })),
      recherchesSurLaMarque: n(c.marque),
    },
  };
  try {
    return json(await redigerAudit({ donnees, timeoutMs: 22000 }));
  } catch (e) {
    console.error("rediger", String(e.message || e));
    return json({ error: "rediger-echec", raison: String(e.name === "AbortError" ? "delai" : (e.message || e)).slice(0, 160) }, 502);
  }
};

export const config = { path: "/api/rediger" };
