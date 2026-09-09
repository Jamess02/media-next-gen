/**
 * SECURITE — integrite du journal d'audit (§9.4).
 *
 * Ecrits AVANT le code (TDD).
 *
 * CE QUI MANQUAIT. Le journal est append-only PAR USAGE : rien n'y expose de
 * methode de modification. Mais c'est un fichier texte. Quiconque peut ecrire
 * dans le depot peut reecrire une ligne, en supprimer une, en inserer une — et
 * rien ne le revele.
 *
 * Or le §9.4 fait de ce journal la trace de preuve du pipeline : c'est lui
 * qu'on produit pour montrer qu'une source a bien ete interrogee, a telle date,
 * et que telle reponse en est venue. Une trace qu'on peut editer sans laisser
 * de marque ne prouve rien — elle donne seulement l'apparence d'une preuve, ce
 * qui est pire que pas de trace du tout.
 *
 * LA REPONSE : un chainage d'empreintes. Chaque entree scelle la precedente.
 * Toucher a une ligne casse la chaine pour toutes les suivantes, et la
 * verification dit OU.
 *
 * CE QUE LE CHAINAGE NE FAIT PAS. Il ne protege pas d'une reecriture COMPLETE
 * du journal par quelqu'un qui recalculerait toute la chaine — seule une
 * signature, ou une ancre externe, le ferait. Il rend l'alteration
 * ponctuelle detectable, ce qui est deja ce que la plupart des falsifications
 * sont : rapides et locales.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog, GENESIS_SHA256, verifyJournal } from "../src/audit/audit-log.js";

let dir: string;
let journal: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-journal-"));
  journal = join(dir, "journal.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ecrit trois entrees reelles via l'API publique. */
async function troisEntrees(): Promise<void> {
  const log = new AuditLog({ dir });
  for (const n of [1, 2, 3]) {
    await log.record({
      kind: "source",
      agent: "veilleur",
      target: `https://exemple.test/${n}`,
      dateObserved: "2026-09-09T09:00:00Z",
      raw: { n },
    });
  }
}

const lignes = async (): Promise<string[]> =>
  (await readFile(journal, "utf8")).split("\n").filter((l) => l.trim().length > 0);

const ecrire = async (l: string[]): Promise<void> =>
  writeFile(journal, `${l.join("\n")}\n`, "utf8");

describe("chainage des entrees", () => {
  it("scelle chaque entree a la precedente", async () => {
    await troisEntrees();
    const l = (await lignes()).map((x) => JSON.parse(x) as Record<string, string>);

    expect(l[0]?.["prev_sha256"]).toBe(GENESIS_SHA256);
    expect(l[1]?.["prev_sha256"]).toBe(l[0]?.["entry_sha256"]);
    expect(l[2]?.["prev_sha256"]).toBe(l[1]?.["entry_sha256"]);
  });

  it("valide un journal intact", async () => {
    await troisEntrees();
    const r = verifyJournal(await lignes());
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(3);
  });
});

describe("detection des alterations", () => {
  it("detecte la MODIFICATION d'une entree", async () => {
    // Le cas concret : effacer la trace d'une source qu'on n'aurait pas du
    // interroger, ou antidater une observation.
    await troisEntrees();
    const l = await lignes();
    const entree = JSON.parse(l[1]!) as Record<string, unknown>;
    entree["target"] = "https://exemple.test/falsifie";
    l[1] = JSON.stringify(entree);
    await ecrire(l);

    const r = verifyJournal(await lignes());
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("detecte la SUPPRESSION d'une entree", async () => {
    await troisEntrees();
    const l = await lignes();
    await ecrire([l[0]!, l[2]!]);

    const r = verifyJournal(await lignes());
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("detecte une entree INSEREE", async () => {
    await troisEntrees();
    const l = await lignes();
    const faux = JSON.parse(l[0]!) as Record<string, unknown>;
    faux["target"] = "https://exemple.test/ajoutee-apres-coup";
    await ecrire([l[0]!, JSON.stringify(faux), l[1]!, l[2]!]);

    const r = verifyJournal(await lignes());
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("detecte un REORDONNANCEMENT", async () => {
    await troisEntrees();
    const l = await lignes();
    await ecrire([l[0]!, l[2]!, l[1]!]);

    const r = verifyJournal(await lignes());
    expect(r.ok).toBe(false);
  });

  it("detecte une empreinte d'entree recalculee a la main sans le reste", async () => {
    // Falsification naive : on change le contenu ET son `entry_sha256`, en
    // oubliant que la chaine se poursuit.
    await troisEntrees();
    const l = await lignes();
    const entree = JSON.parse(l[0]!) as Record<string, unknown>;
    entree["agent"] = "quelqu-un-dautre";
    entree["entry_sha256"] = "0".repeat(64);
    l[0] = JSON.stringify(entree);
    await ecrire(l);

    expect(verifyJournal(await lignes()).ok).toBe(false);
  });
});

describe("cohabitation avec les entrees anterieures au chainage", () => {
  it("signale les entrees NON CHAINEES sans les declarer falsifiees", async () => {
    // Le journal existant a ete ecrit avant cette protection. Le declarer
    // corrompu serait faux — et un outil qui crie au loup sur des donnees
    // legitimes finit desactive.
    await ecrire([
      JSON.stringify({ logged_at: "2026-09-01T00:00:00Z", kind: "source", agent: "veilleur" }),
      JSON.stringify({ logged_at: "2026-09-01T00:01:00Z", kind: "llm", agent: "analyste" }),
    ]);

    const r = verifyJournal(await lignes());
    expect(r.legacy).toBe(2);
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("verifie la chaine des entrees chainees qui suivent", async () => {
    const anciennes = [
      JSON.stringify({ logged_at: "2026-09-01T00:00:00Z", kind: "source", agent: "veilleur" }),
    ];
    await ecrire(anciennes);
    await troisEntrees();

    const r = verifyJournal(await lignes());
    expect(r.legacy).toBe(1);
    expect(r.checked).toBe(3);
    expect(r.ok).toBe(true);
  });

  it("refuse une ligne illisible", async () => {
    await troisEntrees();
    const l = await lignes();
    l.splice(1, 0, "{ceci n'est pas du JSON");
    await ecrire(l);

    expect(verifyJournal(await lignes()).ok).toBe(false);
  });
});
