/**
 * Garde-fous : ce qu'un chiffre de marche ne peut pas etre.
 *
 * Dependances : `types.ts` (type uniquement). Aucune dependance npm. Module
 * pur : l'heure courante est un parametre, jamais lue ici.
 *
 * Applique par le PONT (`adaptateur.ts`) a chaque point de chaque connecteur.
 * Un connecteur ne peut donc pas l'oublier, et un fournisseur qui change ses
 * donnees ne peut pas faire entrer un zero ou un prix negatif dans un prompt.
 *
 * Chaque refus rend un MOTIF, pas un booleen : il remonte jusqu'aux
 * incertitudes declarees de l'article. « Donnee indisponible » ne suffit pas a
 * qui veut savoir si la source etait muette ou si elle a dit une absurdite.
 */

import type { PointDeMarche } from "./types.js";

/**
 * Decalage d'horloge tolere entre notre machine et le fournisseur.
 *
 * Cinq minutes : assez pour absorber une horloge mal synchronisee, trop peu
 * pour laisser passer une donnee reellement datee du lendemain.
 */
const TOLERANCE_MS = 5 * 60_000;

export interface OptionsDeVerification {
  /** Age maximal de la donnee. Absent : pas de controle de fraicheur. */
  ageMaxMs?: number;
  toleranceMs?: number;
}

const STRICTEMENT_POSITIVES = new Set(["prix", "niveau", "capitalisation"]);

/** Rend le motif du refus, ou `null` si le point est recevable. */
export function verifierPoint(
  point: PointDeMarche,
  maintenant: Date,
  options: OptionsDeVerification = {},
): string | null {
  const tolerance = options.toleranceMs ?? TOLERANCE_MS;
  const quoi = `${point.mesure} (${point.instrument})`;

  // `typeof` d'abord : `null` et une chaine passeraient `Number.isFinite`
  // apres une conversion que personne n'aurait decidee.
  if (typeof point.valeur !== "number" || !Number.isFinite(point.valeur)) {
    return `valeur absente ou non numerique pour ${quoi} : un trou dans la serie n'est pas un zero`;
  }
  if (point.valeur < 0) {
    return `valeur negative pour ${quoi} (${point.valeur}) : impossible pour cette mesure`;
  }
  if (point.valeur === 0 && STRICTEMENT_POSITIVES.has(point.nature)) {
    return `valeur nulle pour ${quoi} : un ${point.nature} nul n'existe pas sur un marche actif`;
  }

  const donnee = Date.parse(point.horodatageDonnee);
  const requete = Date.parse(point.horodatageRequete);
  if (Number.isNaN(donnee) || Number.isNaN(requete)) {
    return `horodatage illisible pour ${quoi} : une donnee sans date ne se verifie pas`;
  }

  const t = maintenant.getTime();
  if (requete > t + tolerance) {
    return `requete datee du futur pour ${quoi} (${point.horodatageRequete}) : horloge ou cache altere`;
  }
  if (donnee > t + tolerance) {
    return `donnee datee du futur pour ${quoi} (${point.horodatageDonnee})`;
  }
  if (donnee > requete + tolerance) {
    return (
      `donnee posterieure a la requete qui l'a obtenue pour ${quoi} ` +
      `(${point.horodatageDonnee} > ${point.horodatageRequete}) : impossible par construction`
    );
  }
  if (options.ageMaxMs !== undefined && t - donnee > options.ageMaxMs) {
    const heures = Math.round((t - donnee) / 3_600_000);
    return `donnee perimee pour ${quoi} : ${heures} h d'age, au-dela du maximum admis`;
  }

  return null;
}

export interface Bougie {
  ouverture: number;
  haut: number;
  bas: number;
  cloture: number;
}

/**
 * Coherence interne d'une bougie : le plus bas sous le plus haut, ouverture et
 * cloture entre les deux. Une bougie qui viole cela est corrompue, quelle que
 * soit la plausibilite de chacun de ses chiffres pris seul.
 */
export function verifierBougie(b: Bougie): string | null {
  const { ouverture, haut, bas, cloture } = b;
  if (bas > haut) {
    return `bougie incoherente : plus bas (${bas}) au-dessus du plus haut (${haut})`;
  }
  for (const [nom, v] of [
    ["ouverture", ouverture],
    ["cloture", cloture],
  ] as const) {
    if (v < bas || v > haut) {
      return `bougie incoherente : ${nom} (${v}) hors de la fourchette [${bas} ; ${haut}]`;
    }
  }
  return null;
}
