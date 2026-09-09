/**
 * SECURITE — invariants du versionnement.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Ce test ne protege pas d'une attaque : il protege d'une LIGNE SUPPRIMEE PAR
 * INADVERTANCE. C'est la faute la plus banale du lot, et la plus definitive :
 * l'historique Git conserve ce qui y entre, meme apres suppression du fichier.
 * Une clef poussee sur un depot public est une clef a revoquer, pas a effacer.
 *
 * Deux exclusions sont critiques et le `.gitignore` les documente longuement :
 *
 *  - `.env` porte les clefs FRED, Groq et Ollama ;
 *  - `audit/raw/` contient les reponses d'API INTEGRALES et NON CAVIARDEES —
 *    leur raison d'etre est la fidelite pour l'audit, donc elles peuvent
 *    contenir des clefs et des donnees sous conditions de licence.
 *
 * Le journal `.jsonl`, lui, EST versionne : c'est la trace de preuve, et ses
 * URLs sont caviardees. Ce test verifie aussi que cette distinction tient — la
 * confondre dans un sens publie des secrets, dans l'autre supprime la preuve.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

const gitignore = async (): Promise<string[]> =>
  (await readFile(join(RACINE, ".gitignore"), "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

describe("exclusions critiques du .gitignore", () => {
  it("exclut les archives d'audit NON CAVIARDEES", async () => {
    expect(await gitignore()).toContain("audit/raw/");
  });

  it("exclut le fichier de secrets", async () => {
    const lignes = await gitignore();
    expect(lignes).toContain(".env");
    expect(lignes).toContain(".env.local");
  });

  it("exclut l'espace de travail et le site genere", async () => {
    const lignes = await gitignore();
    expect(lignes).toContain("output/");
    expect(lignes).toContain("public/");
  });

  it("n'exclut PAS le journal d'audit, qui est la trace de preuve", async () => {
    // Symetrique et tout aussi important : exclure le journal supprimerait la
    // preuve au lieu de proteger un secret.
    const lignes = await gitignore();
    expect(lignes).not.toContain("audit/");
    expect(lignes).not.toContain("audit/journal.jsonl");
  });

  it("n'exclut PAS les articles relus ni le changelog editorial (§9.6)", async () => {
    const lignes = await gitignore();
    expect(lignes).not.toContain("articles/");
    expect(lignes).not.toContain("changelog-editorial.md");
  });
});

describe("le .gitignore explique POURQUOI, pas seulement quoi", () => {
  it("documente le caractere non caviarde des archives brutes", async () => {
    // Une ligne sans motif se supprime sans hesiter. Celle-ci porte sa raison,
    // et c'est ce qui la protege le mieux.
    const contenu = await readFile(join(RACINE, ".gitignore"), "utf8");
    expect(contenu).toMatch(/NE PAS RETIRER/i);
    expect(contenu).toMatch(/caviard/i);
  });
});
