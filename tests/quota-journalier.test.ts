/**
 * Compteur de QUOTA JOURNALIER, pour les sources qui en imposent un.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Demande de l'editeur du 2026-09-19, en vue des sources technologiques :
 * Alpha Vantage plafonne aux environs de 25 appels par jour, Twelve Data aux
 * environs de 800. Le depot sait deja espacer les requetes et couper apres un
 * 429 (`marche/acces.ts`), mais rien n'y compte les appels d'une JOURNEE.
 *
 * TROIS PROPRIETES, et chacune vient d'une facon de se tromper.
 *
 *  1. LE COMPTE SURVIT AU REDEMARRAGE. Un compteur en memoire transformerait
 *     « 25 appels par jour » en « 25 appels par execution » : six vagues
 *     quotidiennes suffiraient a griller le quota et a faire bannir la clef.
 *  2. LA JOURNEE EST EN UTC. Un decompte cale sur l'heure locale se remettrait
 *     a zero au milieu de l'apres-midi pour un fournisseur qui, lui, compte
 *     autrement — et le plafond serait franchi sans que rien ne le signale.
 *  3. UN FICHIER ILLISIBLE NE BLOQUE RIEN. Le quota protege une clef ; il ne
 *     doit pas empecher une collecte parce qu'un fichier d'etat a ete tronque.
 *     On repart de zero, ce qui est le comportement prudent cote fournisseur
 *     seulement si l'on n'a rien consomme — la trace le dira.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuotaJournalier } from "../src/sources/quota.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quota-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Horloge figee, pour eprouver le passage d'un jour a l'autre. */
const horlogeA = (iso: string) => () => new Date(iso);

describe("consommation", () => {
  it("decompte chaque appel", async () => {
    const q = new QuotaJournalier({ id: "test", plafond: 3, dir });
    expect(await q.reste()).toBe(3);
    expect(await q.consommer()).toBe(true);
    expect(await q.reste()).toBe(2);
  });

  it("REFUSE au-dela du plafond", async () => {
    const q = new QuotaJournalier({ id: "test", plafond: 2, dir });
    expect(await q.consommer()).toBe(true);
    expect(await q.consommer()).toBe(true);
    expect(await q.consommer(), "le plafond n'a pas retenu le troisieme appel").toBe(
      false,
    );
    expect(await q.reste()).toBe(0);
  });

  it("ne descend jamais sous zero", async () => {
    const q = new QuotaJournalier({ id: "test", plafond: 1, dir });
    await q.consommer();
    await q.consommer();
    await q.consommer();
    expect(await q.reste()).toBe(0);
  });

  it("refuse tout quand le plafond est nul", async () => {
    const q = new QuotaJournalier({ id: "test", plafond: 0, dir });
    expect(await q.consommer()).toBe(false);
  });
});

describe("le compte SURVIT au redemarrage", () => {
  it("reprend ou la precedente execution s'etait arretee", async () => {
    // Sans cela, « 25 appels par jour » devient « 25 par execution » : six
    // vagues quotidiennes grillent le quota et font bannir la clef.
    const premier = new QuotaJournalier({ id: "av", plafond: 3, dir });
    await premier.consommer();
    await premier.consommer();

    const second = new QuotaJournalier({ id: "av", plafond: 3, dir });
    expect(await second.reste()).toBe(1);
  });

  it("ne melange PAS deux sources", async () => {
    const a = new QuotaJournalier({ id: "alpha", plafond: 2, dir });
    const b = new QuotaJournalier({ id: "twelve", plafond: 2, dir });
    await a.consommer();
    await a.consommer();

    expect(await a.consommer()).toBe(false);
    expect(await b.consommer(), "le quota d'une source a ferme celui d'une autre").toBe(
      true,
    );
  });
});

describe("la journee est en UTC", () => {
  it("remet le compteur a zero au changement de jour", async () => {
    const veille = new QuotaJournalier({
      id: "av",
      plafond: 1,
      dir,
      horloge: horlogeA("2026-09-19T23:59:00Z"),
    });
    expect(await veille.consommer()).toBe(true);
    expect(await veille.consommer()).toBe(false);

    const lendemain = new QuotaJournalier({
      id: "av",
      plafond: 1,
      dir,
      horloge: horlogeA("2026-09-20T00:01:00Z"),
    });
    expect(await lendemain.reste(), "le quota n'est pas reparti au jour suivant").toBe(1);
  });

  it("ne remet PAS a zero au fil de la meme journee", async () => {
    const matin = new QuotaJournalier({
      id: "av",
      plafond: 2,
      dir,
      horloge: horlogeA("2026-09-19T01:00:00Z"),
    });
    await matin.consommer();

    const soir = new QuotaJournalier({
      id: "av",
      plafond: 2,
      dir,
      horloge: horlogeA("2026-09-19T22:00:00Z"),
    });
    expect(await soir.reste()).toBe(1);
  });

  it("decoupe la journee sur UTC, pas sur l'heure locale", async () => {
    // Une machine a Paris passe au jour suivant deux heures avant UTC en ete.
    // Caler le decoupage sur l'heure locale rouvrirait le quota trop tot, et
    // le fournisseur, lui, compterait encore la veille.
    const q = new QuotaJournalier({
      id: "av",
      plafond: 1,
      dir,
      horloge: horlogeA("2026-09-19T23:30:00Z"),
    });
    await q.consommer();

    const memeJourUtc = new QuotaJournalier({
      id: "av",
      plafond: 1,
      dir,
      // 01h30 a Paris le 20, mais toujours le 19 en UTC.
      horloge: horlogeA("2026-09-19T23:31:00Z"),
    });
    expect(await memeJourUtc.reste()).toBe(0);
  });
});

describe("robustesse", () => {
  it("repart de zero sur un fichier illisible, sans faire tomber la collecte", async () => {
    const q = new QuotaJournalier({ id: "av", plafond: 2, dir });
    await q.consommer();
    await writeFile(q.chemin(), "{ pas du json", "utf8");

    const apres = new QuotaJournalier({ id: "av", plafond: 2, dir });
    expect(await apres.reste()).toBe(2);
    expect(await apres.consommer()).toBe(true);
  });

  it("ecrit un etat relisible", async () => {
    const q = new QuotaJournalier({ id: "av", plafond: 5, dir });
    await q.consommer();
    const etat = JSON.parse(await readFile(q.chemin(), "utf8")) as {
      jour: string;
      consommes: number;
    };
    expect(etat.jour).toBe(new Date().toISOString().slice(0, 10));
    expect(etat.consommes).toBe(1);
  });

  it("consomme plusieurs unites d'un coup quand une requete en coute plusieurs", async () => {
    const q = new QuotaJournalier({ id: "av", plafond: 5, dir });
    expect(await q.consommer(3)).toBe(true);
    expect(await q.reste()).toBe(2);
    expect(await q.consommer(3), "un depassement partiel doit etre refuse").toBe(false);
    expect(await q.reste(), "un appel refuse ne consomme rien").toBe(2);
  });
});
