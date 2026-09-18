/**
 * INFOGRAPHIE — ecart mesure entre une valeur ANTICIPEE et une valeur REALISEE,
 * et decomposition de cet ecart.
 *
 * Dependances : aucune, ni npm ni interne. Module PUR — pas de reseau, pas de
 * LLM, pas de fichier. C'est la meme raison que pour `rules.ts` et le tri des
 * chiffres : un graphique est l'element le plus autoritaire d'une page. Aligne,
 * chiffre, colore, il a l'apparence d'une donnee verifiee, et le lecteur y
 * accorde la confiance qu'il refuserait a une phrase. Ce qu'il montre doit donc
 * venir d'un calcul teste, jamais d'un modele.
 *
 * LES REGLES DURES, telles que l'editeur les a posees le 2026-09-18 :
 *
 *  1. SANS ANTICIPATION DATEE ET SOURCEE, AUCUN ECART. Comparer une valeur
 *     publiee a une attente dont on ne sait ni d'ou elle vient ni quand elle a
 *     ete figee, c'est fabriquer une surprise apres coup. Le refus est explicite
 *     et motive : l'article publiera l'evolution simple, en disant qu'aucune
 *     anticipation n'etait disponible.
 *  2. LES COMPOSANTES S'ADDITIONNENT, ET LE RESIDU EST TOUJOURS AFFICHE. Une
 *     decomposition qui « explique tout » est une decomposition arrangee. Le
 *     residu porte ce qu'on ne sait pas attribuer, y compris quand il est nul.
 *  3. CHAQUE COMPOSANTE PORTE SA METHODE ET SA SOURCE. `publiee` (contribution
 *     officielle), `estimee` (calcul interne, methode decrite dans la source) ou
 *     `incertaine`. Les estimations internes sont rendues separement pour que le
 *     graphique ET le texte les etiquettent — jamais comme un chiffre officiel.
 *  4. ZERO COMPOSANTE EST UNE REPONSE VALABLE. Mieux vaut un ecart nu qu'une
 *     decomposition inventee pour remplir un schema.
 *
 * PRECISION (EP-005). L'ecart et le residu sont arrondis a la precision la plus
 * fine des valeurs qui les composent. Sans cela, la soustraction flottante
 * afficherait un residu de 0,00000000000000004 la ou il vaut zero — une
 * precision que la mesure n'a pas.
 */

export type MethodeComposante = "publiee" | "estimee" | "incertaine";

export const METHODES: readonly MethodeComposante[] = ["publiee", "estimee", "incertaine"];

/** Une valeur ne vaut que datee et sourcee : c'est le §2 applique au graphique. */
export interface ValeurDatee {
  value: number;
  /** URL ou emetteur. Pour une estimation interne : la methode, en clair. */
  source: string;
  /** `frozen_at` pour une anticipation, `published_at` pour un realise. */
  date: string;
  /** Unite, si elle differe de celle de l'indicateur. Sert a REFUSER (EP-006). */
  unite?: string;
}

export interface Composante {
  name: string;
  value: number;
  method: MethodeComposante;
  source: string;
}

export interface EntreeEcart {
  /** Identifiant stable, repris dans le suivi entre editions. */
  indicateur: string;
  /** Libelle lisible, affiche au lecteur. */
  libelle: string;
  unite: string;
  anticipe: ValeurDatee;
  realise: ValeurDatee;
  composantes: readonly Composante[];
}

export interface EcartCalcule extends EntreeEcart {
  ecart: number;
  residu: number;
  /** Noms des composantes ESTIMEES, a etiqueter dans le graphique et le texte. */
  estimationsInternes: readonly string[];
}

export type ResultatEcart =
  | { ok: true; ecart: EcartCalcule }
  | { ok: false; motif: string };

const vide = (s: unknown): boolean => typeof s !== "string" || s.trim().length === 0;

const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Nombre de decimales reellement ecrites dans une valeur. */
function decimales(v: number): number {
  const texte = String(v);
  if (texte.includes("e") || texte.includes("E")) return 0;
  const point = texte.indexOf(".");
  return point < 0 ? 0 : texte.length - point - 1;
}

/** Arrondi a `d` decimales, en ramenant -0 a 0 : un ecart nul s'ecrit « 0 ». */
function arrondir(v: number, d: number): number {
  const facteur = 10 ** Math.min(d, 12);
  return Math.round(v * facteur) / facteur + 0;
}

/** Controle une valeur datee, et rend le motif de refus s'il y en a un. */
function verifierValeur(v: ValeurDatee, quoi: string, unite: string): string | null {
  if (!nombre(v?.value)) {
    return `valeur ${quoi} absente ou non numerique : un trou dans la mesure n'est pas un zero`;
  }
  if (vide(v.source)) {
    return (
      `valeur ${quoi} sans source : sans elle, l'ecart compare un chiffre publie a ` +
      `une attente dont personne ne peut dire d'ou elle vient`
    );
  }
  if (vide(v.date)) {
    return (
      `valeur ${quoi} non datee : une anticipation non figee dans le temps se ` +
      `reecrit apres coup, et l'ecart devient une surprise fabriquee`
    );
  }
  if (v.unite !== undefined && v.unite.trim() !== unite.trim()) {
    return (
      `unite incompatible pour ${quoi} : « ${v.unite} » contre « ${unite} ». ` +
      `Soustraire deux unites differentes n'est pas une imprecision, c'est une ` +
      `erreur de categorie (EP-006)`
    );
  }
  return null;
}

/**
 * Calcule l'ecart et sa decomposition, ou REFUSE en disant pourquoi.
 *
 * Le refus n'est pas une panne : il est prevu par le brief. L'article publie
 * alors l'evolution simple et declare l'absence d'anticipation.
 */
export function calculerEcart(entree: EntreeEcart): ResultatEcart {
  if (vide(entree.indicateur) || vide(entree.libelle) || vide(entree.unite)) {
    return { ok: false, motif: "indicateur, libelle ou unite manquant" };
  }

  const motifAnticipe = verifierValeur(entree.anticipe, "anticipee", entree.unite);
  if (motifAnticipe !== null) return { ok: false, motif: `anticipation refusee — ${motifAnticipe}` };

  const motifRealise = verifierValeur(entree.realise, "realisee", entree.unite);
  if (motifRealise !== null) return { ok: false, motif: `realise refuse — ${motifRealise}` };

  for (const c of entree.composantes) {
    if (vide(c?.name)) return { ok: false, motif: "composante sans nom" };
    if (!nombre(c.value)) {
      return { ok: false, motif: `composante « ${c.name} » : valeur absente ou non numerique` };
    }
    if (!METHODES.includes(c.method)) {
      return {
        ok: false,
        motif:
          `composante « ${c.name} » : methode « ${String(c.method)} » inconnue. ` +
          `Attendu : ${METHODES.join(", ")}`,
      };
    }
    if (vide(c.source)) {
      return {
        ok: false,
        motif:
          `composante « ${c.name} » sans source : une contribution non tracable ne ` +
          `peut pas figurer dans un graphique, meme etiquetee « estimee »`,
      };
    }
  }

  // Precision commune : celle de la valeur la plus fine qui entre dans le calcul.
  const precision = Math.max(
    decimales(entree.anticipe.value),
    decimales(entree.realise.value),
    ...entree.composantes.map((c) => decimales(c.value)),
    0,
  );

  const ecart = arrondir(entree.realise.value - entree.anticipe.value, precision);
  const somme = entree.composantes.reduce((total, c) => total + c.value, 0);
  const residu = arrondir(ecart - somme, precision);

  return {
    ok: true,
    ecart: {
      ...entree,
      ecart,
      residu,
      estimationsInternes: entree.composantes
        .filter((c) => c.method === "estimee")
        .map((c) => c.name),
    },
  };
}
