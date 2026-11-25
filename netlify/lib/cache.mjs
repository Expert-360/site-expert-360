// Mémoire des audits : un même site donne le même résultat pendant 30 jours (Netlify Blobs).
// La mémoire est un confort : si elle n'est pas disponible, l'audit se fait normalement, sans elle.

export const DUREE_JOURS = 30;
const DUREE_MS = DUREE_JOURS * 24 * 3600 * 1000;

let magasin = null;
async function store() {
  if (magasin !== null) return magasin || null;
  try {
    const { getStore } = await import("@netlify/blobs");
    magasin = getStore("audits");
  } catch (e) {
    console.error("cache:indisponible", String(e && e.message || e));
    magasin = false;
  }
  return magasin || null;
}

// Clé = domaine seul : la version anglaise, la version française ou une sous-page donnent la même clé.
export const cleDomaine = (type, host) => type + ":" + String(host || "").toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "");

export async function lire(cle) {
  try {
    const s = await store();
    if (!s) return null;
    const v = await s.get(cle, { type: "json" });
    if (!v || typeof v.t !== "number" || Date.now() - v.t > DUREE_MS) return null;
    return v;
  } catch (e) {
    console.error("cache:lecture", cle, String(e && e.message || e));
    return null;
  }
}

export async function ecrire(cle, donnees) {
  try {
    const s = await store();
    if (!s) return false;
    await s.setJSON(cle, { t: Date.now(), donnees });
    return true;
  } catch (e) {
    console.error("cache:ecriture", cle, String(e && e.message || e));
    return false;
  }
}
