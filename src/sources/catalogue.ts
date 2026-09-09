/**
 * Catalogue des sources reelles.
 *
 * Dependances : les adaptateurs concrets, plus `types.ts`. C'est le SEUL module
 * de `sources/` qui lit `process.env`. Les adaptateurs recoivent leurs clefs en
 * parametre, ce qui les rend testables sans variable globale et evite qu'une
 * clef soit lue a dix endroits differents.
 *
 * §EP-003 — une source absente n'est pas une source vide. Le catalogue rend la
 * liste des adaptateurs ecartes ET le motif, pour que le pipeline puisse le
 * declarer au lecteur au lieu de laisser croire a une couverture complete.
 */

import {
  DECLARED_INTERESTS,
  interestCaveat,
  type DeclaredInterest,
} from "../protocol/interests.js";
import { eurostatAdapter } from "./eurostat.js";
import { ofacAdapter } from "./ofac.js";
import { rssAdapter } from "./rss.js";
import { fredAdapter } from "./fred.js";
import { imfAdapter } from "./imf.js";
import type { SourceAdapter } from "./types.js";
import { usgsAdapter } from "./usgs.js";
import { worldBankAdapter } from "./worldbank.js";

/**
 * Mention accolee a chaque observation de presse.
 *
 * Elle voyage avec le texte jusqu'a la claim, donc jusqu'a l'article. Un
 * lecteur doit savoir qu'il lit une reprise editorialisee et non une donnee
 * d'emetteur — et l'Analyste doit le voir avant de typer sa claim.
 */
const PRESSE_CAVEAT =
  "Source de presse (tier 3) : couverture editorialisee, ne peut pas fonder " +
  "un fait a elle seule (§3, EP-001) ; a confronter aux sources primaires.";

/**
 * Recupere un interet declare par son domaine.
 *
 * Le catalogue ne redige PAS la mention : il la demande au registre. Si la
 * formulation etait recopiee ici, elle finirait par diverger de celle qu'exige
 * le gate, et une source correctement branchee bloquerait a la publication.
 * L'echec est immediat et bruyant : un domaine absent du registre signifie que
 * la source serait collectee sans que sa divulgation soit exigee.
 */
function interet(domain: string): DeclaredInterest {
  const found = DECLARED_INTERESTS.find((i) => i.domain === domain);
  if (found === undefined) {
    throw new Error(
      `Aucun interet declare pour "${domain}". Une source a interet ne peut pas ` +
        `etre branchee sans son entree dans protocol/interests.ts.`,
    );
  }
  return found;
}

export interface SkippedSource {
  id: string;
  reason: string;
}

export interface SourceCatalogue {
  adapters: SourceAdapter[];
  skipped: SkippedSource[];
}

/**
 * Construit la liste des sources disponibles.
 *
 * Les sources sans clef sont toujours presentes. Celles qui en exigent une ne
 * sont incluses que si la clef est effectivement fournie : mieux vaut une
 * source declaree absente qu'un adaptateur qui echoue a chaque appel et pollue
 * le journal d'audit d'erreurs previsibles.
 */
export function buildSourceCatalogue(
  env: NodeJS.ProcessEnv = process.env,
): SourceCatalogue {
  const adapters: SourceAdapter[] = [
    // --- Tier 1, sans clef ------------------------------------------------
    worldBankAdapter({ country: "EMU", indicator: "FP.CPI.TOTL.ZG" }),
    worldBankAdapter({ country: "WLD", indicator: "NY.GDP.MKTP.KD.ZG" }),
    imfAdapter({
      country: "FRA",
      indicator: "NGDP_RPCH",
      label: "Croissance du PIB reel",
    }),
    eurostatAdapter({
      dataset: "prc_hicp_manr",
      filters: { geo: "EA", coicop: "CP00", unit: "RCH_A", freq: "M" },
      label: "IPCH, taux de variation annuel",
    }),
    usgsAdapter({ minMagnitude: 6, limit: 5 }),

    // Volet geopolitique : jusqu'ici le catalogue ne contenait que des series
    // macro, alors que le media couvre « geopolitique ET economie ».
    ofacAdapter(),

    // Banque centrale asiatique : les series macro branchees couvraient la
    // zone euro et les Etats-Unis, pas l'Asie.
    rssAdapter({
      id: "boj:whatsnew",
      source: "Banque du Japon",
      url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
      describes: "Publications et communiques de la Banque du Japon",
      type: "communique-banque-centrale",
      limit: 3,
    }),

    // Reserve federale — communiques du Board. Le fil publie les decisions,
    // les minutes de taux d'escompte et les actions d'application. C'est
    // l'emetteur lui-meme : tier 1, sans intermediaire de presse.
    //
    // NE PAS confondre avec le bilan : les CHIFFRES du H.4.1 arrivent par la
    // serie FRED WALCL, plus bas. Voir le motif d'ecart de `fed:h41-notices`.
    rssAdapter({
      id: "fed:press",
      source: "Reserve federale (Board of Governors)",
      url: "https://www.federalreserve.gov/feeds/press_all.xml",
      describes: "Communiques du Board of Governors de la Reserve federale",
      type: "communique-banque-centrale",
      limit: 3,
    }),

    // --- Tier 3 : presse ---------------------------------------------------
    //
    // Premieres sources secondaires du catalogue. Jusqu'ici tout etait de
    // tier 1, ce qui laissait EP-001 (« la source primaire passe avant la
    // reprise de presse ») sans rien a arbitrer sur des donnees reelles.
    //
    // DEUX TITRES, PAS UN. Al Jazeera et Haaretz couvrent les memes evenements
    // depuis des lignes editoriales documentees et opposees. Brancher un seul
    // des deux importerait son cadrage sans contrepoids ; les brancher
    // ensemble rend testable ce que le §5.2 demande a l'Analyste — comparer le
    // narratif mediatique aux donnees observables. Retirer l'un sans l'autre
    // annulerait cette propriete.
    //
    // Les garde-fous du protocole s'appliquent d'eux-memes : une claim typee
    // `fait` adossee au seul tier 3 est bloquee (FACT_NEEDS_PRIMARY_SOURCE), et
    // un article entierement fonde sur du tier 3 doit le declarer (§4).
    rssAdapter({
      id: "aljazeera:all",
      source: "Al Jazeera",
      url: "https://www.aljazeera.com/xml/rss/all.xml",
      describes: "Fil general Al Jazeera",
      type: "presse",
      limit: 3,
      caveat: PRESSE_CAVEAT,
    }),
    rssAdapter({
      id: "haaretz:all",
      source: "Haaretz",
      url: "https://www.haaretz.com/cmlink/1.4605102",
      describes: "Fil general Haaretz",
      type: "presse",
      limit: 3,
      caveat: PRESSE_CAVEAT,
    }),

    // --- Tier 3 : acteur du marche qu'il commente --------------------------
    //
    // Castle Island Ventures publie un podcast hebdomadaire sur le secteur des
    // actifs numeriques. Utile parce que peu d'acteurs documentent ce marche
    // avec cette regularite ; problematique parce que le fonds y est investi.
    //
    // Le protocole ne tranche pas en ecartant la source, mais en rendant sa
    // position visible : la mention voyage avec chaque observation (ci-dessous),
    // le Redacteur recoit la formule a reproduire en gras, et le gate REFUSE de
    // publier si elle manque du corps (INTEREST_UNDISCLOSED). Une consigne
    // aurait suffi a l'oublier ; une regle bloquante, non.
    rssAdapter({
      id: "castleisland:feed",
      source: "Castle Island Ventures",
      url: "https://castleisland.vc/feed/",
      describes:
        "Podcast et notes hebdomadaires de Castle Island Ventures sur les actifs numeriques",
      type: "commentaire-acteur-du-marche",
      limit: 2,
      caveat: interestCaveat(interet("castleisland.vc")),
    }),
  ];

  const skipped: SkippedSource[] = [];

  // --- Tier 1, clef requise ----------------------------------------------
  const fredKey = env["FRED_API_KEY"];
  if (fredKey !== undefined && fredKey.trim().length > 0) {
    adapters.push(
      fredAdapter({
        seriesId: "FEDFUNDS",
        label: "Taux effectif des fonds federaux",
        unit: "%",
        apiKey: fredKey,
      }),
      // Bilan de la Reserve federale — le contenu chiffre du H.4.1, publie
      // chaque semaine. C'est la reponse au flux `h41.xml`, qui n'annonce que
      // les changements de methode (voir `fed:h41-notices` plus bas).
      fredAdapter({
        seriesId: "WALCL",
        label: "Total de l'actif de la Reserve federale (bilan H.4.1)",
        unit: "millions de dollars",
        apiKey: fredKey,
        limit: 4,
      }),
    );
  } else {
    skipped.push({
      id: "fred:FEDFUNDS+WALCL",
      reason:
        "FRED_API_KEY absente de l'environnement : le taux des fonds federaux " +
        "ET le bilan de la Reserve federale sont indisponibles. Clef gratuite " +
        "sur https://fredaccount.stlouisfed.org/apikeys — a placer dans .env.",
    });
  }

  // --- Sources ecartees pour raisons externes -----------------------------
  // Documentees ici plutot que supprimees : le lecteur du code doit savoir
  // pourquoi une source du §4 n'est pas branchee.
  skipped.push(
    {
      id: "reuters:rss",
      reason:
        "Reuters a ferme ses flux publics : HTTP 401 sur le fil monde, 404 sur " +
        "l'endpoint arc (verifie le 2026-09-02). Leur contenu est distribue sous " +
        "licence ; il n'existe pas d'acces legitime sans contrat, et contourner " +
        "cette absence par du moissonnage violerait leurs conditions.",
    },
    {
      id: "impots-gouv:rss",
      reason:
        "impots.gouv.fr ne publie aucun flux (404, page HTML renvoyee). " +
        "L'equivalent exploitable est data.economie.gouv.fr, dont l'API repond " +
        "mais expose un CATALOGUE de jeux de donnees : il faudrait d'abord " +
        "choisir un jeu et une serie precise, ce qui est une decision " +
        "editoriale et non un branchement.",
    },
    {
      id: "comtrade:preview",
      reason:
        "Endpoint public `preview` ouvert mais NON REPRODUCTIBLE, ce qui est " +
        "redhibitoire pour le §2. Mesures du 2026-09-02 : la meme requete pour " +
        "2023 a rendu 500 lignes puis 0 lignes a cinq minutes d'intervalle ; et " +
        "en 2022, 115 lignes portent des codes d'agregat identiques " +
        "(customsCode C00, motCode 0, mosCode 0) pour des valeurs de 632,8 Md$, " +
        "0,1 Md$ et 1,0 Md$ — aucun critere documente ne permet d'identifier " +
        "l'agregat reel. Les annees exploitables (2020-2022) accusent en outre " +
        "trois ans de retard. Une claim fondee sur cette source ne serait pas " +
        "reproductible par un lecteur.",
    },
    {
      id: "ucdp:gedevents",
      reason:
        "Conflits armes (tier 2). L'API repondait sans clef ; elle exige " +
        "desormais un en-tete `x-ucdp-access-token` (HTTP 401 au 2026-09-02). " +
        "C'etait le meilleur candidat tier 2 gratuit.",
    },
    {
      id: "oecd:sdmx",
      reason:
        "HTTP 500 sur l'endpoint SDMX public, cote fournisseur (verifie le 2026-09-02).",
    },
    {
      id: "nasa-firms:area",
      reason:
        "Necessite une MAP_KEY, gratuite mais soumise a inscription " +
        "(https://firms.modaps.eosdis.nasa.gov/api/map_key/).",
    },
    {
      id: "gdelt:doc",
      reason:
        "api.gdeltproject.org presente un certificat TLS expire. Contourner la " +
        "verification TLS exposerait le pipeline a une interception : on attend " +
        "que la source corrige son certificat.",
    },
    {
      id: "reliefweb:reports",
      reason:
        "L'API v1 est decommissionnee et la v2 exige un `appname` approuve par " +
        "ReliefWeb (demande sur https://apidoc.reliefweb.int/parameters#appname).",
    },
    {
      id: "opensanctions:search",
      reason:
        "Clef d'API requise (OPENSANCTIONS_API_KEY non geree pour l'instant).",
    },
    {
      id: "fed:h41-notices",
      reason:
        "federalreserve.gov/feeds/h41.xml repond (HTTP 200, 120 entrees) mais ne " +
        "publie PAS le bilan : uniquement les avis de changement de methode du " +
        "H.4.1. Sa derniere entree datait de 47 jours au 2026-09-02, donc il " +
        "echouerait a chaque collecte sur la fenetre de fraicheur de 30 jours et " +
        "ferait porter a chaque article une mention « source indisponible » " +
        "trompeuse. Les chiffres du H.4.1 sont branches par la serie FRED WALCL.",
    },
    {
      id: "galaxy:research",
      reason:
        "Galaxy Digital ne publie aucun flux : /feed, /feed.xml, /rss.xml, " +
        "/insights/rss et /insights/research/feed rendent tous 404, et les pages " +
        "d'index n'annoncent aucun flux (verifie le 2026-09-02). Les recuperer " +
        "demanderait de moissonner des pages applicatives — ce que le pipeline " +
        "refuse pour Reuters comme pour Dataroma. L'interet de Galaxy reste " +
        "DECLARE dans protocol/interests.ts : si une URL galaxy.com atteint une " +
        "claim par un autre chemin, la divulgation en gras est exigee malgre " +
        "l'absence d'adaptateur.",
    },
    {
      id: "sec-edgar:atom",
      reason:
        "Les flux Atom d'EDGAR (browse-edgar ...&output=atom) rendent HTTP 403 " +
        "sans en-tete `User-Agent` nominatif. La SEC exige une adresse de contact " +
        "reelle, publiquement declaree, dans chaque requete. En attente de " +
        "l'adresse que l'editeur accepte de rendre publique.",
    },
    {
      id: "dataroma:portfolios",
      reason:
        "Aucun flux : uniquement du HTML applicatif. Dataroma reste utile en " +
        "REPERAGE (il agrege les 13F en vues de portefeuille qu'EDGAR ne fournit " +
        "pas), mais la preuve citable reste le depot EDGAR lui-meme — c'est " +
        "exactement ce que EP-001 organise. A rebrancher si Dataroma expose un " +
        "flux, ou une fois EDGAR accessible.",
    },
  );

  return { adapters, skipped };
}
