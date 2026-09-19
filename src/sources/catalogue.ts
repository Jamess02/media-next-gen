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

import { join } from "node:path";

import { adaptateurDeMarche } from "../marche/adaptateur.js";
import { connecteurBinance } from "../marche/binance.js";
import { connecteurCoinGecko } from "../marche/coingecko.js";
import { INSTRUMENTS } from "../marche/instruments.js";
import type { ConnecteurDeMarche } from "../marche/types.js";
import { connecteurYahoo } from "../marche/yahoo.js";
import {
  DECLARED_INTERESTS,
  interestCaveat,
  type DeclaredInterest,
} from "../protocol/interests.js";
import { currentsAdapter } from "./currents.js";
import { newsdataAdapter } from "./newsdata.js";
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
 * Debit impose par arXiv, cite depuis ses conditions d'usage (2026-09-19) :
 * « no more than one request every three seconds, and limit requests to a
 * single connection ». Les contourner y est explicitement interdit.
 *
 * Ce n'est PAS une limite defendue par un code de retour : aucun 429 ne
 * viendra nous avertir qu'on la franchit. D'ou une constante nommee, datee, et
 * lisible — une valeur posee en clair dans un appel se serait perdue.
 */
const ARXIV_INTERVALLE_MS = 3_000;

/**
 * Duree de cache d'arXiv. Le flux ne bouge qu'une fois par jour ouvre ; une
 * heure evite de redemander a chaque article d'une meme vague sans jamais
 * servir une liste veritablement perimee.
 */
const ARXIV_TTL_MS = 3_600_000;

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

/**
 * Duree de cache des donnees de marche, depuis `MARCHE_CACHE_TTL_MINUTES`.
 *
 * Absente ou absurde : `undefined`, et chaque connecteur garde sa duree par
 * defaut — sept jours pour une bougie Binance close, un jour pour CoinGecko,
 * six heures pour Yahoo, qui ajuste ses series. Une valeur illisible n'est pas
 * devinee : un cache de duree inventee est un cache dont on ignore l'etat.
 */
export function ttlDepuisEnv(env: NodeJS.ProcessEnv): number | undefined {
  const brut = env["MARCHE_CACHE_TTL_MINUTES"];
  if (brut === undefined || brut.trim().length === 0) return undefined;
  const minutes = Number(brut);
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  return minutes * 60_000;
}

/** Age maximal admis : les cryptoactifs cotent chaque jour, les places ferment le week-end. */
const AGE_MAX_CRYPTO_MS = 2 * 86_400_000;
const AGE_MAX_BOURSE_MS = 6 * 86_400_000;

const AGE_MAX_PAR_CONNECTEUR: Readonly<Record<string, number>> = {
  binance: AGE_MAX_CRYPTO_MS,
  coingecko: AGE_MAX_CRYPTO_MS,
  yahoo: AGE_MAX_BOURSE_MS,
};

/** Un adaptateur par instrument que le connecteur sait servir. */
function adaptateursDe(connecteur: ConnecteurDeMarche, ageMaxMs: number) {
  return INSTRUMENTS.filter((i) => connecteur.couvre(i)).map((i) =>
    adaptateurDeMarche(connecteur, i, { ageMaxMs }),
  );
}

/**
 * Connecteurs de marche disponibles, et ceux qu'une clef manquante ecarte.
 *
 * SEULE facon de les construire : le catalogue en tire ses adaptateurs, la
 * sonde de sante (`npm run dev -- marches`) les interroge. Deux constructions
 * separees finiraient par diverger — dossier de cache, duree, clef — et la
 * sonde dirait « OK » d'une source que le pipeline n'interroge pas ainsi.
 *
 * Aucune entree/sortie ici : un connecteur ne touche le disque et le reseau
 * qu'a sa premiere requete.
 */
export function connecteursDeMarche(env: NodeJS.ProcessEnv = process.env): {
  connecteurs: ConnecteurDeMarche[];
  ecartes: SkippedSource[];
} {
  const ttlMs = ttlDepuisEnv(env);
  const commun = {
    dossier: join(process.cwd(), ".cache", "marche"),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
  const connecteurs: ConnecteurDeMarche[] = [];
  const ecartes: SkippedSource[] = [];

  // Binance : tier 1 pour sa plateforme, « sur Binance » impose par le gate.
  connecteurs.push(connecteurBinance(commun));

  // CoinGecko : l'agregat multi-plateformes, pour tout chiffre du marche global.
  const clef = env["COINGECKO_API_KEY"];
  if (clef !== undefined && clef.trim().length > 0) {
    connecteurs.push(connecteurCoinGecko({ ...commun, apiKey: clef.trim() }));
  } else {
    ecartes.push({
      id: "coingecko:agregats",
      reason:
        "COINGECKO_API_KEY absente de l'environnement : aucun chiffre du marche " +
        "GLOBAL des cryptoactifs n'est disponible, et Binance ne peut pas en tenir " +
        "lieu (plateforme unique). Clef gratuite du plan Demo sur " +
        "https://www.coingecko.com/en/api — a placer dans .env, jamais dans le code.",
    });
  }

  // Yahoo : SIGNAL de pre-verification, jamais cite (option (b), native).
  connecteurs.push(connecteurYahoo(commun));

  return { connecteurs, ecartes };
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
    // Deux series choisies pour ce que le media couvre, et MESUREES le
    // 2026-09-13 avant d'etre branchees : depenses militaires mondiales
    // (5 annees sur 6 renseignees, 2,47 % du PIB en 2024) et aide publique au
    // developpement recue (4 sur 6, derniere valeur 2023). La premiere dit ce
    // qu'un monde arme coute ; la seconde, ce que la reponse aux crises pese.
    //
    // La dette publique (GC.DOD.TOTL.GD.ZS) N'EST PAS branchee : mesuree le
    // meme jour, elle rend ZERO valeur au niveau mondial. Un adaptateur qui
    // echoue a chaque collecte vaut moins que pas d'adaptateur du tout.
    worldBankAdapter({ country: "WLD", indicator: "MS.MIL.XPND.GD.ZS" }),
    worldBankAdapter({ country: "WLD", indicator: "DT.ODA.ODAT.CD" }),
    imfAdapter({
      country: "FRA",
      indicator: "NGDP_RPCH",
      label: "Croissance du PIB reel",
    }),
    // La dette publique brute, en pourcentage du PIB : meme unite que la
    // croissance, donc comparable sans violer EP-006. MESURE du 2026-09-13 :
    // 52 annees de serie, derniere valeur observee 116 % pour 2025.
    imfAdapter({
      country: "FRA",
      indicator: "GGXWDG_NGDP",
      label: "Dette publique brute, en pourcentage du PIB",
    }),
    // Le meme indicateur pour les Etats-Unis : 123,9 % du PIB en 2025, contre
    // 116 % pour la France (mesure du 2026-09-13). Deux valeurs de MEME unite
    // et de meme annee se comparent legitimement — c'est precisement ce que
    // EP-006 exige avant d'aligner deux chiffres.
    imfAdapter({
      country: "USA",
      indicator: "GGXWDG_NGDP",
      label: "Dette publique brute, en pourcentage du PIB",
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

    // Banque centrale de la zone euro — le BLOG, demande par l'editeur le
    // 2026-09-19. Ce n'est PAS le canal des decisions, et le caveat le dit.
    //
    // MESURE du 2026-09-19 : https://www.ecb.europa.eu/rss/blog.html rend 15
    // billets en application/rss+xml, le plus recent du 2026-09-15. La page du
    // blog elle-meme ne declare AUCUN flux : la BCE sert les siens sous une
    // extension .html, ce qui les rend introuvables par decouverte automatique
    // — d'ou l'adresse en dur ici plutot qu'une detection.
    //
    // Les descriptions de ce flux sont VIDES : titre, date et lien seulement.
    // Le resume se construit donc sur le titre, ce que l'adaptateur fait deja.
    rssAdapter({
      id: "bce:blog",
      source: "BCE",
      url: "https://www.ecb.europa.eu/rss/blog.html",
      describes:
        "Billets du blog de la Banque centrale europeenne : lectures signees de l'economie de la zone euro",
      type: "billet-banque-centrale",
      limit: 2,
      caveat:
        "Billet SIGNE du blog de la BCE : il engage ses auteurs, et n'est ni " +
        "une decision du Conseil des gouverneurs ni une statistique (§3). Pour " +
        "un chiffre ou une decision, remonter au communique ou a la serie " +
        "(EP-001).",
    }),

    // --- Tier 1 : regulateur des marches americains ------------------------
    //
    // MESURE du 2026-09-13 : toutes les surfaces de la SEC repondent HTTP 200
    // a notre agent declare — flux RSS, flux Atom d'EDGAR et API data.sec.gov.
    // Le catalogue affirmait l'inverse depuis le 2026-09-02 (« 403 sans
    // User-Agent nominatif ») : un motif d'ecart PERIME est pire qu'absent,
    // puisqu'il fait renoncer a une source disponible. Il est corrige plus bas.
    //
    // La politique d'acces automatise de la SEC demande neanmoins que l'agent
    // porte une adresse de contact. Le notre annonce le projet, sans adresse :
    // a completer si l'editeur accepte d'en rendre une publique.
    rssAdapter({
      id: "sec:communiques",
      source: "SEC",
      url: "https://www.sec.gov/news/pressreleases.rss",
      describes:
        "Communiques de la SEC : procedures d'application, propositions de regles, coordinations internationales",
      type: "communique-regulateur",
      limit: 3,
    }),
    rssAdapter({
      id: "sec:discours",
      source: "SEC",
      url: "https://www.sec.gov/news/speeches-statements.rss",
      describes: "Discours et declarations des commissaires de la SEC",
      type: "declaration-regulateur",
      limit: 2,
      caveat:
        "Position PERSONNELLE d'un commissaire, et non une decision de la " +
        "Commission : a citer comme telle (§3). Un discours engage celui qui " +
        "le prononce, pas l'institution.",
    }),

    // --- Tier 2 : geopolitique et evenementiel -----------------------------
    //
    // Demande de l'editeur du 2026-09-13 : davantage de geopolitique, et
    // davantage d'articles evenementiels du genre de celui sur les seismes.
    // Un theme sans source ne produit qu'un arret en collecte : les emetteurs
    // se branchent donc AVANT que les sujets n'entrent en rotation.
    //
    // MESURES du 2026-09-13 : ONU Info rend 30 entrees, la plus recente de la
    // veille ; GDACS en rend 206, la plus recente du jour. Les autres flux
    // candidats sont ecartes plus bas, avec leur motif.
    rssAdapter({
      id: "onu:paix-securite",
      source: "ONU Info",
      url: "https://news.un.org/feed/subscribe/fr/news/topic/peace-and-security/feed/rss.xml",
      describes:
        "Actualites des Nations unies sur la paix et la securite, publiees en francais par leur service d'information",
      type: "actualite-institution-internationale",
      limit: 4,
      caveat:
        "Service d'information des Nations unies (tier 2) : il RELATE ce que " +
        "declarent ou decident les organes de l'ONU. Pour un chiffre ou une " +
        "decision, remonter au document de l'organe cite (EP-001).",
    }),
    rssAdapter({
      id: "gdacs:alertes",
      source: "GDACS",
      url: "https://www.gdacs.org/xml/rss.xml",
      describes:
        "Alertes de catastrophes — seismes, cyclones, inondations — du systeme GDACS, opere par l'ONU et la Commission europeenne",
      type: "alerte-catastrophe",
      limit: 4,
      caveat:
        "Alerte AUTOMATIQUE : le niveau (vert, orange, rouge) et la population " +
        "exposee sont des ESTIMATIONS calculees par modele a partir de la " +
        "magnitude et de la densite de population — jamais un bilan constate. " +
        "A citer comme estimation datee (§3), jamais comme un nombre de victimes.",
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
    // Presse economique pakistanaise, demandee par l'editeur le 2026-09-19.
    // Elle couvre une zone que le catalogue ignorait : budget, energie et
    // commerce exterieur d'Asie du Sud.
    //
    // MESURE du 2026-09-19 : /feeds/latest-news rend 30 entrees en
    // application/xml, la plus recente du jour meme. La PAGE d'accueil ainsi
    // que /feed et /rss rendent HTTP 403 a notre agent declare : le site
    // protege son HTML mais sert son flux, et c'est ce flux que l'on consomme.
    //
    // Ses descriptions portent du HTML encode DEUX fois ; `rss.ts` retire les
    // balises apres decodage depuis cette meme date.
    rssAdapter({
      id: "brecorder:latest",
      source: "Business Recorder",
      url: "https://www.brecorder.com/feeds/latest-news",
      describes:
        "Fil d'actualite economique de Business Recorder (Pakistan) : politique budgetaire, energie, commerce exterieur",
      type: "presse",
      limit: 3,
      caveat: PRESSE_CAVEAT,
    }),
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
      // ADRESSE FINALE, et non l'alias `cmlink` : celui-ci rend un 301 vers
      // du HTTP EN CLAIR, que `safeFetch` refuse — une donnee alterable en
      // transit ne peut pas fonder une claim. Resultat : Haaretz echouait a
      // CHAQUE collecte, et chaque article portait une mention « source
      // indisponible » pour une source qui, elle, repondait tres bien.
      // MESURE du 2026-09-13 : l'adresse ci-dessous rend 200 en https, 100 entrees.
      url: "https://www.haaretz.com/srv/haaretz-latest-headlines",
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

    // --- Tier 3 : prepublications scientifiques ----------------------------
    //
    // MESURE du 2026-09-19 : l'API repond 200 en application/atom+xml, et les
    // liens "rel=alternate" sont en HTTPS — les <id>, eux, sont servis en
    // http, et c'est bien le lien que l'adaptateur retient, pas l'identifiant.
    //
    // TIER 3, ET CE N'EST PAS UNE SEVERITE DE PLUS. arXiv est l'emetteur du
    // document, ce qui plaiderait pour un tier haut ; mais le tier dit ce que
    // vaut le contenu pour FONDER UN FAIT, et une prepublication est un travail
    // que personne n'a relu. « Des chercheurs montrent que... » se lit comme un
    // resultat etabli : c'est exactement la phrase que le caveat doit empecher.
    //
    // DEBIT. Les conditions d'usage d'arXiv, relevees le 2026-09-19, imposent
    // « no more than one request every three seconds », et les contourner y est
    // explicitement interdit. Aucun 429 ne viendra nous avertir : on serait
    // simplement en faute. D'ou l'espaceur, et le cache — une vague produit six
    // articles, donc six collectes, pour un flux qui ne change qu'une fois par
    // jour.
    rssAdapter({
      id: "arxiv:ia",
      source: "arXiv",
      url:
        "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL" +
        "&sortBy=submittedDate&sortOrder=descending&max_results=15",
      describes:
        "Prepublications recentes en intelligence artificielle, apprentissage " +
        "automatique et traitement du langage (arXiv cs.AI, cs.LG, cs.CL)",
      type: "prepublication",
      limit: 3,
      intervalleMs: ARXIV_INTERVALLE_MS,
      ttlMs: ARXIV_TTL_MS,
      caveat:
        "PREPUBLICATION arXiv : deposee par ses auteurs, relue par AUCUN comite " +
        "de lecture (§3). Un resultat annonce ici n'est pas un fait etabli ; les " +
        "chiffres sont ceux des auteurs, et la methode n'a ete auditee par " +
        "personne (EP-001).",
    }),
  ];

  const skipped: SkippedSource[] = [];

  // Relations investisseurs d'Oracle, demandees par l'editeur le 2026-09-19 et
  // ECARTEES le jour meme, faute de surface lisible par une machine.
  //
  // MESURE du 2026-09-19, a l'agent declare du projet :
  //  - investor.oracle.com — page d'actualites, /rss/news-releases.xml et
  //    /rss/pressrelease.aspx : HTTP 403 sur les trois ;
  //  - oracle.com/news/rss/ : HTTP 404 ;
  //  - oracle.com/news/ et oracle.com/corporate/press/ : HTTP 200, mais aucun
  //    flux declare dans la page ;
  //  - oracle.com/corporate/press/rss/rss-pr.xml : HTTP 200, servi en
  //    text/html, derniere entree du 25 juillet 2008. Un leurre : le brancher
  //    ferait entrer des depeches vieilles de dix-huit ans, exactement le
  //    piege du flux h41 de la Fed.
  //
  // Contourner ces 403 supposerait d'usurper un navigateur, ce que ce projet
  // n'autorise pas — comme pour le Smithsonian et le Conseil de l'UE.
  //
  // CE QUI RESTE POSSIBLE : les chiffres d'Oracle passent par ses depots a la
  // SEC (10-Q, 8-K), deja branchee et qui repond a notre agent. Une source
  // primaire sur l'entreprise, et non sa propre salle de presse.
  skipped.push({
    id: "oracle:investor-news",
    reason:
      "Oracle (relations investisseurs) : toutes les surfaces machine rendent " +
      "HTTP 403 a un agent declare (mesure du 2026-09-19), et le seul flux qui " +
      "repond est servi en text/html avec une derniere entree datee de 2008. " +
      "Contourner supposerait d'usurper un navigateur. Les chiffres d'Oracle " +
      "restent atteignables par ses depots a la SEC, deja branchee.",
  });

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

  // --- Presse agregee, clef requise --------------------------------------
  // Currents n'est PAS une source primaire : il rend l'URL de l'editeur, et
  // c'est elle qui est citee. Le tier suit donc le domaine de cet editeur, pas
  // Currents — un domaine inconnu du registre retombe en tier 3.
  const currentsKey = env["CURRENTS_API_KEY"];
  if (currentsKey !== undefined && currentsKey.trim().length > 0) {
    adapters.push(
      currentsAdapter({
        apiKey: currentsKey,
        language: "fr",
        type: "presse",
        caveat: PRESSE_CAVEAT,
      }),
    );
  } else {
    skipped.push({
      id: "currents:search",
      reason:
        "CURRENTS_API_KEY absente de l'environnement : la presse agregee est " +
        "indisponible. Clef gratuite sur https://currentsapi.services — a " +
        "placer dans .env, jamais dans le code.",
    });
  }

  // Second agregateur. Currents et newsdata ne moissonnent pas les memes
  // titres : deux reprises independantes d'un meme fait donnent au §5.2 de
  // quoi comparer, la ou un seul agregateur imposerait son perimetre.
  const newsdataKey = env["NEWSDATA_API_KEY"];
  if (newsdataKey !== undefined && newsdataKey.trim().length > 0) {
    adapters.push(
      newsdataAdapter({
        apiKey: newsdataKey,
        language: "fr",
        type: "presse",
        caveat: PRESSE_CAVEAT,
      }),
    );
  } else {
    skipped.push({
      id: "newsdata:latest",
      reason:
        "NEWSDATA_API_KEY absente de l'environnement : le second agregateur de " +
        "presse est indisponible. Clef gratuite sur https://newsdata.io — a " +
        "placer dans .env, jamais dans le code.",
    });
  }

  // --- Donnees de marche --------------------------------------------------
  //
  // Interrogees SEULEMENT si le sujet les appelle (`pertinent`) : un article
  // sur l'Iran ne consomme ni le poids Binance, ni les credits CoinGecko.
  // Voir docs/sources-marche.md pour ce que chacune ne permet PAS d'affirmer.
  //
  // Un connecteur par fournisseur, partage par ses adaptateurs : c'est ce qui
  // fait respecter l'espacement et le disjoncteur quand la passerelle lance
  // plusieurs instruments en parallele.
  const marche = connecteursDeMarche(env);
  for (const connecteur of marche.connecteurs) {
    adapters.push(
      ...adaptateursDe(connecteur, AGE_MAX_PAR_CONNECTEUR[connecteur.id] ?? AGE_MAX_BOURSE_MS),
    );
  }
  skipped.push(...marche.ecartes);

  // --- Sources ecartees pour raisons externes -----------------------------
  // Documentees ici plutot que supprimees : le lecteur du code doit savoir
  // pourquoi une source du §4 n'est pas branchee.
  skipped.push(
    {
      id: "usgs:alerte-pager",
      reason:
        "Un adaptateur filtrant les seismes sur le niveau d'alerte PAGER serait " +
        "le plus interessant editorialement — l'alerte dit l'impact humain " +
        "attendu, pas seulement la magnitude. MESURE du 2026-09-13 : sur douze " +
        "mois, 143 seismes de magnitude 6 ou plus, mais SIX alertes orange et " +
        "QUATRE rouges, soit une poignee par an. Branche, il echouerait a " +
        "presque chaque collecte et ferait porter a chaque article une mention " +
        "« source indisponible » trompeuse — le piege du flux h41 de la Fed. " +
        "Le seuil de magnitude 6, lui, rend 10 evenements sur 30 jours.",
    },
    {
      id: "oms:news",
      reason:
        "Le flux repond (HTTP 200, 25 entrees) mais sa derniere entree datait " +
        "de 199 jours au 2026-09-13 : tres au-dela de la fenetre de fraicheur " +
        "de 30 jours. Branche, il echouerait a chaque collecte et ferait porter " +
        "a chaque article une mention « source indisponible » trompeuse — meme " +
        "motif que fed:h41-notices.",
    },
    {
      id: "smithsonian:volcans",
      reason:
        "volcano.si.edu/news/WeeklyVolcanoRSS.xml rend HTTP 403 « Request " +
        "Rejected » au client du pipeline, alors qu'un autre client HTTP obtient " +
        "200 avec le MEME agent declare (mesure du 2026-09-13) : le filtrage " +
        "porte sur l'empreinte du client, pas sur ce qu'il annonce. Le " +
        "contourner supposerait d'usurper un navigateur, ce que ce projet " +
        "n'autorise pas.",
    },
    {
      id: "consilium:communiques",
      reason:
        "Communiques du Conseil de l'Union europeenne : HTTP 403, page " +
        "« Browser check » (2026-09-13). Meme refus d'un client honnete que " +
        "le Departement d'Etat americain, le HCR et le ministere francais des " +
        "Affaires etrangeres, tous ecartes pour la meme raison.",
    },
    {
      id: "otan-aiea:flux",
      reason:
        "OTAN et AIEA : HTTP 404 sur les adresses de flux probees le " +
        "2026-09-13. Aucune adresse de flux documentee n'a ete trouvee ; a " +
        "rebrancher si l'une d'elles en publie une.",
    },
    {
      id: "ocha:rss",
      reason:
        "Bureau de la coordination des affaires humanitaires (ONU) : HTTP 406 " +
        "au 2026-09-13. Le volet humanitaire est couvert en attendant par ONU " +
        "Info et GDACS.",
    },
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
      id: "sec-edgar:depots",
      reason:
        "EDGAR REPOND : le flux Atom des depots du jour rend 40 entrees, et " +
        "data.sec.gov rend les depots comme les faits XBRL d'une entreprise " +
        "(mesure du 2026-09-13, HTTP 200 avec notre agent declare). Le motif " +
        "precedent — un 403 mesure le 2026-09-02 — n'a plus cours. Ce qui " +
        "manque n'est donc pas un acces mais une DECISION EDITORIALE : quelle " +
        "entreprise, quel formulaire, quelle serie. Brancher le flux entier " +
        "deverserait un torrent de depots sans rapport avec le sujet traite, " +
        "meme motif que le catalogue de jeux de donnees de data.economie.gouv.fr.",
    },
    {
      id: "sec:decisions-administratives",
      reason:
        "Le flux des decisions administratives (rss/litigation/admin.xml) " +
        "repond au 2026-09-13 — 25 entrees, la plus recente datant de deux " +
        "jours — mais chaque entree " +
        "se reduit a un NOM D'ENTREPRISE et pointe vers un PDF : aucun texte " +
        "resumable, et un lien que le pipeline ne sait pas lire. L'observation " +
        "n'y porterait qu'un nom propre, de quoi faire ecrire une imputation " +
        "sans fait — exactement ce que le traitement d'OFAC refuse deja.",
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
