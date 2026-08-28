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
  async append(record: ChangelogRecord): Promise<void> {
    await this.ensureFile();
    await appendFile(this.path, renderEntry(record), "utf8");
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

function renderEntry(record: ChangelogRecord): string {
  const label: Record<ChangelogType, string> = {
    factuelle: "Correction factuelle",
    méthodologique: "Revision methodologique",
    éditoriale: "Mise a jour editoriale",
  };
  return [
    "",
    `## ${record.date} — ${label[record.type]}`,
    "",
    `**Article** : ${record.article_title} (\`${record.article_id}\`)`,
    "",
    record.description,
    "",
  ].join("\n");
}
