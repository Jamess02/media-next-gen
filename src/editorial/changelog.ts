/**
 * §6 + §9.6 — Changelog editorial.
 *
 * "Le changelog editorial est un fichier versionne dans le repo
 * (ex : changelog-editorial.md), pas une simple variable en memoire."
 *
 * Deux proprietes non negociables :
 *
 *  - APPEND-ONLY. Aucune methode de ce module ne reecrit ni ne supprime une
 *    entree existante. EP-004 interdit l'ecrasement silencieux ; la seule
 *    facon de le garantir est de ne pas fournir l'outil pour le faire.
 *  - PUBLIC ET LISIBLE. Le fichier est du markdown destine au site, pas un
 *    format interne. Une correction que le lecteur ne peut pas lire n'est pas
 *    une correction publique.
 */

import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChangelogType } from "../protocol/constants.js";
import type { ChangelogEntry } from "../protocol/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, "..", "..", "changelog-editorial.md");

const HEADER = `# Changelog editorial

Journal public des corrections, conformement au §6 du Protocole Editorial v1.0.

Trois categories :

- **factuelle** — erreur de chiffre, date, attribution, citation ou lien.
- **methodologique** — changement de source, de methode de calcul ou de perimetre d'un agent.
- **editoriale** — ajout de contexte, nouvelle source, changement de scenario, clarification.

Une correction remplace la lecture erronee mais ne supprime jamais l'historique :
l'article conserve sa date de publication d'origine et affiche sa date de revision.

Ce fichier est append-only. Aucune entree n'est jamais modifiee ni retiree.

---
`;

export interface ChangelogRecord extends ChangelogEntry {
  /** Article concerne. Une correction sans cible n'est pas verifiable. */
  article_id: string;
  article_title: string;
}

export class EditorialChangelog {
  constructor(private readonly path: string = DEFAULT_PATH) {}

  /** Cree le fichier avec son en-tete s'il n'existe pas. Jamais destructif. */
  private async ensureFile(): Promise<void> {
    if (existsSync(this.path)) return;
    await writeFile(this.path, HEADER, "utf8");
  }

  /**
   * Ajoute une entree. Seule operation d'ecriture exposee par ce module :
   * il n'existe volontairement ni `update` ni `delete`.
   */
  /**
   * Ajoute une entree, scellee sur la precedente.
   *
   * Le maillon precedent est relu du FICHIER a chaque ajout, jamais garde en
   * memoire : deux processus qui ecriraient tour a tour — le pipeline et une
   * validation manuelle — produiraient sinon deux chaines paralleles, chacune
   * partant de ce que son processus croyait etre le dernier etat.
   */
  async append(record: ChangelogRecord): Promise<void> {
    await this.ensureFile();
    const prev = lastChainHash(await readFile(this.path, "utf8"));
    await appendFile(this.path, renderEntry(record, prev), "utf8");
  }

  /** Enregistre la publication initiale d'un article. */
  async recordPublication(input: {
    articleId: string;
    articleTitle: string;
    publishedAt: string;
    note: string;
  }): Promise<void> {
    await this.append({
      article_id: input.articleId,
      article_title: input.articleTitle,
      date: input.publishedAt,
      type: "éditoriale",
      description: `Publication initiale. ${input.note}`,
    });
  }

  async read(): Promise<string> {
    await this.ensureFile();
    return readFile(this.path, "utf8");
  }
}

/* -------------------------------------------------------------------------
 * §9.6 — chainage d'empreintes
 *
 * Ce registre est append-only PAR L'API : le module n'expose ni `update` ni
 * `delete`. Mais c'est un fichier markdown, et une ligne s'y edite ou s'y
 * supprime sans laisser de trace. Or reecrire une correction publiee, c'est
 * reecrire l'histoire editoriale — exactement ce que EP-004 interdit.
 *
 * Chaque entree scelle donc la precedente, comme le journal d'audit.
 *
 * LE MARQUEUR EST UN COMMENTAIRE HTML, et ce n'est pas un detail de forme : le
 * §9.6 veut un registre LISIBLE par un humain. Une empreinte de 64 caracteres
 * affichee sous chaque entree le rendrait illisible, donc inconsulte — et un
 * registre que personne ne lit ne rend de comptes a personne. Invisible au
 * rendu, presente dans le fichier : les deux exigences tiennent ensemble.
 *
 * MEME PORTEE, MEMES LIMITES QUE LE JOURNAL. Modification, suppression,
 * insertion et reordonnancement sont detectes. Une reecriture COMPLETE avec
 * recalcul de la chaine, ou une troncature finale, ne le sont pas : il y
 * faudrait une signature ou une ancre externe.
 * ---------------------------------------------------------------------- */

export const CHANGELOG_GENESIS = "0".repeat(64);

const MARQUEUR = /<!-- chaine: prev=([0-9a-f]{64}) entree=([0-9a-f]{64}) -->/g;

/** Empreinte d'une entree : son texte visible, plus le maillon precedent. */
function entryHash(texte: string, prev: string): string {
  return createHash("sha256").update(`${prev}\n${texte}`).digest("hex");
}

export interface ChangelogVerification {
  ok: boolean;
  /** Entrees chainees effectivement verifiees. */
  checked: number;
  /** Index (0-base) de la premiere anomalie. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verifie la chaine d'un registre.
 *
 * Un fichier sans aucun marqueur est declare INTACT avec zero entree verifiee :
 * le registre existant a ete ecrit avant cette protection, et le declarer
 * corrompu serait faux. Un outil qui crie au loup sur des donnees legitimes
 * finit desactive.
 */
export function verifyChangelog(contenu: string): ChangelogVerification {
  const marqueurs = [...contenu.matchAll(MARQUEUR)];
  if (marqueurs.length === 0) return { ok: true, checked: 0 };

  let precedent = CHANGELOG_GENESIS;

  for (const [index, m] of marqueurs.entries()) {
    // Le marqueur OUVRE son entree, il ne la ferme pas. Le texte scelle va donc
    // de la fin de ce marqueur au debut du suivant — ou a la fin du fichier.
    //
    // Fermer l'entree paraissait plus naturel et etait faux : le texte de la
    // PREMIERE entree englobait alors tout l'en-tete du fichier, que
    // l'ecriture n'avait pas scelle. Ouvrir supprime l'ambiguite sans avoir a
    // deviner ou l'en-tete se termine.
    const suivant = marqueurs[index + 1];
    const debut = m.index + m[0].length;
    const texte = contenu.slice(debut, suivant?.index ?? contenu.length);
    const prev = m[1] ?? "";
    const propre = m[2] ?? "";

    if (prev !== precedent) {
      return {
        ok: false,
        checked: index,
        brokenAt: index,
        reason:
          `chaine rompue a l'entree ${index} : elle annonce ${prev.slice(0, 12)}… ` +
          `comme precedent, la chaine attend ${precedent.slice(0, 12)}…`,
      };
    }
    if (entryHash(texte, prev) !== propre) {
      return {
        ok: false,
        checked: index,
        brokenAt: index,
        reason: `entree ${index} modifiee : son empreinte ne correspond plus a son texte`,
      };
    }

    precedent = propre;
  }

  return { ok: true, checked: marqueurs.length };
}

/** Dernier maillon d'un registre existant, ou la genese s'il n'y en a pas. */
export function lastChainHash(contenu: string): string {
  const marqueurs = [...contenu.matchAll(MARQUEUR)];
  return marqueurs.at(-1)?.[2] ?? CHANGELOG_GENESIS;
}

function renderEntry(record: ChangelogRecord, prev: string): string {
  const label: Record<ChangelogType, string> = {
    factuelle: "Correction factuelle",
    méthodologique: "Revision methodologique",
    éditoriale: "Mise a jour editoriale",
  };
  const texte = [
    "",
    `## ${record.date} — ${label[record.type]}`,
    "",
    `**Article** : ${record.article_title} (\`${record.article_id}\`)`,
    "",
    record.description,
    "",
  ].join("\n");

  // Le marqueur OUVRE l'entree ; voir `verifyChangelog` pour la raison.
  //
  // AUCUN caractere avant le marqueur. Un simple `\n` de presentation en tete
  // appartenait a CETTE entree a l'ecriture, mais tombait dans le texte de la
  // PRECEDENTE a la relecture — un octet de decalage, et toute la chaine
  // echouait. `texte` commence deja par un saut de ligne, la separation est
  // donc assuree sans rien ajouter.
  return `<!-- chaine: prev=${prev} entree=${entryHash(texte, prev)} -->${texte}`;
}
