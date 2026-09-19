/**
 * Espacement des requetes vers une meme source.
 *
 * Ecrits AVANT le code (TDD).
 *
 * MESURE du 2026-09-19, conditions d'usage d'arXiv, citees : « no more than one
 * request every three seconds, and limit requests to a single connection ». Le
 * manuel ajoute : « we encourage you to play nice and incorporate a 3 second
 * delay in your code ». Contourner ces limites y est explicitement interdit.
 *
 * LE PROBLEME EST REEL, PAS THEORIQUE. Une vague produit six articles, et la
 * passerelle interroge les sources de chacun. Sans espacement, six requetes
 * partent quasi simultanement vers arXiv — six fois la limite, des la premiere
 * vague. Le cache en absorbe la plupart, mais seulement une fois la premiere
 * reponse revenue : les appels concurrents, eux, la precedent.
 *
 * L'ESPACEUR SERIALISE. Il ne se contente pas d'attendre : deux appels lances
 * en parallele doivent partir l'un APRES l'autre, pas ensemble apres une meme
 * pause. C'est la difference entre respecter la limite et la franchir poliment.
 */

import { describe, expect, it } from "vitest";

import { Espaceur } from "../src/sources/debit.js";

/** Horloge pilotee : aucun test n'attend reellement. */
function horloge() {
  let t = 0;
  const attentes: number[] = [];
  return {
    maintenant: () => t,
    attendre: async (ms: number) => {
      attentes.push(ms);
      t += ms;
    },
    avancer: (ms: number) => (t += ms),
    attentes,
  };
}

describe("espacement", () => {
  it("laisse partir le PREMIER appel sans attendre", async () => {
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 3000, horloge: h });

    expect(await e.passer(async () => "a")).toBe("a");
    expect(h.attentes, "le premier appel a attendu pour rien").toEqual([]);
  });

  it("fait ATTENDRE le second appel", async () => {
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 3000, horloge: h });

    await e.passer(async () => "a");
    await e.passer(async () => "b");

    expect(h.attentes).toEqual([3000]);
  });

  it("n'attend PAS si le delai est deja ecoule", async () => {
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 3000, horloge: h });

    await e.passer(async () => "a");
    h.avancer(3000);
    await e.passer(async () => "b");

    expect(h.attentes).toEqual([]);
  });

  it("SERIALISE deux appels lances en parallele", async () => {
    // Le point entier. Sans file, deux appels concurrents constatent le meme
    // « dernier appel » et partent ensemble apres la meme pause : la limite est
    // franchie poliment, mais franchie.
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 3000, horloge: h });
    const departs: number[] = [];

    await Promise.all([
      e.passer(async () => departs.push(h.maintenant())),
      e.passer(async () => departs.push(h.maintenant())),
      e.passer(async () => departs.push(h.maintenant())),
    ]);

    expect(departs).toEqual([0, 3000, 6000]);
  });

  it("preserve l'ORDRE des appels", async () => {
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 10, horloge: h });
    const ordre: string[] = [];

    await Promise.all([
      e.passer(async () => ordre.push("premier")),
      e.passer(async () => ordre.push("second")),
      e.passer(async () => ordre.push("troisieme")),
    ]);

    expect(ordre).toEqual(["premier", "second", "troisieme"]);
  });
});

describe("robustesse", () => {
  it("laisse remonter l'erreur de l'appel", async () => {
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 10, horloge: h });

    await expect(
      e.passer(async () => {
        throw new Error("source muette");
      }),
    ).rejects.toThrow(/source muette/);
  });

  it("ne BLOQUE PAS la file apres un echec", async () => {
    // Une source qui echoue une fois ne doit pas condamner toutes les requetes
    // suivantes : la file resterait fermee jusqu'au redemarrage.
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 10, horloge: h });

    await e.passer(async () => {
      throw new Error("premiere en echec");
    }).catch(() => undefined);

    expect(await e.passer(async () => "la suite passe")).toBe("la suite passe");
  });

  it("compte le temps meme quand l'appel echoue", async () => {
    // Une requete partie est une requete partie, reussie ou non : le
    // fournisseur l'a comptee, donc l'espacement doit la compter aussi.
    const h = horloge();
    const e = new Espaceur({ intervalleMs: 3000, horloge: h });

    await e.passer(async () => {
      throw new Error("echec");
    }).catch(() => undefined);
    await e.passer(async () => "suivante");

    expect(h.attentes).toEqual([3000]);
  });
});
