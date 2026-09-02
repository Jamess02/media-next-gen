/**
 * Relecture humaine et promotion (§5.4, §6).
 *
 * Deux espaces : `output/` est un espace de travail non versionne, `articles/`
 * contient les textes relus par un humain et constitue la seule source du site
 * public. Ces tests protegent la frontiere entre les deux.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PublicationRefused } from "../src/agents/editeur.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { InvalidArticleId } from "../src/editorial/revision.js";
import {
  contentHash,
  validateArticle,
  verifyReview,
  type ReviewRecord,
} from "../src/editorial/validation.js";
import { buildSite } from "../src/site/build.js";
import type { Article } from "../src/protocol/schema.js";
import { article, claim } from "./helpers.js";

let workDir: string;
let draftDir: string;
let publishedDir: string;
let changelogPath: string;

const ID = "article-00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "validation-"));
  draftDir = join(workDir, "output");
  publishedDir = join(workDir, "articles");
  changelogPath = join(workDir, "changelog.md");
  await mkdir(draftDir, { recursive: true });
  await writeFile(join(workDir, "protocole.md"), "# Protocole", "utf8");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seed(overrides: Partial<Article> = {}): Promise<Article> {
  const a = article({ id: ID, ...overrides });
  await writeFile(join(draftDir, `${ID}.json`), JSON.stringify(a), "utf8");
  return a;
}

const valider = (input: Partial<Parameters<typeof validateArticle>[0]> = {}) =>
  validateArticle({
    articleId: ID,
    reviewer: "Relecteur Test",
    draftDir,
    publishedDir,
    changelog: new EditorialChangelog(changelogPath),
    ...input,
  });

const construire = () =>
  buildSite({
    outputDir: publishedDir,
    siteDir: join(workDir, "public"),
    protocolPath: join(workDir, "protocole.md"),
    changelogPath,
  });

describe("promotion d'un brouillon relu", () => {
  it("ecrit l'article et son attestation dans l'espace versionne", async () => {
    await seed();
    const r = await valider();

    expect(r.review.reviewer).toBe("Relecteur Test");
    expect(r.review.article_id).toBe(ID);
    expect(r.review.content_sha256).toHaveLength(64);
    await expect(readFile(r.articlePath, "utf8")).resolves.toContain(ID);
    await expect(readFile(r.reviewPath, "utf8")).resolves.toContain("Relecteur Test");
  });

  it("EXIGE un relecteur nomme", async () => {
    // Une relecture anonyme n'engage personne.
    await seed();
    await expect(valider({ reviewer: "   " })).rejects.toThrow(InvalidArticleId);
  });

  it("enregistre l'observation du relecteur", async () => {
    await seed();
    const r = await valider({ note: "Chiffres recoupes a la source." });
    expect(r.review.note).toBe("Chiffres recoupes a la source.");
  });

  it("consigne la publication au changelog public (§6)", async () => {
    // Le changelog enregistre le moment ou un HUMAIN engage sa responsabilite,
    // pas le passage du pipeline.
    await seed();
    await valider();
    const journal = await readFile(changelogPath, "utf8");
    expect(journal).toMatch(/relecture humaine par Relecteur Test/);
  });

  it("rejoue le gate editorial : la relecture ne dispense pas des regles", async () => {
    await seed({ claims: [claim({ evidence_level: 1 })] });
    await expect(valider()).rejects.toThrow(PublicationRefused);
  });

  it("refuse un brouillon inexistant", async () => {
    await expect(
      valider({ articleId: "article-11111111-1111-4111-8111-111111111111" }),
    ).rejects.toThrow(PublicationRefused);
  });

  it("refuse un identifiant hors format", async () => {
    await expect(valider({ articleId: "../../evade" })).rejects.toThrow(
      InvalidArticleId,
    );
  });

  it("remonte les avertissements acceptes en validant", async () => {
    await seed({ body: "Corps sans reference." });
    const r = await valider();
    expect(r.warnings.map((w) => w.rule)).toContain("CLAIM_NOT_REFERENCED");
  });
});

describe("integrite de l'attestation", () => {
  it("valide une attestation qui correspond au contenu", async () => {
    const a = await seed();
    const r = await valider();
    expect((await verifyReview(a, r.reviewPath)).ok).toBe(true);
  });

  it("INVALIDE l'attestation si l'article est modifie apres relecture", async () => {
    // Propriete centrale : une relecture atteste d'un TEXTE, pas d'un
    // identifiant. Verifie aussi de bout en bout ci-dessous.
    const a = await seed();
    const r = await valider();
    const check = await verifyReview({ ...a, title: "Titre change" }, r.reviewPath);

    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/modifie apres relecture/);
  });

  it("refuse une attestation portant sur un autre article", async () => {
    const a = await seed();
    const autre: ReviewRecord = {
      article_id: "article-99999999-9999-4999-8999-999999999999",
      article_title: "x",
      reviewer: "X",
      reviewed_at: "2026-09-01T00:00:00Z",
      content_sha256: contentHash(a),
      note: null,
    };
    const p = join(workDir, "faux.review.json");
    await writeFile(p, JSON.stringify(autre), "utf8");
    expect((await verifyReview(a, p)).reason).toMatch(/un autre article/);
  });

  it("refuse une attestation sans relecteur nomme", async () => {
    const a = await seed();
    const p = join(workDir, "anonyme.review.json");
    await writeFile(
      p,
      JSON.stringify({
        article_id: a.id,
        article_title: a.title,
        reviewer: "  ",
        reviewed_at: "2026-09-01T00:00:00Z",
        content_sha256: contentHash(a),
        note: null,
      }),
      "utf8",
    );
    expect((await verifyReview(a, p)).reason).toMatch(/sans relecteur/);
  });

  it("refuse une attestation absente", async () => {
    const a = await seed();
    expect((await verifyReview(a, join(workDir, "inexistant.json"))).reason).toMatch(
      /aucune attestation/,
    );
  });
});

describe("le site ne publie que des articles relus", () => {
  it("publie un article relu", async () => {
    await seed();
    await valider();
    expect((await construire()).published).toBe(1);
  });

  it("ECARTE un article depose sans attestation", async () => {
    // Copier un JSON dans articles/ ne suffit pas a le publier.
    await mkdir(publishedDir, { recursive: true });
    await writeFile(
      join(publishedDir, `${ID}.json`),
      JSON.stringify(article({ id: ID })),
      "utf8",
    );

    const r = await construire();
    expect(r.published).toBe(0);
    expect(r.rejected[0]?.reason).toMatch(/aucune attestation/);
  });

  it("ECARTE un article modifie apres relecture", async () => {
    await seed();
    const r = await valider();

    const falsifie = { ...JSON.parse(await readFile(r.articlePath, "utf8")) };
    falsifie.title = "Titre modifie en douce";
    await writeFile(r.articlePath, JSON.stringify(falsifie), "utf8");

    const build = await construire();
    expect(build.published).toBe(0);
    expect(build.rejected[0]?.reason).toMatch(/modifie apres relecture/);
  });

  it("ne prend pas les attestations pour des articles", async () => {
    await seed();
    await valider();
    const r = await construire();
    expect(r.published).toBe(1);
    expect(r.rejected).toHaveLength(0);
  });

  it("permet un apercu de brouillons sans relecture, sur demande explicite", async () => {
    await seed();
    const r = await buildSite({
      outputDir: draftDir,
      siteDir: join(workDir, "apercu"),
      protocolPath: join(workDir, "protocole.md"),
      changelogPath,
      requireReview: false,
    });
    expect(r.published).toBe(1);
  });
});
