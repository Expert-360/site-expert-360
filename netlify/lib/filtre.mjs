// Filtre sans IA, appliqué avant le tri par Claude : écarte les recherches qui ne sont QUE un lieu ou un commerce
// sans rapport avec le métier (« hôtel de ville », « Boucherville », « hôtel Montréal »).
// Une recherche qui mêle un lieu et un service (« forage Boucherville », « déménageur Montréal ») est conservée :
// c'est Claude qui la juge ensuite. Un mot de la liste qui apparaît dans le profil de l'entreprise n'est jamais retiré
// (un hôtel qui cherche des clients garde « hôtel »).

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[’'`´]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// Villes et régions du Québec (formes normalisées, sans accents ni tirets).
const LIEUX = [
  "montreal", "quebec", "laval", "gatineau", "longueuil", "sherbrooke", "saguenay", "levis", "trois rivieres", "terrebonne",
  "saint jean sur richelieu", "repentigny", "brossard", "drummondville", "saint jerome", "granby", "blainville", "saint hyacinthe",
  "shawinigan", "dollard des ormeaux", "chateauguay", "rimouski", "saint eustache", "mascouche", "vaudreuil dorion", "vaudreuil",
  "victoriaville", "salaberry de valleyfield", "rouyn noranda", "val d or", "sorel tracy", "sorel", "saint georges", "joliette",
  "alma", "boucherville", "mirabel", "boisbriand", "pointe claire", "kirkland", "beaconsfield", "dorval", "westmount", "verdun",
  "lasalle", "anjou", "outremont", "saint laurent", "saint leonard", "montreal nord", "lachine", "pierrefonds", "rosemont",
  "plateau mont royal", "ahuntsic", "sainte therese", "saint lambert", "la prairie", "candiac", "chambly", "beloeil", "mont saint hilaire",
  "saint bruno", "varennes", "contrecoeur", "saint constant", "sainte julie", "saint lazare", "les coteaux", "magog", "cowansville",
  "bromont", "sainte adele", "saint sauveur", "mont tremblant", "tremblant", "rawdon", "saint donat", "lachute", "hawkesbury",
  "rivière du loup", "riviere du loup", "baie comeau", "sept iles", "gaspe", "matane", "amqui", "thetford mines", "saint georges de beauce",
  "beauceville", "montmagny", "lac megantic", "sainte marie", "saint raymond", "donnacona", "charlesbourg", "beauport", "sainte foy",
  "sillery", "limoilou", "orford", "saint colomban", "saint zotique", "carignan", "otterburn park", "brome", "farnham",
  "rive sud", "rive nord", "montereguie", "laurentides", "lanaudiere", "estrie", "mauricie", "outaouais", "abitibi", "gaspesie",
  "saguenay lac saint jean", "lac saint jean", "centre du quebec", "chaudiere appalaches", "bas saint laurent", "cote nord",
  "nord du quebec", "grand montreal", "ile de montreal", "region de montreal", "region de quebec", "ottawa", "toronto", "canada",
  "ontario", "quebec city", "montreal qc", "qc",
].map(norm).sort((a, b) => b.length - a.length);

// Commerces, services publics et lieux sans rapport, par familles. Si le profil de l'entreprise contient un mot d'une
// famille (ex. « hôtel »), toute la famille est protégée (« auberge », « motel »…), car elle peut être son métier.
const FAMILLES = [
  ["hotel", "hotels", "motel", "motels", "auberge", "auberges", "hebergement", "hebergements", "gite", "gites", "airbnb", "camping", "chalet", "chalets"],
  ["resto", "restaurant", "restaurants", "cafe", "cafes", "bar", "bars", "pizza", "traiteur", "boulangerie"],
  ["mairie", "hotel de ville", "ville", "villes", "municipalite", "municipalites", "arrondissement", "bibliotheque", "piscine", "piscines", "parc", "parcs", "cimetiere"],
  ["cinema", "cinemas", "musee", "theatre", "spa", "salon", "coiffeur", "garderie", "ecole", "ecoles", "universite", "cegep", "hopital", "eglise"],
  ["centre commercial", "magasin", "magasins", "epicerie", "pharmacie"],
  ["meteo", "carte", "map", "plan", "metro", "autobus", "aeroport", "gare", "taxi", "stationnement"],
  ["emploi", "emplois", "offre", "offres", "carriere", "carrieres", "recrutement"],
].map((f) => f.map(norm));
const COMMERCES = FAMILLES.flat().sort((a, b) => b.length - a.length);

// Mots qui accompagnent un lieu sans lui donner de sens métier.
const LIANTS = new Set(("de du des la le les l d en a au aux et ou pres proche autour sur dans pour avec sans par chez " +
  "adresse adresses telephone numero heures heure horaire horaires ouverture ouvert fermeture contact info infos information informations " +
  "site web officiel prix tarif tarifs avis commentaire commentaires pas cher meilleur meilleurs meilleure top near me in the of and " +
  "qc quebec").split(" ").map(norm));

const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reLieux = new RegExp("(^| )(" + LIEUX.map(echapper).join("|") + ")(?= |$)", "g");
const reCommerces = (exclus) => {
  const liste = COMMERCES.filter((c) => !exclus.has(c));
  return liste.length ? new RegExp("(^| )(" + liste.map(echapper).join("|") + ")(?= |$)", "g") : null;
};

// Mots du profil (nom des services, recherches de départ, métier, secteur) : jamais considérés comme du bruit.
export function motsDuProfil(profil) {
  const texte = [profil.metier, profil.secteur, ...(profil.services || []).flatMap((s) => [s.nom, ...(s.fr || []), ...(s.en || [])])].join(" ");
  return new Set(norm(texte).split(" ").filter(Boolean));
}

// Reste de la recherche une fois retirés les lieux, commerces et mots de liaison (sauf ceux du profil).
export function resteApresRetrait(texte, profil) {
  const vocab = profil ? motsDuProfil(profil) : new Set();
  // Une famille de commerces est protégée si un de ses mots figure dans le profil.
  const exclus = new Set(FAMILLES.filter((f) => f.some((c) => c.split(" ").some((w) => vocab.has(w)))).flat());
  let t = " " + norm(texte) + " ";
  t = t.replace(reLieux, " ");
  const rc = reCommerces(exclus);
  if (rc) t = t.replace(rc, " ");
  const reste = t.split(" ").filter((w) => w && !LIANTS.has(w) && !/^\d+$/.test(w));
  return reste;
}

// Vrai si la recherche n'est que du bruit (rien ne reste après retrait).
export function estBruit(texte, profil) {
  const reste = resteApresRetrait(texte, profil);
  return reste.length === 0;
}

// Filtre une liste de mots-clés { keyword, ... } : renvoie { gardes, ecartes }.
export function filtreSansIA(mots, profil) {
  const gardes = [], ecartes = [];
  for (const k of mots) (estBruit(k.keyword, profil) ? ecartes : gardes).push(k);
  return { gardes, ecartes };
}

// Une recherche de départ valable décrit un service : jamais un lieu ou un commerce seul.
export const departValide = (texte, profil) => !estBruit(texte, profil);

// Recherche de départ sans nom de lieu : « forage Boucherville » devient « forage ». Keyword Planner élargira lui-même
// vers les villes ; un lieu dans la recherche de départ orienterait toutes les idées vers cette ville.
export function sansLieux(texte) {
  const t = " " + norm(texte) + " ";
  const sans = t.replace(reLieux, " ").replace(/\s+/g, " ").trim();
  // On garde la graphie d'origine quand rien n'est retiré.
  return sans === norm(texte) ? String(texte).trim() : sans;
}
