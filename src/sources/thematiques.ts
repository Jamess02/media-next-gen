/**
 * Thematique d'un article, DERIVEE des emetteurs qu'il cite.
 *
 * Dependances : aucune npm. Un seul import interne, `hostMatchesDomain` de
 * `protocol/interests.ts` — celui-la meme dont le registre se sert pour
 * classer les tiers. Reecrire une seconde comparaison d'hotes ici la ferait
 * diverger, et c'est elle qui empeche de confondre `ecb.europa.eu` avec
 * `ec.europa.eu`, ou `comtrade.un.org` avec `news.un.org`.
 *
 * A QUOI CELA SERT. Le studio range les brouillons a relire. Quarante et un
 * attendent, et les faire defiler dans un seul tas rend la relecture penible.
 *
 * POURQUOI LES EMETTEURS, ET NON LE TITRE. Classer d'apres les mots d'un titre
 * est une devinette, et une devinette qui se trompe range l'article sous une
 * rubrique fausse — pire qu'un article non range, parce qu'une etiquette se lit
 * comme une information. Le depot applique deja ce principe aux sources : le
 * tier est DERIVE du domaine, jamais declare.
 *
 * CE QUE CETTE TAXONOMIE N'EST PAS : les `domaine` des themes de vague. La
 * tentation etait forte de les reutiliser ; verification faite, ils classent
 * par ANGLE EDITORIAL et non par emetteur. Le domaine « humanitaire » vise
 * GDACS et l'ONU, le domaine « institutions » vise « les communiques recents
 * des banques centrales ». Les memes emetteurs y servent plusieurs domaines :
 * un rangement derive des sources ne peut pas reproduire cet angle, et
 * pretendre le contraire ferait dire a l'etiquette ce qu'elle ne sait pas.
 *
 * CE QUE CELA NE DIT PAS AU LECTEUR. Rien : ce rangement ne quitte pas le
 * studio. Il n'entre ni dans le contrat §7, ni dans l'article, ni sur le site —
 * une classification sans valeur de preuve n'a pas a voyager avec le texte.
 */

import { hostMatchesDomain } from "../protocol/interests.js";

/** Aucun emetteur reconnu. Affiche tel quel, jamais devine. */
export const NON_CLASSE = "non classe";

/**
 * L'ordre est SIGNIFIANT : il tranche les egalites.
 *
 * Un article qui cite autant de banques centrales que de series economiques
 * doit tomber du meme cote a chaque lecture, sinon l'interface se reorganise
 * d'un rafraichissement a l'autre sans que rien n'ait change.
 */
export const THEMATIQUES = [
  // Le format long, en tete : rare, et c'est ce qu'un relecteur cherche en
  // priorite. Aucun emetteur n'y mene — il vient du MODE de l'article, pas de
  // ses sources.
  "investigateur",
  "banques centrales",
  "macroeconomie",
  "risques naturels",
  "geopolitique",
  "humanitaire",
  "regulation",
  "marches",
] as const;

export type Thematique = (typeof THEMATIQUES)[number];

/**
 * Premiere correspondance gagne — meme convention que le registre des tiers :
 * les cas particuliers precedent les regles generales.
 */
const RANGEMENT: readonly { domaine: string; thematique: Thematique }[] = [
  // Trois hotes en `un.org`, deux rangements. Comtrade est une base de commerce
  // international ; le fil d'actualite onusien couvre la paix et la securite.
  { domaine: "comtrade.un.org", thematique: "macroeconomie" },
  { domaine: "comtradeplus.un.org", thematique: "macroeconomie" },
  { domaine: "comtradeapi.un.org", thematique: "macroeconomie" },
  { domaine: "news.un.org", thematique: "geopolitique" },
  // Onusien lui aussi, mais son objet est l'aide : c'est l'EMETTEUR qui range,
  // pas l'organisation qui le chapeaute.
  { domaine: "reliefweb.int", thematique: "humanitaire" },

  { domaine: "fred.stlouisfed.org", thematique: "banques centrales" },
  { domaine: "stlouisfed.org", thematique: "banques centrales" },
  { domaine: "federalreserve.gov", thematique: "banques centrales" },
  { domaine: "ecb.europa.eu", thematique: "banques centrales" },
  { domaine: "boj.or.jp", thematique: "banques centrales" },

  { domaine: "data.worldbank.org", thematique: "macroeconomie" },
  { domaine: "worldbank.org", thematique: "macroeconomie" },
  { domaine: "imf.org", thematique: "macroeconomie" },
  { domaine: "ec.europa.eu", thematique: "macroeconomie" },
  { domaine: "oecd.org", thematique: "macroeconomie" },

  { domaine: "usgs.gov", thematique: "risques naturels" },
  { domaine: "gdacs.org", thematique: "risques naturels" },
  { domaine: "firms.modaps.eosdis.nasa.gov", thematique: "risques naturels" },
  { domaine: "nasa.gov", thematique: "risques naturels" },

  { domaine: "sanctionslistservice.ofac.treas.gov", thematique: "geopolitique" },
  { domaine: "ofac.treasury.gov", thematique: "geopolitique" },
  { domaine: "treasury.gov", thematique: "geopolitique" },
  { domaine: "treas.gov", thematique: "geopolitique" },

  { domaine: "sec.gov", thematique: "regulation" },

  { domaine: "data-api.binance.vision", thematique: "marches" },
  { domaine: "api.coingecko.com", thematique: "marches" },
  { domaine: "query1.finance.yahoo.com", thematique: "marches" },
  { domaine: "query2.finance.yahoo.com", thematique: "marches" },
];

/**
 * Range un article d'apres les urls de ses sources.
 *
 * CHAQUE EMETTEUR COMPTE UNE FOIS. Un article adosse a trois releves FRED n'est
 * pas trois fois un article de banque centrale : sans ce dedoublonnage, une
 * serie longue ecraserait systematiquement le reste du materiau.
 *
 * La PRESSE et les domaines inconnus ne comptent pas. Un fil de presse couvre
 * tous les sujets : il dit le support, pas la matiere. Un article qui n'en cite
 * pas d'autre ressort `NON_CLASSE`, ce qui est une information exacte.
 */
/**
 * Thematique d'un article : son FORMAT d'abord, ses emetteurs ensuite.
 *
 * Une enquete cite les memes emetteurs qu'une breve — FRED pour la Fed, l'USGS
 * pour un seisme. La ranger par ses sources la noierait parmi vingt breves,
 * alors que c'est le format que le relecteur cherche : deux mille mots
 * demandent une autre attention que trois cents.
 *
 * Rien n'est devine pour autant. Le mode est porte par le contrat §7, comme le
 * tier est porte par le registre : on lit une donnee, on ne l'invente pas.
 *
 * Un article SANS mode — les trente et un brouillons anterieurs a l'ajout du
 * champ — suit ses emetteurs, comme avant.
 */
export function thematiqueDeLArticle(
  mode: string | undefined,
  urls: readonly string[],
): string {
  if (mode === "enquete") return "investigateur";
  return thematiqueDesSources(urls);
}

export function thematiqueDesSources(urls: readonly string[]): string {
  const emetteurs = new Set<string>();
  for (const brut of urls) {
    try {
      emetteurs.add(new URL(brut).hostname.toLowerCase());
    } catch {
      // Une url inanalysable n'est pas une erreur ici : le contrat la refuse
      // ailleurs, et ce module ne fait que ranger.
    }
  }

  const comptes = new Map<string, number>();
  for (const host of emetteurs) {
    const rangee = RANGEMENT.find((r) => hostMatchesDomain(host, r.domaine));
    if (rangee === undefined) continue;
    comptes.set(rangee.thematique, (comptes.get(rangee.thematique) ?? 0) + 1);
  }

  let gagnante: string | undefined;
  let meilleur = 0;
  // Parcours dans l'ordre de THEMATIQUES : a egalite, la premiere l'emporte,
  // donc le resultat ne depend jamais de l'ordre des urls.
  for (const t of THEMATIQUES) {
    const n = comptes.get(t) ?? 0;
    if (n > meilleur) {
      meilleur = n;
      gagnante = t;
    }
  }

  return gagnante ?? NON_CLASSE;
}
