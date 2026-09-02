/**
 * Relecture humaine et promotion d'un article.
 *
 * Dependances : le schema §7, le gate editorial, le changelog. Aucune npm.
 *
 * DEUX ESPACES DISTINCTS, ET C'EST LE POINT
 *
 *  - `output/`   : sortie du pipeline. Espace de TRAVAIL, non versionne. Un
 *                  article y est un brouillon, quelle que soit sa conformite.
 *  - `articles/` : articles RELUS PAR UN HUMAIN. Versionne, et seule source du
 *                  site public.
 *
 * Le pipeline ne peut ecrire que dans le premier. Rien ne passe dans le second
 * sans une action humaine explicite.
 *
 * POURQUOI CETTE SEPARATION EXISTE
 *
 * Trois executions avec de vrais modeles ont produit trois fautes distinctes :
 * un chiffre partiel type `fait`, une recommandation implicite dans un titre,
 * et un taux invente adosse a des sources qui n'en parlent pas. Deux ont ete
 * rattrapees par du code. La troisieme ne pouvait pas l'etre : verifier qu'une
 * source soutient PRECISEMENT une affirmation (§2, niveau 3) est un jugement,
 * pas une fonction.
 *
 * LA RELECTURE PORTE SUR UN CONTENU PRECIS
 *
 * L'attestation enregistre l'empreinte SHA-256 de l'article relu. Modifier
 * l'article ensuite invalide la relecture, et le site refuse de le publier :
 * une relecture atteste d'un texte, pas d'un identifiant.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runEditorialGate, type Violation } from "../protocol/rules.js";
import { ArticleSchema, type Article } from "../protocol/schema.js";
import { PublicationRefused } from "../agents/editeur.js";
import { EditorialChangelog } from "./changelog.js";
import { InvalidArticleId } from "./revision.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACINE = join(HERE, "..", "..");

export const ARTICLE_ID_PATTERN =
  /^article-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attestation de relecture, deposee a cote de l'article. */
export interface ReviewRecord {
  article_id: string;
  article_title: string;
  /** Qui a relu. Une relecture anonyme n'engage personne. */
  reviewer: string;
  reviewed_at: string;
  /** Empreinte du contenu relu : une modification ulterieure l'invalide. */
  content_sha256: string;
  /** Observations du relecteur, publiees avec l'article. */
  note: string | null;
}

/**
 * Trie les clefs RECURSIVEMENT, a tous les niveaux.
 *
 * La premiere version faisait `JSON.stringify(article, Object.keys(article).sort())`.
 * Erreur grave : passe en tableau, le second argument de `JSON.stringify` n'est
 * pas un ordre de tri mais une LISTE D'AUTORISATION appliquee a TOUS les
 * niveaux. Toute clef imbriquee absente de la liste racine etait donc
 * supprimee, et chaque claim se reduisait a `{"id":"claim-1"}` :
 *
 *   texte, type, niveau de preuve et sources n'entraient PAS dans l'empreinte.
 *
 * Une attestation pouvait ainsi couvrir un article dont on avait change le
 * texte d'une claim, son niveau et l'URL de sa source. Le controle attrapait
 * un titre modifie — clef racine — ce qui donnait une fausse assurance.
 *
 * Defaut trouve en lisant la specification de canonicalisation de l0g.fr
 * (« clés triées récursivement »), qui a conduit a verifier la notre.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const objet = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(objet)
        .sort()
        .map((k) => [k, canonicalValue(objet[k])]),
    );
  }
  return value;
}

/** Serialisation canonique : une meme donnee doit donner la meme empreinte. */
export function canonicalize(article: Article): string {
  return JSON.stringify(canonicalValue(article));
}

export function contentHash(article: Article): string {
  return createHash("sha256").update(canonicalize(article)).digest("hex");
}

export interface ValidationInput {
  articleId: string;
  reviewer: string;
  note?: string;
  draftDir?: string;
  publishedDir?: string;
  changelog?: EditorialChangelog;
}

export interface ValidationResult {
  article: Article;
  review: ReviewRecord;
  articlePath: string;
  reviewPath: string;
  /** Avertissements non bloquants, que le relecteur a acceptes en validant. */
  warnings: readonly Violation[];
}

function safePaths(
  articleId: string,
  dir: string,
  suffixes: readonly string[],
): string[] {
  if (!ARTICLE_ID_PATTERN.test(articleId)) {
    throw new InvalidArticleId(
      articleId,
      "format attendu article-<uuid>, produit par le pipeline",
    );
  }
  const root = resolve(dir);
  return suffixes.map((s) => {
    const p = resolve(root, `${articleId}${s}`);
    if (p !== join(root, basename(p))) {
      throw new InvalidArticleId(articleId, "chemin sortant du repertoire");
    }
    return p;
  });
}

/**
 * Promeut un brouillon relu vers l'espace versionne.
 *
 * Le gate editorial est rejoue avant promotion. Un article peut avoir ete
 * publie en brouillon par une version anterieure du pipeline, ou modifie a la
 * main : la relecture humaine ne dispense pas des regles opposables, elle
 * s'ajoute a elles.
 */
export async function validateArticle(
  input: ValidationInput,
): Promise<ValidationResult> {
  const draftDir = input.draftDir ?? join(RACINE, "output");
  const publishedDir = input.publishedDir ?? join(RACINE, "articles");
  const changelog = input.changelog ?? new EditorialChangelog();

  const reviewer = input.reviewer.trim();
  if (reviewer.length === 0) {
    throw new InvalidArticleId(
      input.articleId,
      "un nom de relecteur est obligatoire : une relecture anonyme n'engage personne",
    );
  }

  const [draftPath] = safePaths(input.articleId, draftDir, [".json"]);
  if (draftPath === undefined || !existsSync(draftPath)) {
    throw new PublicationRefused([
      {
        rule: "DRAFT_NOT_FOUND",
        clause: "§5.4",
        severity: "blocking",
        message: `Aucun brouillon "${input.articleId}" dans ${draftDir}.`,
      },
    ]);
  }

  const parsed = ArticleSchema.safeParse(
    JSON.parse(await readFile(draftPath, "utf8")),
  );
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

  const article = parsed.data;
  const gate = runEditorialGate(article);
  if (!gate.passed) throw new PublicationRefused(gate.violations);

  const [articlePath, reviewPath] = safePaths(input.articleId, publishedDir, [
    ".json",
    ".review.json",
  ]);
  if (articlePath === undefined || reviewPath === undefined) {
    throw new InvalidArticleId(input.articleId, "chemins de publication invalides");
  }

  const review: ReviewRecord = {
    article_id: article.id,
    article_title: article.title,
    reviewer,
    reviewed_at: new Date().toISOString(),
    content_sha256: contentHash(article),
    note: input.note?.trim() ? input.note.trim() : null,
  };

  await mkdir(publishedDir, { recursive: true });
  await writeFile(articlePath, JSON.stringify(article, null, 2), "utf8");
  await writeFile(reviewPath, JSON.stringify(review, null, 2), "utf8");

  // §6 — le changelog public enregistre la PUBLICATION, c'est-a-dire le moment
  // ou un humain engage sa responsabilite. Le passage du pipeline n'est qu'un
  // brouillon et n'a rien a y faire.
  await changelog.append({
    article_id: article.id,
    article_title: article.title,
    date: review.reviewed_at,
    type: "éditoriale",
    description:
      `Publication apres relecture humaine par ${reviewer}. ` +
      `${article.claims.length} claim(s) structurante(s), niveau de preuve minimum ` +
      `${Math.min(...article.claims.map((c) => c.evidence_level))}.` +
      (review.note === null ? "" : ` Observation du relecteur : ${review.note}`),
  });

  return {
    article,
    review,
    articlePath,
    reviewPath,
    warnings: gate.violations.filter((v) => v.severity === "warning"),
  };
}

/**
 * Verifie qu'un article publie correspond bien a ce qui a ete relu.
 *
 * Utilise par la generation du site : un article modifie apres relecture n'est
 * plus relu, et ne doit pas atteindre le public sous couvert d'une attestation
 * qui ne porte plus sur son contenu.
 */
export async function verifyReview(
  article: Article,
  reviewPath: string,
): Promise<{ ok: boolean; reason?: string; review?: ReviewRecord }> {
  if (!existsSync(reviewPath)) {
    return { ok: false, reason: "aucune attestation de relecture" };
  }

  let review: ReviewRecord;
  try {
    review = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewRecord;
  } catch {
    return { ok: false, reason: "attestation de relecture illisible" };
  }

  if (review.article_id !== article.id) {
    return { ok: false, reason: "l'attestation porte sur un autre article" };
  }
  if (typeof review.reviewer !== "string" || review.reviewer.trim().length === 0) {
    return { ok: false, reason: "attestation sans relecteur nomme" };
  }
  if (review.content_sha256 !== contentHash(article)) {
    return {
      ok: false,
      reason:
        "l'article a ete modifie apres relecture — l'attestation ne porte plus " +
        "sur ce contenu, une nouvelle relecture est necessaire",
    };
  }
  return { ok: true, review };
}
