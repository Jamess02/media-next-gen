/**
 * Le pont entre un connecteur de marche et la passerelle des sources.
 *
 * Ecrits AVANT le code (TDD).
 *
 * C'est le SEUL chemin par lequel une donnee de marche atteint un agent. Il
 * garantit, pour tout connecteur present et futur :
 *
 *  - les garde-fous sur chaque point (valeur absente, negative, datee du
 *    futur, perimee) — une donnee aberrante devient un echec explicite, jamais
 *    une observation ;
 *  - une observation au contrat §5.1, dont les deux dates sont celles de la
 *    DONNEE et de la REQUETE d'origine ;
 *  - un resume qui dit l'unite, le perimetre, les reserves, et la formule
 *    d'attribution — celle-la meme que le gate exigera ;
 *  - la pertinence : un sujet sans rapport n'interroge pas le fournisseur.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { adaptateurDeMarche, minuitUtc } from "../src/marche/adaptateur.js";
import { INSTRUMENTS } from "../src/marche/instruments.js";
import type { ConnecteurDeMarche, PointDeMarche, ReleveDeMarche } from "../src/marche/types.js";
import { buildSourceCatalogue, ttlDepuisEnv } from "../src/sources/catalogue.js";
import { SourceGateway } from "../src/sources/gateway.js";

const BITCOIN = INSTRUMENTS.find((i) => i.id === "bitcoin")!;
const CAC40 = INSTRUMENTS.find((i) => i.id === "cac40")!;
const MAINTENANT = new Date("2026-09-11T08:00:05.000Z");
const JOUR = 86_400_000;

const URL_BINANCE =
  "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=1788998400000&endTime=1789084799999";
const URL_YAHOO =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EFCHI?period1=1788220800&period2=1789084800&interval=1d";

const pointBinance = (o: Partial<PointDeMarche> = {}): PointDeMarche => ({
  instrument: "BTC/USDT",
  mesure: "cloture sur Binance de la journee UTC du 2026-09-10",
  nature: "prix",
  valeur: 76568.72,
  unite: "USDT",
  horodatageDonnee: "2026-09-10T23:59:59.999Z",
  horodatageRequete: "2026-09-11T08:00:00.000Z",
  source: "Binance",
  url: URL_BINANCE,
  fiabilite: "primaire",
  perimetre: { type: "plateforme-unique", plateforme: "Binance" },
  usage: "citable",
  reserves: ["Unite : USDT, un stablecoin — ce n'est pas le dollar americain."],
  ...o,
});

const pointYahoo = (): PointDeMarche => ({
  instrument: "^FCHI",
  mesure: "cloture de la seance du 2026-09-10 (Europe/Paris)",
  nature: "niveau",
  valeur: 8116.76,
  unite: "points",
  horodatageDonnee: "2026-09-10T07:00:00.000Z",
  horodatageRequete: "2026-09-11T08:00:00.000Z",
  source: "Yahoo Finance",
  url: URL_YAHOO,
  fiabilite: "secondaire",
  perimetre: { type: "agrege", methode: "agregateur grand public" },
  usage: "signal",
  reserves: [],
});

function faux(
  releve: Partial<ReleveDeMarche> & { points: PointDeMarche[] },
  references: Date[] = [],
  nom = "Binance",
): ConnecteurDeMarche {
  return {
    id: "faux",
    nom,
    couvre: () => true,
    releve: async (_i, reference) => {
      references.push(reference);
      return { url: releve.points[0]?.url ?? URL_BINANCE, brut: { k: 1 }, depuisLeCache: false, ...releve };
    },
    sante: async () => ({ ok: true, detail: "" }),
  };
}

const pont = (c: ConnecteurDeMarche, instrument = BITCOIN, ageMaxMs?: number) =>
  adaptateurDeMarche(c, instrument, {
    maintenant: () => MAINTENANT,
    ...(ageMaxMs === undefined ? {} : { ageMaxMs }),
  });

const QUERY = { topic: "Le bitcoin face aux taux", since: "2026-08-12T00:00:00Z" };

describe("pont — identite et pertinence", () => {
  it("s'identifie par connecteur et instrument", () => {
    expect(pont(faux({ points: [pointBinance()] })).id).toBe("faux:bitcoin");
  });

  it("n'est pertinent que pour un sujet qui appelle l'instrument", () => {
    const a = pont(faux({ points: [pointBinance()] }));
    expect(a.pertinent?.(QUERY)).toBe(true);
    expect(a.pertinent?.({ ...QUERY, topic: "inflation annuelle en zone euro" })).toBe(false);
  });

  it("releve l'etat a MINUIT UTC du jour, pas « maintenant »", async () => {
    const references: Date[] = [];
    await pont(faux({ points: [pointBinance()] }, references)).fetch(QUERY);
    expect(references[0]?.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(minuitUtc(new Date("2026-09-11T23:59:59Z")).toISOString()).toBe("2026-09-11T00:00:00.000Z");
  });
});

describe("pont — observation au contrat §5.1", () => {
  it("une observation par releve, datee de la DONNEE et de la REQUETE d'origine", async () => {
    const r = await pont(faux({ points: [pointBinance()] })).fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]).toMatchObject({
      source: "Binance",
      url: URL_BINANCE,
      date_observed: "2026-09-11T08:00:00.000Z",
      date_published: "2026-09-10T23:59:59.999Z",
      type: "donnee-de-marche",
    });
    expect(r.observations[0]).not.toHaveProperty("tier");
    expect(r.requestedUrl).toBe(URL_BINANCE);
  });

  it("le resume porte chaque chiffre, son unite, le perimetre et la formule exigee au gate", async () => {
    const r = await pont(faux({ points: [pointBinance()] })).fetch(QUERY);
    const resume = r.observations[0]?.resume ?? "";
    expect(resume).toContain("76568.72 USDT");
    expect(resume).toMatch(/ne valent que pour Binance/);
    expect(resume).toContain("« sur Binance »");
    expect(resume).toContain("2026-09-10T23:59:59.999Z");
    expect(resume).toContain("2026-09-11T08:00:00.000Z");
    expect(resume).toMatch(/pas le dollar/);
  });

  it("donne l'ordre de grandeur des tres grands nombres, sans inventer de precision", async () => {
    const r = await pont(
      faux({ points: [pointBinance({ nature: "volume", valeur: 1188117943.7720196, mesure: "volume" })] }),
    ).fetch(QUERY);
    expect(r.observations[0]?.resume).toContain("1188117943.77 USDT (≈ 1.19 milliard)");
  });

  it("dit dans le resume ET dans l'archive d'audit qu'un releve vient du cache", async () => {
    const r = await pont(faux({ points: [pointBinance()], depuisLeCache: true })).fetch(QUERY);
    expect(r.observations[0]?.resume).toMatch(/cache local/);
    expect(r.raw).toMatchObject({ depuisLeCache: true, horodatageRequete: "2026-09-11T08:00:00.000Z" });
  });
});

describe("pont — garde-fous appliques a TOUT connecteur", () => {
  it("un prix negatif devient un echec explicite, jamais une observation", async () => {
    await expect(pont(faux({ points: [pointBinance({ valeur: -3 })] })).fetch(QUERY)).rejects.toThrow(
      /donnee aberrante ecartee.*negative/,
    );
  });

  it("une valeur nulle devient un echec explicite", async () => {
    await expect(
      pont(faux({ points: [pointBinance({ valeur: null as unknown as number })] })).fetch(QUERY),
    ).rejects.toThrow(/valeur absente/);
  });

  it("une donnee datee du futur devient un echec explicite", async () => {
    await expect(
      pont(faux({ points: [pointBinance({ horodatageDonnee: "2026-09-12T00:00:00.000Z" })] })).fetch(QUERY),
    ).rejects.toThrow(/futur/);
  });

  it("une donnee plus vieille que l'age maximal devient un echec explicite", async () => {
    const vieille = new Date(MAINTENANT.getTime() - 9 * JOUR).toISOString();
    await expect(
      pont(faux({ points: [pointBinance({ horodatageDonnee: vieille })] }), BITCOIN, 2 * JOUR).fetch(QUERY),
    ).rejects.toThrow(/perime/);
  });

  it("un releve vide devient un echec explicite", async () => {
    await expect(pont(faux({ points: [] })).fetch(QUERY)).rejects.toThrow(/releve vide/);
  });
});

describe("pont — un signal se presente comme tel", () => {
  it("annonce NE PAS CITER et designe l'emetteur a citer", async () => {
    const r = await pont(faux({ points: [pointYahoo()] }, [], "Yahoo Finance"), CAC40).fetch({
      ...QUERY,
      topic: "Le CAC 40 recule",
    });
    const o = r.observations[0];
    expect(o?.type).toBe("signal-de-marche");
    expect(o?.source).toBe("Yahoo Finance (signal)");
    expect(o?.resume).toMatch(/^SIGNAL DE PRE-VERIFICATION — NE PAS CITER/);
    expect(o?.resume).toContain("Euronext (euronext.com)");
  });
});

/* -------------------------------------------------------------------------
 * A travers la VRAIE passerelle
 * ---------------------------------------------------------------------- */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pont-marche-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pont — a travers la passerelle reelle", () => {
  it("le tier vient du registre, et aucun resume n'est pris pour une injection", async () => {
    const gateway = new SourceGateway(
      [
        pont(faux({ points: [pointBinance()] })),
        pont(faux({ points: [pointYahoo()] }, [], "Yahoo Finance"), CAC40),
      ],
      new AuditLog({ dir }),
    );
    const r = await gateway.collect({ topic: "bitcoin et CAC 40", since: QUERY.since }, "veilleur");
    expect(r.failures).toEqual([]);
    expect(r.unregisteredUrls).toEqual([]);
    expect(r.events.find((e) => e.url === URL_BINANCE)?.tier).toBe(1);
    expect(r.events.find((e) => e.url === URL_YAHOO)?.tier).toBe(3);
  });
});

/* -------------------------------------------------------------------------
 * Catalogue
 * ---------------------------------------------------------------------- */

describe("catalogue — sources de marche", () => {
  const ids = (env: NodeJS.ProcessEnv) => buildSourceCatalogue(env).adapters.map((a) => a.id);

  it("branche Binance et Yahoo, qui n'exigent aucune clef", () => {
    expect(ids({})).toEqual(
      expect.arrayContaining(["binance:bitcoin", "binance:ether", "yahoo:cac40", "yahoo:brent"]),
    );
  });

  it("ecarte CoinGecko sans clef, et dit pourquoi (EP-003)", () => {
    const { adapters, skipped } = buildSourceCatalogue({});
    expect(adapters.some((a) => a.id.startsWith("coingecko:"))).toBe(false);
    expect(skipped.find((s) => s.id.startsWith("coingecko:"))?.reason).toMatch(
      /COINGECKO_API_KEY absente/,
    );
  });

  it("inclut CoinGecko quand la clef est fournie", () => {
    expect(ids({ COINGECKO_API_KEY: "CG-fictive" })).toEqual(
      expect.arrayContaining(["coingecko:bitcoin", "coingecko:ether"]),
    );
  });

  it("aucune source de marche n'est interrogee pour un sujet sans rapport", () => {
    const marche = buildSourceCatalogue({ COINGECKO_API_KEY: "CG-fictive" }).adapters.filter((a) =>
      /^(binance|coingecko|yahoo):/.test(a.id),
    );
    expect(marche.length).toBeGreaterThan(0);
    const q = { topic: "inflation annuelle en zone euro", since: QUERY.since };
    expect(marche.filter((a) => a.pertinent?.(q) !== false)).toEqual([]);
  });

  it("un sujet crypto appelle Binance et CoinGecko, pas Yahoo", () => {
    const q = { topic: "le bitcoin apres la decision de la Fed", since: QUERY.since };
    const pertinents = buildSourceCatalogue({ COINGECKO_API_KEY: "CG-fictive" })
      .adapters.filter((a) => a.pertinent?.(q) === true)
      .map((a) => a.id);
    expect(pertinents).toEqual(expect.arrayContaining(["binance:bitcoin", "coingecko:bitcoin"]));
    expect(pertinents.some((id) => id.startsWith("yahoo:"))).toBe(false);
  });

  it("lit la duree de cache dans l'environnement, et ignore une valeur absurde", () => {
    expect(ttlDepuisEnv({ MARCHE_CACHE_TTL_MINUTES: "30" })).toBe(30 * 60_000);
    expect(ttlDepuisEnv({ MARCHE_CACHE_TTL_MINUTES: "abc" })).toBeUndefined();
    expect(ttlDepuisEnv({ MARCHE_CACHE_TTL_MINUTES: "-5" })).toBeUndefined();
    expect(ttlDepuisEnv({})).toBeUndefined();
  });
});
