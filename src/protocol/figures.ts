/**
 * Classement des chiffres traites par un article.
 *
 * Module PUR : pas de reseau, pas de LLM, pas de fichier. Meme raison que pour
 * `rules.ts` — le tri est une garantie, pas une suggestion.
 *
 * POURQUOI LE TRI EST FAIT ICI ET NON PAR LE REDACTEUR
 *
 * Un tableau ecrit par un modele serait un tableau invente. Celui-ci a deja
 * produit un « niveau le plus eleve depuis la crise de 2008 » que rien
 * n'etablissait, et un « 6 737 204 (unites) » sans unite. Lui demander
 * d'aligner des chiffres dans le bon ordre ajouterait DEUX facons de se tromper
 * — la valeur et le rang — a une sortie qui a l'apparence de la rigueur, donc
 * qu'on relit moins.
 *
 * Ici, la valeur vient d'un champ structure et valide (§7 `figure`), et l'ordre
 * vient de `sort`. Le modele choisit ce qu'il mesure ; il ne choisit pas qui
 * arrive premier.
 *
 * CE QUE LE TABLEAU DOIT MONTRER, ET POURQUOI (EP-006)
 *
 * Aligner deux nombres AFFIRME leur comparabilite. « PIB mondial 2,92 % » et
 * « PIB francais 0,9 % » viennent de deux institutions, avec deux methodes, et
 * le second est une estimation. Chaque ligne porte donc son type, son niveau de
 * preuve et sa source : sans ces colonnes, le tableau egalise une donnee
 * observee et un chiffre approche, et transforme une juxtaposition en
 * classement.
 */

import type { Article, Figure } from "./schema.js";

export interface RankedFigure extends Figure {
  claimId: string;
  type: Article["claims"][number]["type"];
  evidenceLevel: Article["claims"][number]["evidence_level"];
  /** URLs des sources de la claim, pour que chaque ligne reste remontable. */
  sources: readonly string[];
}

/**
 * Chiffres de l'article, du plus grand au plus petit.
 *
 * Le tri est STABLE a valeurs egales : l'ordre des claims tranche alors, ce qui
 * est arbitraire mais reproductible — deux generations du meme article doivent
 * produire le meme tableau, sinon l'empreinte de relecture change sans que rien
 * n'ait bouge.
 */
export function rankedFigures(article: Article): readonly RankedFigure[] {
  return article.claims
    .flatMap((claim) =>
      claim.figure === undefined
        ? []
        : [
            {
              ...claim.figure,
              claimId: claim.id,
              type: claim.type,
              evidenceLevel: claim.evidence_level,
              sources: claim.sources.map((s) => s.url),
            },
          ],
    )
    .sort((a, b) => b.value - a.value);
}

/**
 * Unites distinctes presentes parmi les chiffres.
 *
 * Sert au controle de comparabilite : ranger des pourcentages avec des millions
 * de dollars n'est pas un classement, c'est une erreur de categorie.
 */
export function figureUnits(article: Article): readonly string[] {
  return [
    ...new Set(
      article.claims
        .map((c) => c.figure?.unit)
        .filter((u): u is string => u !== undefined)
        .map((u) => u.trim().toLowerCase()),
    ),
  ];
}

/**
 * Formatage d'une valeur pour l'affichage.
 *
 * Separateur decimal francais et espaces de milliers insecables : « 6 737 204 »
 * et non « 6737204 ». La precision n'est PAS retouchee — arrondir ici
 * inventerait ou detruirait de la precision, ce que EP-005 refuse dans les deux
 * sens.
 */
export function formatFigure(value: number): string {
  const [entier, decimales] = String(value).split(".");
  const groupe = (entier ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return decimales === undefined ? groupe : `${groupe},${decimales}`;
}
