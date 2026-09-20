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
 *
 * CE REGISTRE NE DIT RIEN DE L'INTERET D'UNE SOURCE. Le tier mesure la distance
 * a la donnee ; savoir si l'auteur est investi dans ce qu'il commente est une
 * autre question, tenue par `protocol/interests.ts`.
 */

import type { SourceTier } from "../protocol/constants.js";
import { hostMatchesDomain } from "../protocol/interests.js";

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
  // Les trois domaines Comtrade sont distincts : `comtradeplus` et
  // `comtradeapi` ne sont PAS des sous-domaines de `comtrade.un.org`. Sans
  // ces entrees, une URL Comtrade legitime retombait au tier 3 par defaut.
  { domain: "comtrade.un.org", tier: 1, name: "UN Comtrade" },
  { domain: "comtradeplus.un.org", tier: 1, name: "UN Comtrade Plus" },
  { domain: "comtradeapi.un.org", tier: 1, name: "UN Comtrade (API)" },
  {
    domain: "sanctionslistservice.ofac.treas.gov",
    tier: 1,
    name: "OFAC (service de listes)",
  },
  { domain: "treas.gov", tier: 1, name: "US Treasury" },
  { domain: "usgs.gov", tier: 1, name: "USGS" },
  { domain: "firms.modaps.eosdis.nasa.gov", tier: 1, name: "NASA FIRMS" },
  { domain: "nasa.gov", tier: 1, name: "NASA" },
  { domain: "ofac.treasury.gov", tier: 1, name: "OFAC" },
  { domain: "treasury.gov", tier: 1, name: "US Treasury" },
  // Le regulateur des marches americains publie ses propres communiques, ses
  // propres decisions et les depots qu'il recoit : il est l'emetteur, pas un
  // relais. Le suffixe couvre aussi `data.sec.gov`, son hote de donnees.
  { domain: "sec.gov", tier: 1, name: "SEC (Securities and Exchange Commission)" },
  { domain: "reliefweb.int", tier: 1, name: "ReliefWeb (ONU)" },
  { domain: "boj.or.jp", tier: 1, name: "Banque du Japon" },
  // Banque centrale de la zone euro : emettrice de ses decisions, de ses
  // projections et des billets de ses responsables. ABSENTE du registre
  // jusqu'au 2026-09-19 — un billet du blog de la BCE retombait donc au tier 3
  // par defaut, celui de la presse, et EP-001 ne le faisait jamais primer sur
  // une reprise de presse. Le tier ne dit pas la NATURE du document : c'est au
  // caveat du catalogue de distinguer un billet signe d'une decision.
  { domain: "ecb.europa.eu", tier: 1, name: "Banque centrale europeenne" },
  {
    domain: "federalreserve.gov",
    tier: 1,
    name: "Reserve federale (Board of Governors)",
  },
  { domain: "impots.gouv.fr", tier: 1, name: "DGFiP" },
  { domain: "economie.gouv.fr", tier: 1, name: "Ministere de l'Economie" },
  // Tier 1 par DECISION DE L'EDITEUR (2026-09-11) : Binance est l'emetteur de
  // ses propres cotations. Le tier ne dit pas ce qu'elles couvrent — une seule
  // plateforme — et c'est `protocol/sources-de-marche.ts` qui impose de le
  // dire (« sur Binance »). Seul l'hote de donnees publiques est concerne : un
  // billet de binance.com reste hors registre, donc tier 3.
  { domain: "data-api.binance.vision", tier: 1, name: "Binance (donnees de marche publiques)" },

  // --- Tier 2 : donnee publique agregee et sourcee -------------------------
  // Cas particulier §4 : GDELT est tier 2, mais "GDELT Cloud" est tier 3.
  { domain: "gdeltproject.org", tier: 3, name: "GDELT Cloud", pathPrefix: "/cloud" },
  { domain: "gdeltproject.org", tier: 2, name: "GDELT" },
  { domain: "ucdp.uu.se", tier: 2, name: "UCDP" },
  { domain: "radar.cloudflare.com", tier: 2, name: "Cloudflare Radar" },
  { domain: "l0g.fr", tier: 2, name: "l0g.fr" },
  { domain: "opensanctions.org", tier: 2, name: "OpenSanctions" },
  // Services officiels, mais pas documents de decision — d'ou le tier 2,
  // choisi par prudence. ONU Info RELATE ce que decident les organes des
  // Nations unies ; GDACS CALCULE une alerte et une population exposee a
  // partir de donnees d'autres emetteurs. Pour la decision elle-meme ou pour
  // un bilan constate, il faut remonter plus haut.
  { domain: "news.un.org", tier: 2, name: "ONU Info" },
  { domain: "gdacs.org", tier: 2, name: "GDACS (ONU / Commission europeenne)" },
  // Agregat multi-plateformes, methodologie publiee : la definition meme du
  // tier 2. L'attribution « selon CoinGecko » est exigee a part.
  { domain: "api.coingecko.com", tier: 2, name: "CoinGecko (agregat multi-plateformes)" },
  // Hugging Face, et le meme decoupage que GitHub plus bas : l'API porte la
  // MESURE de la plateforme — nombre de requetes servies, methode de comptage
  // publiee, ce qui est la definition meme du tier 2 — tandis que
  // huggingface.co/<qui-veut>/<son-modele> est une fiche redigee par le
  // deposant. Promouvoir le domaine entier donnerait a une auto-description le
  // statut de donnee publique.
  {
    domain: "huggingface.co",
    tier: 2,
    name: "Hugging Face (Hub, mesure de diffusion)",
    pathPrefix: "/api/",
  },
  // GitHub, et l'ordre compte autant que le tier.
  //
  // La PUBLICATION d'une version est un fait a distance zero : le depot du
  // projet est le lieu meme ou elle a lieu, et « la version 5.17 est sortie le
  // 10 septembre » se verifie a cette adresse. Sans tier 1 ou 2, cette phrase
  // ne pourrait meme pas etre typee « fait » (§3).
  //
  // Mais github.com heberge N'IMPORTE QUI. Une entree de domaine au tier 2
  // aurait promu le README du premier venu au rang de donnee publique. Seuls
  // les chemins de versions MESURES le 2026-09-19 sont donc releves, chemin par
  // chemin ; le reste du site reste en tier 3, comme GDELT Cloud plus haut.
  //
  // Le tier ne dit rien de ce que la note AFFIRME : la performance annoncee
  // n'est auditee par personne, et c'est le caveat du catalogue qui le porte.
  {
    domain: "github.com",
    tier: 2,
    name: "Hugging Face / transformers (versions publiees)",
    pathPrefix: "/huggingface/transformers/releases",
  },
  {
    domain: "github.com",
    tier: 2,
    name: "Ollama (versions publiees)",
    pathPrefix: "/ollama/ollama/releases",
  },
  {
    domain: "github.com",
    tier: 2,
    name: "OpenSSL (versions publiees)",
    pathPrefix: "/openssl/openssl/releases",
  },

  // --- Tier 3 : sources secondaires ---------------------------------------
  { domain: "gnews.io", tier: 3, name: "GNews" },
  { domain: "aljazeera.com", tier: 3, name: "Al Jazeera" },
  { domain: "haaretz.com", tier: 3, name: "Haaretz" },
  { domain: "brecorder.com", tier: 3, name: "Business Recorder" },
  { domain: "reuters.com", tier: 3, name: "Reuters" },
  { domain: "acleddata.com", tier: 3, name: "ACLED" },
  { domain: "sipri.org", tier: 3, name: "SIPRI" },
  // Prepublication : arXiv est bien l'EMETTEUR du document, mais aucun comite
  // de lecture n'est passe. Le tier dit ici ce que vaut le CONTENU pour fonder
  // un fait, pas le serieux de l'archive — d'ou le tier 3 malgre l'institution,
  // et le caveat qui le redit dans chaque observation.
  { domain: "arxiv.org", tier: 3, name: "arXiv (prepublication)" },
  // Tout le reste de github.com. ENREGISTRE, et pas seulement laisse au tier 3
  // par defaut : un domaine inconnu affiche son nom d'hote a la place du nom de
  // l'editeur, et l'assertion « tier 3 » passerait meme apres retrait.
  { domain: "github.com", tier: 3, name: "GitHub (depot public)" },
  // Fiches de modeles et billets : deposes par des tiers, comme sur GitHub.
  { domain: "huggingface.co", tier: 3, name: "Hugging Face (contenu depose)" },
  // Acteurs du marche qu'ils commentent. Le tier 3 dit leur distance a la
  // donnee ; leur interet est declare separement et sa mention en gras est
  // exigee par une regle bloquante (protocol/interests.ts).
  { domain: "castleisland.vc", tier: 3, name: "Castle Island Ventures" },
  { domain: "galaxy.com", tier: 3, name: "Galaxy Digital" },
  // Agregateur grand public, sans engagement de service. Tier 3, et au-dela du
  // tier : un SIGNAL qui ne se cite jamais (protocol/sources-de-marche.ts).
  { domain: "query1.finance.yahoo.com", tier: 3, name: "Yahoo Finance (signal)" },
  { domain: "query2.finance.yahoo.com", tier: 3, name: "Yahoo Finance (signal)" },

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
    if (!hostMatchesDomain(host, entry.domain)) continue;
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
