// Fonction TEMPORAIRE de diagnostic : vérifie la connexion à l'API Google Ads.
// Ne renvoie jamais de secret. À supprimer une fois l'outil en place.

const VERSIONS = ["v24", "v23", "v22"];

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  return { ok: r.ok, token: j.access_token, error: j.error, error_description: j.error_description };
}

export default async () => {
  const out = {
    env: {
      client_id: !!process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: !!process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: !!process.env.GOOGLE_ADS_REFRESH_TOKEN,
      login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null,
    },
  };
  const t = await accessToken();
  out.oauth = { ok: t.ok, error: t.error || null, error_description: t.error_description || null };
  if (!t.ok) return Response.json(out);

  const headers = {
    Authorization: `Bearer ${t.token}`,
    "login-customer-id": process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    "Content-Type": "application/json",
  };

  out.versions = {};
  let version = null;
  for (const v of VERSIONS) {
    const r = await fetch(`https://googleads.googleapis.com/${v}/customers:listAccessibleCustomers`, { headers });
    const txt = await r.text();
    out.versions[v] = { status: r.status, body: txt.slice(0, 400) };
    if (r.ok) { version = v; break; }
  }
  if (!version) return Response.json(out);
  out.version = version;

  const cid = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const body = {
    language: "languageConstants/1002",
    geoTargetConstants: ["geoTargetConstants/2124"],
    keywordPlanNetwork: "GOOGLE_SEARCH",
    urlSeed: { url: "https://www.demenagementtransat.com/" },
    pageSize: 5,
  };
  const r = await fetch(`https://googleads.googleapis.com/${version}/customers/${cid}:generateKeywordIdeas`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const txt = await r.text();
  out.ideas_on_mcc = { status: r.status, body: txt.slice(0, 1500) };

  const g = await fetch(`https://googleads.googleapis.com/${version}/geoTargetConstants:suggest`, {
    method: "POST", headers,
    body: JSON.stringify({ locale: "fr", countryCode: "CA", locationNames: { names: ["Québec", "Montréal"] } }),
  });
  out.geo = { status: g.status, body: (await g.text()).slice(0, 1500) };

  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/ads-diag" };
