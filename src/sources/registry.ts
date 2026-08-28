/**
 * §4 — Typologie des sources (tiers).
 *
 * REGLE DE CONCEPTION : le tier d'une source est DERIVE de son domaine, jamais
 * declare par l'agent qui la cite. Si un agent pouvait annoncer lui-meme
 * "tier 1", EP-001 ("source avant recit") deviendrait declaratif : il suffirait
 * d'etiqueter un blog en source primaire pour contourner tout le protocole.
 *
 * Corollaire : un domaine inconnu du registre est classe tier 3 (secondaire),
 * jamais mieux. On ne presume pas du statut primaire d'une source qu'on n'a pas
 * verifiee. C'est un defaut prudent, pas une approximation.
 */

import type { SourceTier } from "../protocol/constants.js";

export interface RegisteredSource {
  /** Suffixe de domaine, compare sur l'hote. */
  domain: string;
  tier: SourceTier;
  name: string;
  /** Si defini, le tier ne s'applique que si le chemin commence par ce prefixe. */
  pathPrefix?: string;
}

/**
 * Le registre reprend litteralement le tableau du §4. L'ordre compte : la
 * premiere entree qui matche gagne, donc les cas particuliers (sous-domaines,
 * chemins) precedent les regles generales.
 */
export const SOURCE_REGISTRY: readonly RegisteredSource[] = [
  // --- Tier 1 : sources primaires -----------------------------------------
  { domain: "data.worldbank.org", tier: 1, name: "Banque mondiale (API)" },
  { domain: "worldbank.org", tier: 1, name: "Banque mondiale" },
  { domain: "imf.org", tier: 1, name: "FMI" },
  { domain: "ec.europa.eu", tier: 1, name: "Eurostat / Commission europeenne" },
  { domain: "fred.stlouisfed.org", tier: 1, name: "FRED (Fed St. Louis)" },
  { domain: "stlouisfed.org", tier: 1, name: "Fed St. Louis" },
  { domain: "oecd.org", tier: 1, name: "OCDE" },
  { domain: "comtrade.un.org", tier: 1, name: "UN Comtrade" },
  { domain: "usgs.gov", tier: 1, name: "USGS" },
  { domain: "firms.modaps.eosdis.nasa.gov", tier: 1, name: "NASA FIRMS" },
  { domain: "nasa.gov", tier: 1, name: "NASA" },
  { domain: "ofac.treasury.gov", tier: 1, name: "OFAC" },
  { domain: "treasury.gov", tier: 1, name: "US Treasury" },
  { domain: "reliefweb.int", tier: 1, name: "ReliefWeb (ONU)" },

  // --- Tier 2 : donnee publique agregee et sourcee -------------------------
  // Cas particulier §4 : GDELT est tier 2, mais "GDELT Cloud" est tier 3.
  { domain: "gdeltproject.org", tier: 3, name: "GDELT Cloud", pathPrefix: "/cloud" },
  { domain: "gdeltproject.org", tier: 2, name: "GDELT" },
  { domain: "ucdp.uu.se", tier: 2, name: "UCDP" },
  { domain: "radar.cloudflare.com", tier: 2, name: "Cloudflare Radar" },
  { domain: "l0g.fr", tier: 2, name: "l0g.fr" },
  { domain: "opensanctions.org", tier: 2, name: "OpenSanctions" },

  // --- Tier 3 : sources secondaires ---------------------------------------
  { domain: "gnews.io", tier: 3, name: "GNews" },
  { domain: "acleddata.com", tier: 3, name: "ACLED" },
  { domain: "sipri.org", tier: 3, name: "SIPRI" },

  // --- Tier 5 : contexte interne ------------------------------------------
  { domain: "media-next-gen.local", tier: 5, name: "Contexte interne" },
];

export interface SourceClassification {
  tier: SourceTier;
  name: string;
  /** Faux si le domaine est absent du registre : le tier 3 est alors un defaut. */
  registered: boolean;
}

const UNREGISTERED_TIER: SourceTier = 3;

/**
 * Classe une URL. Une URL invalide est traitee comme non enregistree : on ne
 * lui accorde aucun credit, mais on ne fait pas tomber le pipeline non plus
 * (c'est au gate de refuser, pas au classificateur).
 */
export function classifySource(url: string): SourceClassification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { tier: UNREGISTERED_TIER, name: "URL invalide", registered: false };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  for (const entry of SOURCE_REGISTRY) {
    const hostMatches = host === entry.domain || host.endsWith(`.${entry.domain}`);
    if (!hostMatches) continue;
    if (entry.pathPrefix !== undefined && !path.startsWith(entry.pathPrefix)) {
      continue;
    }
    return { tier: entry.tier, name: entry.name, registered: true };
  }

  return {
    tier: UNREGISTERED_TIER,
    name: host,
    registered: false,
  };
}

/**
 * EP-001 — "Une source primaire ou officielle passe toujours avant une synthese
 * de presse quand elle existe."
 *
 * Rend les sources secondaires qui sont doublonnees par une source primaire
 * disponible dans le meme lot : ce sont celles que le Veilleur aurait du ecarter.
 */
export function secondariesShadowedByPrimary(
  urls: readonly string[],
): readonly string[] {
  const classified = urls.map((url) => ({ url, ...classifySource(url) }));
  const hasPrimary = classified.some((c) => c.tier === 1 || c.tier === 2);
  if (!hasPrimary) return [];
  return classified.filter((c) => c.tier >= 3).map((c) => c.url);
}
