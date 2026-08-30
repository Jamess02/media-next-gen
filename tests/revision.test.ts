/**
 * §6 — Politique de correction.
 *
 * L'invariant central : une correction remplace la lecture erronee mais ne
 * supprime jamais l'historique.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PublicationRefused } from "../src/agents/editeur.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import {
  ArticleNotFound,
  InvalidArticleId,
  reviseArticle,
} from "../src/editorial/revision.js";
import type { Article } from "../src/protocol/schema.js";
import { article, claim } from "./helpers.js";

let workDir: string;
let outputDir: string;
let changelogPath: string;

const ARTICLE_ID = "article-00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "revision-test-"));
  outputDir = join(workDir, "output");
  changelogPath = join(workDir, "changelog-editorial.md");
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seed(overrides: Partial<Article> = {}): Promise<Article> {
  const seeded = article({ id: ARTICLE_ID, ...overrides });
  await writeFile(
    join(outputDir, `${ARTICLE_ID}.json`),
    JSON.stringify(seeded, null, 2),
    "utf8",
  );
  return seeded;
}

const revise = (input: Parameters<typeof reviseArticle>[0]) =>
  reviseArticle({
    ...input,
    outputDir,
    changelog: new EditorialChangelog(changelogPath),
  });

describe("§6 — correction d'un article publie", () => {
  it("conserve la date de publication d'origine", async () => {
    const original = await seed();
    const result = await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Chiffre corrige : 4,50 % et non 4,25 %.",
    });

    expect(result.article.published_at).toBe(original.published_at);
    expect(result.article.revised_at).not.toBeNull();
  });

  it("refuse d'antidater la publication, meme si `edit` essaie", async () => {
    const original = await seed();
    const result = await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Tentative de reecriture de l'historique.",
      // Une fonction d'edition boguee ou malveillante ne doit pas pouvoir
      // changer l'identite ni la date d'origine de l'article.
      edit: (a) => ({
        ...a,
        id: "article-usurpe",
        published_at: "2020-01-01T00:00:00Z",
      }),
    });

    expect(result.article.id).toBe(original.id);
    expect(result.article.published_at).toBe(original.published_at);
  });

  it("ajoute au changelog sans jamais ecraser les entrees anterieures", async () => {
    await seed();
    await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Premiere correction.",
    });
    const second = await revise({
      articleId: ARTICLE_ID,
      type: "éditoriale",
      description: "Deuxieme correction.",
    });

    expect(second.revisionCount).toBe(2);
    expect(second.article.changelog[0]?.description).toBe("Premiere correction.");
    expect(second.article.changelog[1]?.description).toBe("Deuxieme correction.");
  });

  it("consigne la correction dans le changelog public du repo (§9.6)", async () => {
    await seed();
    await revise({
      articleId: ARTICLE_ID,
      type: "méthodologique",
      description: "Source FRED remplacee par la publication de la banque centrale.",
    });

    const published = await readFile(changelogPath, "utf8");
    expect(published).toMatch(/Revision methodologique/);
    expect(published).toMatch(/Source FRED remplacee/);
  });

  it("applique la modification de contenu demandee", async () => {
    await seed();
    const result = await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Titre clarifie.",
      edit: (a) => ({ ...a, title: "Titre corrige" }),
    });

    expect(result.article.title).toBe("Titre corrige");
  });

  it("regenere le markdown avec la date de revision visible", async () => {
    await seed();
    const result = await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Correction visible.",
    });

    const markdown = await readFile(result.markdownPath, "utf8");
    expect(markdown).toMatch(/revise le/);
    expect(markdown).toMatch(/Historique des corrections/);
    expect(markdown).toMatch(/Correction visible/);
  });

  it("refuse une correction qui violerait le protocole", async () => {
    await seed();
    // Corriger n'autorise pas a publier ce qui n'aurait pas pu l'etre :
    // ici la correction ferait tomber la claim sous le niveau 2.
    await expect(
      revise({
        articleId: ARTICLE_ID,
        type: "factuelle",
        description: "Niveau de preuve abaisse.",
        edit: (a) => ({
          ...a,
          claims: [claim({ evidence_level: 1 })],
        }),
      }),
    ).rejects.toThrow(PublicationRefused);
  });

  it("refuse une correction sur un article inexistant", async () => {
    await expect(
      revise({
        articleId: "article-11111111-1111-4111-8111-111111111111",
        type: "factuelle",
        description: "x",
      }),
    ).rejects.toThrow(ArticleNotFound);
  });
});

describe("traversee de chemin", () => {
  // `reviseArticle` ECRIT des fichiers. Sans validation, un identifiant
  // construit permettait d'ecrire hors du repertoire de publication.
  const attacks = [
    "../../../Windows/System32/x",
    "..\\..\\.env",
    "article-../../evade",
    "/etc/passwd",
    "C:\\Windows\\win",
    "article-00000000-0000-4000-8000-000000000000/../../evade",
  ];

  for (const articleId of attacks) {
    it(`refuse "${articleId}"`, async () => {
      await seed();
      await expect(
        revise({ articleId, type: "factuelle", description: "x" }),
      ).rejects.toThrow(InvalidArticleId);
    });
  }

  it("refuse un identifiant de forme libre", async () => {
    await seed();
    await expect(
      revise({ articleId: "mon-article", type: "factuelle", description: "x" }),
    ).rejects.toThrow(InvalidArticleId);
  });

  it("accepte l'identifiant produit par le pipeline", async () => {
    await seed();
    const result = await revise({
      articleId: ARTICLE_ID,
      type: "factuelle",
      description: "Identifiant valide.",
    });
    expect(result.article.id).toBe(ARTICLE_ID);
  });
});
