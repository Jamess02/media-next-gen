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
  ];

  const skipped: SkippedSource[] = [];

  // --- Tier 1, clef requise ----------------------------------------------
  const fredKey = env["FRED_API_KEY"];
  if (fredKey !== undefined && fredKey.trim().length > 0) {
    adapters.push(
      fredAdapter({
        seriesId: "FEDFUNDS",
        label: "Taux effectif des fonds federaux",
        apiKey: fredKey,
      }),
    );
  } else {
    skipped.push({
      id: "fred:FEDFUNDS",
      reason:
        "FRED_API_KEY absente de l'environnement. Clef gratuite sur " +
        "https://fredaccount.stlouisfed.org/apikeys — a placer dans .env.",
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
  );

  return { adapters, skipped };
}
