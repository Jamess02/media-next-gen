/**
 * Hachage — la ou il manquait.
 *
 * Ecrits AVANT le code (TDD).
 *
 * DEUX MANQUES, de meme nature : une empreinte existe, et rien ne la verifie.
 *
 *  1. LES ARCHIVES D'AUDIT sont adressees par leur contenu — `raw/<sha256>.json`.
 *     Le nom du fichier EST l'empreinte, ce qui devrait rendre une alteration
 *     impossible a cacher : modifier le fichier change son nom. Mais `readRaw`
 *     lisait sans jamais recalculer. Un adressage par contenu que personne ne
 *     verifie est une decoration, et toute la promesse du §9.4 — « la reponse
 *     brute archivee pour audit et correction ulterieure » — repose dessus.
 *
 *  2. LE CHANGELOG EDITORIAL (§9.6) est le registre PUBLIC des corrections. Il
 *     est append-only par l'API — le module n'expose ni `update` ni `delete` —
 *     mais c'est un fichier markdown : une ligne s'y edite ou s'y supprime sans
 *     laisser de trace. Exactement le probleme que le journal d'audit avait
 *     avant son chainage, sur un fichier qui a la meme fonction : prouver ce
 *     qui s'est passe.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import {
  EditorialChangelog,
  verifyChangelog,
} from "../src/editorial/changelog.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-hachage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------
 * 1. Archives d'audit
 * ---------------------------------------------------------------------- */

describe("archive d'audit — l'empreinte est VERIFIEE a la relecture", () => {
  async function archiver(): Promise<{ log: AuditLog; record: Awaited<ReturnType<AuditLog["record"]>> }> {
    const log = new AuditLog({ dir });
    const record = await log.record({
      kind: "source",
      agent: "veilleur",
      target: "https://exemple.test/data",
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { valeur: 42 },
    });
    return { log, record };
  }

  it("relit une archive intacte", async () => {
    const { log, record } = await archiver();
    await expect(log.readRaw(record)).resolves.toEqual({ valeur: 42 });
  });

  it("REFUSE une archive dont le contenu a change", async () => {
    // Le scenario reel : quelqu'un corrige la reponse d'une source pour la
    // faire correspondre a ce que l'article affirme. Sans controle, la
    // falsification devient la piece justificative.
    const { log, record } = await archiver();
    await writeFile(join(dir, record.raw_path), JSON.stringify({ valeur: 99 }), "utf8");

    await expect(log.readRaw(record)).rejects.toThrow(/empreinte|alteree/i);
  });

  it("nomme le fichier en cause et les deux empreintes", async () => {
    const { log, record } = await archiver();
    await writeFile(join(dir, record.raw_path), "{}", "utf8");
    await expect(log.readRaw(record)).rejects.toThrow(
      new RegExp(record.raw_sha256.slice(0, 12)),
    );
  });

  it("refuse une archive absente au lieu d'echouer obscurement", async () => {
    const { log, record } = await archiver();
    await rm(join(dir, record.raw_path));
    await expect(log.readRaw(record)).rejects.toThrow(/archive/i);
  });
});

/* -------------------------------------------------------------------------
 * 2. Chainage du changelog editorial (§9.6)
 * ---------------------------------------------------------------------- */

describe("changelog editorial — chaine d'empreintes", () => {
  const chemin = () => join(dir, "changelog-editorial.md");

  async function troisEntrees(): Promise<void> {
    const c = new EditorialChangelog(chemin());
    for (const n of [1, 2, 3]) {
      await c.append({
        article_id: `article-${n}`,
        article_title: `Titre ${n}`,
        date: `2026-09-0${n}T10:00:00Z`,
        type: "factuelle",
        description: `Correction ${n}`,
      });
    }
  }

  it("valide un registre intact", async () => {
    await troisEntrees();
    const r = verifyChangelog(await readFile(chemin(), "utf8"));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(3);
  });

  it("detecte une entree MODIFIEE", async () => {
    // Reecrire une correction publiee, c'est reecrire l'histoire editoriale :
    // precisement ce que EP-004 interdit.
    await troisEntrees();
    const contenu = await readFile(chemin(), "utf8");
    await writeFile(chemin(), contenu.replace("Correction 2", "Correction anodine"), "utf8");

    const r = verifyChangelog(await readFile(chemin(), "utf8"));
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("detecte une entree SUPPRIMEE", async () => {
    await troisEntrees();
    const contenu = await readFile(chemin(), "utf8");
    const entrees = contenu.split("<!-- chaine:");
    // On retire la deuxieme entree, marqueur compris.
    const ampute = entrees[0] + "<!-- chaine:" + entrees[1] + "<!-- chaine:" + entrees[3];
    await writeFile(chemin(), ampute, "utf8");

    expect(verifyChangelog(await readFile(chemin(), "utf8")).ok).toBe(false);
  });

  it("le marqueur de chaine reste INVISIBLE a la lecture", async () => {
    // Le §9.6 veut un registre lisible par un humain. Une empreinte affichee
    // en clair a chaque entree le rendrait illisible, donc inconsulte.
    await troisEntrees();
    const contenu = await readFile(chemin(), "utf8");
    expect(contenu).toMatch(/<!--/);
    // Le texte visible ne porte aucune empreinte.
    expect(contenu.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/[0-9a-f]{64}/);
  });

  it("tolere un registre anterieur au chainage sans le declarer corrompu", async () => {
    // Le fichier existant a ete ecrit avant cette protection. Crier au loup sur
    // des donnees legitimes ferait desactiver l'outil.
    await writeFile(chemin(), "# Changelog\n\nTexte d'introduction sans entree.\n", "utf8");
    const r = verifyChangelog(await readFile(chemin(), "utf8"));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it("reste append-only : aucune methode ne modifie une entree", () => {
    const c = new EditorialChangelog(chemin()) as unknown as Record<string, unknown>;
    for (const interdit of ["update", "delete", "remove", "edit", "rewrite"]) {
      expect(c[interdit]).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------
 * Ce qui etait DEJA correct — verrouille pour ne pas regresser
 * ---------------------------------------------------------------------- */

describe("adressage par contenu", () => {
  it("deux reponses identiques partagent une archive", async () => {
    // Propriete gratuite de l'adressage par contenu, et elle compte : sans
    // elle, une collecte quotidienne dupliquerait la meme reponse a l'infini.
    const log = new AuditLog({ dir });
    const a = await log.record({
      kind: "source",
      agent: "veilleur",
      target: "https://exemple.test/1",
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { meme: "contenu" },
    });
    const b = await log.record({
      kind: "source",
      agent: "analyste",
      target: "https://exemple.test/2",
      dateObserved: "2026-09-09T10:00:00Z",
      raw: { meme: "contenu" },
    });
    expect(a.raw_sha256).toBe(b.raw_sha256);
    expect(a.raw_path).toBe(b.raw_path);
  });

  it("l'empreinte porte sur une serialisation STABLE", async () => {
    // Sans tri des clefs, un meme objet donnerait deux empreintes selon
    // l'ordre d'insertion, et la deduplication comme la verification
    // sauteraient.
    const log = new AuditLog({ dir });
    const a = await log.record({
      kind: "llm",
      agent: "analyste",
      target: "modele",
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { z: 1, a: 2 },
    });
    const b = await log.record({
      kind: "llm",
      agent: "analyste",
      target: "modele",
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { a: 2, z: 1 },
    });
    expect(a.raw_sha256).toBe(b.raw_sha256);
  });

  it("le nom du fichier EST l'empreinte de son contenu", async () => {
    const log = new AuditLog({ dir });
    const r = await log.record({
      kind: "source",
      agent: "veilleur",
      target: "https://exemple.test/x",
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { valeur: 7 },
    });
    const contenu = await readFile(join(dir, r.raw_path), "utf8");
    expect(createHash("sha256").update(contenu).digest("hex")).toBe(r.raw_sha256);
  });
});
