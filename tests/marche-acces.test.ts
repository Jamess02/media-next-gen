/**
 * Acces reseau des connecteurs de marche.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Ce module porte tout ce qu'un fournisseur de donnees de marche sanctionne ou
 * dont il abuse : la liste blanche des endpoints, la limite de debit, le
 * bannissement, les pannes passageres, le cache. Une horloge factice rend les
 * tests instantanes ET deterministes : aucune attente reelle, aucun hasard.
 *
 * Aucun test ne touche le reseau.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccesMarche, type Horloge, type PolitiqueDAcces } from "../src/marche/acces.js";
import { SourceFetchError } from "../src/sources/http.js";

const T0 = Date.parse("2026-09-11T08:00:00.000Z");

const POLITIQUE: PolitiqueDAcces = {
  id: "test",
  nom: "Fournisseur de test",
  base: "https://data-api.binance.vision",
  chemins: ["/api/v3/klines", "/api/v3/ping"],
  intervalleMinMs: 100,
  delaiMs: 10_000,
  essaisMax: 3,
  pause429Ms: 60_000,
  pause418Ms: 30 * 60_000,
  pause403Ms: 15 * 60_000,
  poids: { entete: "x-mbx-used-weight-1m", plafond: 6000, seuil: 4800 },
};

interface Rep {
  status?: number;
  corps?: unknown;
  entetes?: Record<string, string>;
  erreur?: { name: string; message: string };
}

function stubReponses(reponses: Rep[]) {
  const f = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const r = reponses.shift() ?? { status: 200, corps: [] };
    if (r.erreur !== undefined) {
      const e = new Error(r.erreur.message);
      e.name = r.erreur.name;
      throw e;
    }
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.entetes ?? {}),
      body: null,
      text: async () => JSON.stringify(r.corps ?? []),
    };
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function horloge() {
  const etat = { t: T0, attentes: [] as number[] };
  const h: Horloge = {
    maintenant: () => etat.t,
    attendre: async (ms) => {
      etat.attentes.push(ms);
      etat.t += ms;
    },
    aleatoire: () => 0,
  };
  return { h, etat };
}

const accepter = { ttlMs: 60_000, valider: () => {} };
const KLINES = { symbol: "BTCUSDT", interval: "1d", limit: 1 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acces-marche-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------
 * Liste blanche : ce projet est un media, il ne passe jamais d'ordre
 * ---------------------------------------------------------------------- */

describe("liste blanche — seuls les endpoints publics autorises partent", () => {
  it("refuse un chemin hors liste, sans AUCUN appel reseau", async () => {
    const f = stubReponses([]);
    const acces = new AccesMarche(POLITIQUE, null, horloge().h);
    await expect(acces.obtenir("/api/v3/account", {}, accepter)).rejects.toThrow(
      /chemin non autorise/,
    );
    await expect(acces.obtenir("/api/v3/order", {}, accepter)).rejects.toThrow(
      /chemin non autorise/,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("refuse une requete SIGNEE, marque des endpoints de compte et d'ordre", async () => {
    const f = stubReponses([]);
    const acces = new AccesMarche(POLITIQUE, null, horloge().h);
    await expect(
      acces.obtenir("/api/v3/klines", { ...KLINES, signature: "abc" }, accepter),
    ).rejects.toThrow(/signee/);
    await expect(
      acces.obtenir("/api/v3/klines", { ...KLINES, timestamp: 1 }, accepter),
    ).rejects.toThrow(/signee/);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuse une clef en parametre d'URL : l'URL est citee et journalisee", async () => {
    const f = stubReponses([]);
    const acces = new AccesMarche(POLITIQUE, null, horloge().h);
    await expect(
      acces.obtenir("/api/v3/klines", { ...KLINES, x_cg_demo_api_key: "k" }, accepter),
    ).rejects.toThrow(/clef/);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuse de se construire avec une clef de compte Binance", () => {
    expect(
      () => new AccesMarche({ ...POLITIQUE, enTetes: { "X-MBX-APIKEY": "k" } }, null),
    ).toThrow(/jamais d'ordre/);
  });
});

/* -------------------------------------------------------------------------
 * Cache : la date de la requete d'origine survit
 * ---------------------------------------------------------------------- */

describe("cache — l'horodatage de la requete d'ORIGINE survit", () => {
  it("sert la seconde demande depuis le cache, avec la date de la premiere requete", async () => {
    // Sinon l'article pretendrait une observation plus fraiche qu'elle ne
    // l'est : la date de requete dirait « maintenant » pour une donnee lue
    // il y a une heure.
    const f = stubReponses([{ corps: [[1]] }]);
    const { h, etat } = horloge();
    const acces = new AccesMarche(POLITIQUE, null, h);

    const premiere = await acces.obtenir("/api/v3/klines", KLINES, accepter);
    etat.t += 30_000;
    const seconde = await acces.obtenir("/api/v3/klines", KLINES, accepter);

    expect(f).toHaveBeenCalledTimes(1);
    expect(premiere.depuisLeCache).toBe(false);
    expect(seconde.depuisLeCache).toBe(true);
    expect(seconde.horodatageRequete).toBe(premiere.horodatageRequete);
    expect(seconde.horodatageRequete).toBe(new Date(T0).toISOString());
  });

  it("reinterroge une fois le TTL ecoule", async () => {
    const f = stubReponses([{ corps: [[1]] }, { corps: [[2]] }]);
    const { h, etat } = horloge();
    const acces = new AccesMarche(POLITIQUE, null, h);
    await acces.obtenir("/api/v3/klines", KLINES, accepter);
    etat.t += 61_000;
    const r = await acces.obtenir("/api/v3/klines", KLINES, accepter);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.corps).toEqual([[2]]);
  });

  it("ne met JAMAIS en cache une reponse dont la forme a change", async () => {
    const f = stubReponses([{ corps: { inattendu: true } }, { corps: [[1]] }]);
    const acces = new AccesMarche(POLITIQUE, null, horloge().h);
    const valider = (c: unknown) => {
      if (!Array.isArray(c)) throw new Error("schema modifie");
    };
    await expect(
      acces.obtenir("/api/v3/klines", KLINES, { ttlMs: 60_000, valider }),
    ).rejects.toThrow(/schema modifie/);
    await acces.obtenir("/api/v3/klines", KLINES, { ttlMs: 60_000, valider });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("conserve le cache sur disque d'une execution a l'autre", async () => {
    const f = stubReponses([{ corps: [[1]] }]);
    const { h } = horloge();
    await new AccesMarche(POLITIQUE, dir, h).obtenir("/api/v3/klines", KLINES, accepter);
    const r = await new AccesMarche(POLITIQUE, dir, h).obtenir("/api/v3/klines", KLINES, accepter);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.depuisLeCache).toBe(true);
    expect(r.horodatageRequete).toBe(new Date(T0).toISOString());
  });
});

/* -------------------------------------------------------------------------
 * Limite de debit : 429, 418, poids
 * ---------------------------------------------------------------------- */

describe("limite de debit atteinte — ne jamais insister", () => {
  it("sur 429 : aucune reprise, acces ferme pendant Retry-After, puis rouvert", async () => {
    // Binance : des 429 repetes menent au bannissement. La seule reponse
    // correcte a un 429 est de s'arreter.
    const f = stubReponses([
      { status: 429, entetes: { "retry-after": "30" } },
      { corps: [[1]] },
    ]);
    const { h, etat } = horloge();
    const acces = new AccesMarche(POLITIQUE, null, h);

    await expect(acces.obtenir("/api/v3/klines", KLINES, accepter)).rejects.toThrow(
      /429.*aucune requete avant 2026-09-11T08:00:30/,
    );
    expect(f).toHaveBeenCalledTimes(1);

    // Dans la fenetre : refus IMMEDIAT, sans requete.
    await expect(acces.obtenir("/api/v3/klines", KLINES, accepter)).rejects.toThrow(
      /aucune requete avant/,
    );
    expect(f).toHaveBeenCalledTimes(1);

    etat.t += 31_000;
    await acces.obtenir("/api/v3/klines", KLINES, accepter);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sans Retry-After, applique la pause par defaut", async () => {
    stubReponses([{ status: 429 }]);
    const acces = new AccesMarche(POLITIQUE, null, horloge().h);
    await expect(acces.obtenir("/api/v3/klines", KLINES, accepter)).rejects.toThrow(
      /aucune requete avant 2026-09-11T08:01:00/,
    );
  });

  it("sur 418 : le bannissement est memorise SUR DISQUE, un redemarrage ne le leve pas", async () => {
    // Un bannissement Binance va de quelques minutes a plusieurs jours. Oublie
    // au redemarrage, il ferait reprendre les requetes — que Binance
    // sanctionne par un bannissement plus long.
    const f = stubReponses([{ status: 418, entetes: { "retry-after": "7200" } }]);
    const { h } = horloge();
    await expect(
      new AccesMarche(POLITIQUE, dir, h).obtenir("/api/v3/klines", KLINES, accepter),
    ).rejects.toThrow(/banni/);

    const apresRedemarrage = new AccesMarche(POLITIQUE, dir, h);
    await expect(apresRedemarrage.obtenir("/api/v3/ping", {}, accepter)).rejects.toThrow(
      /banni.*aucune requete avant 2026-09-11T10:00:00/,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("ralentit AVANT la limite : poids utilise au-dessus du seuil", async () => {
    const f = stubReponses([
      { corps: [[1]], entetes: { "x-mbx-used-weight-1m": "5000" } },
      { corps: {} },
    ]);
    const { h, etat } = horloge();
    const acces = new AccesMarche(POLITIQUE, null, h);
    await acces.obtenir("/api/v3/klines", KLINES, accepter);
    await acces.obtenir("/api/v3/ping", {}, accepter);
    expect(f).toHaveBeenCalledTimes(2);
    // La fenetre de Binance est la minute : on attend la suivante.
    expect(etat.attentes.some((ms) => ms >= 60_000)).toBe(true);
  });

  it("respecte l'espacement minimal entre deux requetes", async () => {
    stubReponses([{ corps: [[1]] }, { corps: {} }]);
    const { h, etat } = horloge();
    const acces = new AccesMarche(POLITIQUE, null, h);
    await acces.obtenir("/api/v3/klines", KLINES, accepter);
    await acces.obtenir("/api/v3/ping", {}, accepter);
    expect(etat.attentes).toContain(100);
  });
});

/* -------------------------------------------------------------------------
 * Pannes passageres : reprises avec backoff exponentiel
 * ---------------------------------------------------------------------- */

describe("API indisponible — reprises bornees, puis echec explicite", () => {
  it("reessaie un 503 avec un delai qui double, puis reussit", async () => {
    const f = stubReponses([{ status: 503 }, { status: 503 }, { corps: [[1]] }]);
    const { h, etat } = horloge();
    const r = await new AccesMarche(POLITIQUE, null, h).obtenir(
      "/api/v3/klines",
      KLINES,
      accepter,
    );
    expect(r.corps).toEqual([[1]]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(etat.attentes).toEqual([500, 1000]);
  });

  it("abandonne au nombre d'essais maximal, et dit « donnee indisponible »", async () => {
    const f = stubReponses([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const erreur = await new AccesMarche(POLITIQUE, null, horloge().h)
      .obtenir("/api/v3/klines", KLINES, accepter)
      .catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(SourceFetchError);
    expect(String(erreur)).toMatch(/donnee indisponible.*503.*3 essais/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("reessaie une panne reseau et un delai depasse", async () => {
    const f = stubReponses([
      { erreur: { name: "TypeError", message: "fetch failed" } },
      { erreur: { name: "TimeoutError", message: "The operation was aborted" } },
      { corps: [[1]] },
    ]);
    await new AccesMarche(POLITIQUE, null, horloge().h).obtenir("/api/v3/klines", KLINES, accepter);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("rapporte le delai de dix secondes quand il est depasse a chaque essai", async () => {
    const delai = { erreur: { name: "TimeoutError", message: "The operation was aborted" } };
    stubReponses([delai, delai, delai]);
    await expect(
      new AccesMarche(POLITIQUE, null, horloge().h).obtenir("/api/v3/klines", KLINES, accepter),
    ).rejects.toThrow(/pas de reponse en 10000 ms.*3 essais/);
  });

  it("ne reessaie PAS une erreur du client, et rapporte le motif du fournisseur", async () => {
    // MESURE : un symbole inconnu rend HTTP 400 {"code":-1121,"msg":"Invalid symbol."}.
    // Le reessayer rendrait la meme erreur et consommerait du poids.
    const f = stubReponses([{ status: 400, corps: { code: -1121, msg: "Invalid symbol." } }]);
    await expect(
      new AccesMarche(POLITIQUE, null, horloge().h).obtenir("/api/v3/klines", KLINES, accepter),
    ).rejects.toThrow(/HTTP 400.*Invalid symbol/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("reessaie un code que le fournisseur declare transitoire (Binance -1007)", async () => {
    // -1007 : « Timeout waiting for response from backend server ». Sans ordre
    // passe, reessayer une lecture n'a aucun effet de bord.
    const f = stubReponses([{ status: 400, corps: { code: -1007, msg: "Timeout" } }, { corps: [[1]] }]);
    const politique = {
      ...POLITIQUE,
      codeTransitoire: (c: unknown) => (c as { code?: number }).code === -1007,
    };
    await new AccesMarche(politique, null, horloge().h).obtenir("/api/v3/klines", KLINES, accepter);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("refuse une reponse non JSON en HTTP 200, sans la mettre en cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        text: async () => "<html>maintenance</html>",
      })),
    );
    await expect(
      new AccesMarche(POLITIQUE, null, horloge().h).obtenir("/api/v3/klines", KLINES, accepter),
    ).rejects.toThrow(/non JSON/);
  });
});
