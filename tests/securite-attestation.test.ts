/**
 * SECURITE — attestation de relecture, ce que `validation.test.ts` ne couvre pas.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le rejeu inter-articles, le relecteur anonyme et l'article modifie apres
 * relecture sont deja couverts. Restent trois angles :
 *
 *  1. L'attestation est lue par un CAST (`JSON.parse(...) as ReviewRecord`),
 *     pas par une validation. Tout le reste du projet parse avec zod ; ici on
 *     fait confiance a un fichier du disque, qui est precisement ce qu'un
 *     attaquant ayant acces au depot modifierait.
 *  2. `reviewed_at` n'est verifie ni en forme, ni en coherence. Une attestation
 *     datee AVANT la publication de l'article decrit une relecture impossible.
 *  3. L'empreinte couvre-t-elle le CORPS ? La faille historique de ce projet
 *     etait une canonicalisation qui reduisait chaque claim a son `id` ; le
 *     corps merite sa propre verification.
 *
 * CE QUE L'ATTESTATION NE PROUVE PAS, et il faut le dire : elle lie un contenu
 * a un NOM, pas a une personne. Quiconque peut ecrire dans le depot peut
 * changer ce nom. Seule une signature cryptographique le corrigerait ; en
 * attendant, la garantie est l'integrite du CONTENU relu, pas l'authenticite
 * du relecteur.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ReviewRecordSchema,
  contentHash,
  verifyReview,
} from "../src/editorial/validation.js";
import { article } from "./helpers.js";

let dossier: string;
let chemin: string;

beforeEach(async () => {
  dossier = await mkdtemp(join(tmpdir(), "media-attestation-"));
  chemin = join(dossier, "attestation.json");
});
afterEach(async () => {
  await rm(dossier, { recursive: true, force: true });
});

const a = article();

/** Attestation valide, dont chaque test degrade un champ. */
const valide = () => ({
  article_id: a.id,
  article_title: a.title,
  reviewer: "Jamess02",
  reviewed_at: "2026-08-29T10:00:00Z",
  content_sha256: contentHash(a),
  note: "Sources et dates verifiees.",
});

async function ecrire(contenu: unknown): Promise<void> {
  await writeFile(chemin, JSON.stringify(contenu), "utf8");
}

describe("l'attestation est VALIDEE, pas seulement lue", () => {
  it("accepte une attestation bien formee", async () => {
    await ecrire(valide());
    expect((await verifyReview(a, chemin)).ok).toBe(true);
  });

  it("refuse une empreinte qui n'est pas une empreinte", async () => {
    // Un cast laisse passer n'importe quel type. Une comparaison `!==` le
    // rejetterait par accident ; on veut un refus MOTIVE, pas un ricochet.
    await ecrire({ ...valide(), content_sha256: { $ne: null } });
    const r = await verifyReview(a, chemin);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/forme|invalide/i);
  });

  it("refuse une note qui n'est pas du texte", async () => {
    // `note` est rendue sur le site. Un objet y afficherait "[object Object]".
    await ecrire({ ...valide(), note: { html: "<script>" } });
    expect((await verifyReview(a, chemin)).ok).toBe(false);
  });

  it("refuse un champ inconnu", async () => {
    // `.strict()` partout ailleurs : un champ en trop signale une attestation
    // produite par autre chose que ce pipeline.
    await ecrire({ ...valide(), approuve_par: "moi-meme" });
    expect((await verifyReview(a, chemin)).ok).toBe(false);
  });

  it("expose un schema utilisable ailleurs", () => {
    expect(ReviewRecordSchema.safeParse(valide()).success).toBe(true);
    expect(ReviewRecordSchema.safeParse({ reviewer: "x" }).success).toBe(false);
  });
});

describe("coherence de la date de relecture", () => {
  it("refuse une date illisible", async () => {
    await ecrire({ ...valide(), reviewed_at: "hier" });
    expect((await verifyReview(a, chemin)).ok).toBe(false);
  });

  it("refuse une relecture ANTERIEURE a la publication", async () => {
    // Relire un article avant qu'il existe est impossible : c'est le signe
    // d'une attestation fabriquee ou d'une date d'article reecrite (§6/§8).
    await ecrire({ ...valide(), reviewed_at: "2026-01-01T10:00:00Z" });
    const r = await verifyReview(a, chemin);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/anterieure|avant/i);
  });

  it("accepte une relecture le jour meme de la publication", async () => {
    await ecrire({ ...valide(), reviewed_at: a.published_at });
    expect((await verifyReview(a, chemin)).ok).toBe(true);
  });
});

describe("etendue de l'empreinte", () => {
  it("couvre le CORPS de l'article", async () => {
    // La faille historique de ce projet reduisait chaque claim a son `id`.
    // Le corps est ce que le lecteur lit : il doit etre scelle.
    await ecrire(valide());
    const modifie = { ...a, body: `${a.body}\n\nParagraphe ajoute apres coup.` };
    expect((await verifyReview(modifie, chemin)).ok).toBe(false);
  });

  it("couvre le TITRE", async () => {
    await ecrire(valide());
    expect((await verifyReview({ ...a, title: "Autre titre" }, chemin)).ok).toBe(
      false,
    );
  });

  it("couvre l'historique des corrections (§6)", async () => {
    await ecrire(valide());
    const modifie = {
      ...a,
      changelog: [
        { date: "2026-09-01T10:00:00Z", type: "factuelle" as const, description: "x" },
      ],
    };
    expect((await verifyReview(modifie, chemin)).ok).toBe(false);
  });
});
