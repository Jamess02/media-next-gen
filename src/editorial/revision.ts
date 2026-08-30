/**
 * §6 — Politique de correction, cote execution.
 *
 * "Une correction REMPLACE la lecture erronee mais ne supprime jamais
 * l'historique : l'article garde sa date de publication d'origine + une date
 * de revision visible."
 *
 * Traduction en invariants que ce module garantit :
 *
 *  - `published_at` n'est JAMAIS modifie. La fonction le reinjecte depuis la
 *    version publiee, quoi qu'on lui passe.
 *  - `revised_at` est pose a l'instant de la correction.
 *  - Le changelog de l'article est APPENDE, jamais remplace.
 *  - Le changelog public du repo recoit la meme entree (§9.6).
 *  - L'article corrige repasse par le gate editorial complet. Une correction
 *    qui casserait le protocole est refusee : corriger n'autorise pas a
 *    publier ce qui n'aurait pas pu l'etre.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderArticle } from "../agents/editeur.js";
import { PublicationRefused } from "../agents/editeur.js";
import type { ChangelogType } from "../protocol/constants.js";
import { runEditorialGate } from "../protocol/rules.js";
import { ArticleSchema, type Article } from "../protocol/schema.js";
import { EditorialChangelog } from "./changelog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = join(HERE, "..", "..", "output");

export class ArticleNotFound extends Error {
  constructor(articleId: string, path: string) {
    super(`Article "${articleId}" introuvable (${path}).`);
    this.name = "ArticleNotFound";
  }
}

export class InvalidArticleId extends Error {
  constructor(articleId: string, detail: string) {
    super(`Identifiant d'article refuse : ${detail} (recu : "${articleId}").`);
    this.name = "InvalidArticleId";
  }
}

/**
 * Forme des identifiants produits par le pipeline : `article-<uuid v4>`.
 * Voir `randomUUID()` dans pipeline.ts.
 */
const ARTICLE_ID_PATTERN =
  /^article-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resout le chemin d'un article en refusant toute sortie du repertoire.
 *
 * DEUX BARRIERES, volontairement redondantes :
 *
 *  1. l'identifiant doit correspondre exactement au format produit par le
 *     pipeline — ce qui exclut deja `../`, les separateurs et les caracteres
 *     de chemin ;
 *  2. le chemin resolu doit rester sous `outputDir`.
 *
 * La seconde ne sert a rien si la premiere est correcte. C'est le principe :
 * une regex peut avoir un trou, une comparaison de chemin resolu n'en a pas.
 *
 * Sans cela, `revise "../../../Windows/System32/x"` ecrivait hors du projet —
 * et cette fonction ECRIT. Aujourd'hui l'appelant est un humain a son propre
 * terminal ; des que la revision sera declenchee par une interface, une file
 * ou un job planifie, ce serait une ecriture arbitraire.
 */
function resolveArticlePaths(
  articleId: string,
  outputDir: string,
): { jsonPath: string; markdownPath: string } {
  if (!ARTICLE_ID_PATTERN.test(articleId)) {
    throw new InvalidArticleId(
      articleId,
      "format attendu article-<uuid>, produit par le pipeline",
    );
  }

  const root = resolve(outputDir);
  const jsonPath = resolve(root, `${articleId}.json`);
  const markdownPath = resolve(root, `${articleId}.md`);

  for (const candidate of [jsonPath, markdownPath]) {
    if (candidate !== join(root, basename(candidate))) {
      throw new InvalidArticleId(articleId, "chemin sortant du repertoire de publication");
    }
  }
  return { jsonPath, markdownPath };
}

export interface RevisionInput {
  articleId: string;
  /** §6 — factuelle | methodologique | editoriale. */
  type: ChangelogType;
  /** Ce qui change et pourquoi. Publie tel quel : ecrire pour le lecteur. */
  description: string;
  /**
   * Modification du contenu. Recoit l'article publie, rend la version corrigee.
   * Les champs proteges (`id`, `published_at`, `changelog`) sont de toute facon
   * reimposes ensuite : la fonction ne peut pas reecrire l'histoire.
   */
  edit?: (article: Article) => Article;
  outputDir?: string;
  changelog?: EditorialChangelog;
}

export interface RevisionResult {
  article: Article;
  jsonPath: string;
  markdownPath: string;
  /** Nombre total de corrections portees par l'article apres celle-ci. */
  revisionCount: number;
}

export async function reviseArticle(
  input: RevisionInput,
): Promise<RevisionResult> {
  const outputDir = input.outputDir ?? DEFAULT_OUTPUT_DIR;
  const changelog = input.changelog ?? new EditorialChangelog();
  const { jsonPath, markdownPath } = resolveArticlePaths(
    input.articleId,
    outputDir,
  );

  let published: unknown;
  try {
    published = JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    throw new ArticleNotFound(input.articleId, jsonPath);
  }

  const original = ArticleSchema.parse(published);
  const edited = input.edit ? input.edit(structuredClone(original)) : original;
  const revisedAt = new Date().toISOString();

  // Les champs d'historique sont reimposes APRES l'edition : meme une fonction
  // `edit` malveillante ou boguee ne peut ni changer l'identite de l'article,
  // ni antidater sa publication, ni effacer une correction anterieure.
  const candidate: Article = {
    ...edited,
    id: original.id,
    published_at: original.published_at,
    revised_at: revisedAt,
    changelog: [
      ...original.changelog,
      {
        date: revisedAt,
        type: input.type,
        description: input.description,
      },
    ],
  };

  const parsed = ArticleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PublicationRefused(
      parsed.error.issues.map((issue) => ({
        rule: "SCHEMA_INVALID",
        clause: "§7",
        severity: "blocking" as const,
        message: issue.message,
        path: issue.path.join("."),
      })),
    );
  }

  // Une correction ne dispense pas du protocole.
  const gate = runEditorialGate(parsed.data);
  if (!gate.passed) throw new PublicationRefused(gate.violations);

  const article = parsed.data;
  await writeFile(jsonPath, JSON.stringify(article, null, 2), "utf8");
  await writeFile(markdownPath, renderArticle(article), "utf8");

  await changelog.append({
    article_id: article.id,
    article_title: article.title,
    date: revisedAt,
    type: input.type,
    description: input.description,
  });

  return {
    article,
    jsonPath,
    markdownPath,
    revisionCount: article.changelog.length,
  };
}
