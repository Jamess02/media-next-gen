/**
 * Les OBSERVATIONS DES RELECTEURS, rendues au pipeline qui ecrit la suite.
 *
 * Dependances : aucune npm, aucun import interne. Node seulement (`fs`, `path`).
 *
 * CE QUE CE MODULE REPARE. Jusqu'au 2026-09-19, la note laissee en validant un
 * article etait ecrite dans l'attestation, inscrite au changelog public et
 * affichee sur le site — mais personne ne la relisait. Elle etait archivee, pas
 * prise en compte.
 *
 * Le cas est documente : la note du 2026-09-13 demandait de traiter « les
 * consequences des seismes dans les regions touchees et les actions mises en
 * place par les gouvernements ». Les articles suivants n'en ont rien fait, et
 * le manque a ete signale plus tard comme s'il venait de nulle part.
 *
 * TROIS BORNES, et chacune a sa raison.
 *
 *  1. LES PLUS RECENTES D'ABORD, et trois au plus. Sans plafond, chaque
 *     relecture alourdirait le prompt de la suivante, et une remarque d'il y a
 *     deux mois pesorait autant que celle d'hier.
 *  2. CHAQUE NOTE EST TRONQUEE. Une consigne demesuree noierait la matiere
 *     source, qui reste ce sur quoi l'article se fonde.
 *  3. UNE NOTE VIDE N'EN EST PAS UNE. Une relecture silencieuse est le cas
 *     ordinaire ; la compter diluerait les vraies consignes.
 *
 * CE QUE CE MODULE NE DECIDE PAS. Ce qu'une consigne autorise. Elle oriente
 * l'ecriture — un angle a couvrir, un manque a combler — et ne leve aucune
 * regle : les controles du §9.3 sont du code, et s'appliquent APRES le modele.
 * Le cadrage est ecrit dans les instructions du Redacteur ; la garantie, elle,
 * tient a l'ordre des etapes.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Trois consignes au plus, les plus recentes. */
export const MAX_CONSIGNES = 3;

/** Au-dela, la consigne est coupee : elle ne doit pas noyer la matiere. */
const LONGUEUR_MAX = 400;

interface NoteDatee {
  note: string;
  relecteur: string;
  date: string;
}

/**
 * Lit les notes des attestations de relecture, de la plus recente a la plus
 * ancienne.
 *
 * Tolerant PAR NECESSITE : repertoire absent, fichier tronque, champ manquant.
 * Un registre illisible ne doit pas priver la production de toutes les autres
 * consignes, et surtout pas empecher un article d'etre ecrit. Les consignes
 * ameliorent l'article ; elles ne conditionnent pas son existence.
 */
export async function lireConsignes(
  publishedDir: string,
  max: number = MAX_CONSIGNES,
): Promise<string[]> {
  if (!existsSync(publishedDir)) return [];

  let fichiers: string[];
  try {
    fichiers = (await readdir(publishedDir)).filter((f) => f.endsWith(".review.json"));
  } catch {
    return [];
  }

  const notes: NoteDatee[] = [];
  for (const f of fichiers) {
    try {
      const brut = JSON.parse(await readFile(join(publishedDir, f), "utf8")) as {
        note?: unknown;
        reviewer?: unknown;
        reviewed_at?: unknown;
      };

      const note = typeof brut.note === "string" ? brut.note.trim() : "";
      if (note.length === 0) continue;

      notes.push({
        note: note.length > LONGUEUR_MAX ? `${note.slice(0, LONGUEUR_MAX)}…` : note,
        // Une consigne ENGAGE quelqu'un : le nom voyage avec elle, comme dans
        // l'attestation dont elle vient.
        relecteur: typeof brut.reviewer === "string" ? brut.reviewer : "relecteur",
        date: typeof brut.reviewed_at === "string" ? brut.reviewed_at : "",
      });
    } catch {
      // Attestation illisible : ignoree, jamais fatale.
    }
  }

  notes.sort((a, b) => b.date.localeCompare(a.date));

  return notes
    .slice(0, max)
    .map((n) => `${n.date.slice(0, 10)} — ${n.relecteur} : ${n.note}`);
}
