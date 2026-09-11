/**
 * Connecteur CoinGecko — agregat multi-plateformes, plan Demo.
 *
 * Ecrits AVANT le code (TDD).
 *
 * MESURES du 2026-09-11 :
 *  - le point de 2026-09-11T00:00:00Z de `market_chart/range` vaut
 *    76554.98664973286 USD, EXACTEMENT la valeur de l'instantane journalier
 *    `history` — mais avec son horodatage DANS la donnee ;
 *  - l'URL se rejoue SANS clef (HTTP 200) : un lecteur peut verifier ;
 *  - aucun en-tete de limite de debit n'est renvoye : le debit est tenu par
 *    nous seuls (plan Demo : 100 appels/min, 10 000 credits/mois).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { COINGECKO_BASE, connecteurCoinGecko, politiqueCoinGecko } from "../src/marche/coingecko.js";
import { INSTRUMENTS } from "../src/marche/instruments.js";
import { MINUIT, T0, horlogeFactice, stubReponses } from "./helpers-marche.js";

afterEach(() => vi.unstubAllGlobals());

const CLEF = "clef-demo-fictive-jamais-reelle"; // secret-autorise: valeur de test
const BITCOIN = INSTRUMENTS.find((i) => i.id === "bitcoin")!;
const M = MINUIT.getTime();

/** Points de cinq minutes autour de minuit, valeurs reelles pour 00:00. */
const SERIE = {
  prices: [
    [M - 600_000, 76700.25236711024],
    [M - 300_000, 76629.67655141272],
    [M, 76554.98664973286],
    [M + 300_000, 76633.87015423016],
    [M + 600_000, 76773.38531700437],
  ],
  market_caps: [
    [M - 600_000, 1540200000000],
    [M - 300_000, 1538900000000],
    [M, 1537413069633.6875],
    [M + 300_000, 1538700000000],
    [M + 600_000, 1541300000000],
  ],
  total_volumes: [
    [M - 600_000, 30300000000],
    [M - 300_000, 30280000000],
    [M, 30257901047.74022],
    [M + 300_000, 30240000000],
    [M + 600_000, 30220000000],
  ],
};

const coingecko = () => connecteurCoinGecko({ apiKey: CLEF, horloge: horlogeFactice().h });

describe("CoinGecko — la clef ne quitte jamais l'en-tete", () => {
  it("envoie la clef dans x-cg-demo-api-key", async () => {
    const appels = stubReponses([{ corps: SERIE }]);
    await coingecko().releve(BITCOIN, MINUIT);
    expect(appels[0]?.entetes["x-cg-demo-api-key"]).toBe(CLEF);
  });

  it("n'ecrit JAMAIS la clef dans l'URL interrogee ni dans l'URL citee", async () => {
    const appels = stubReponses([{ corps: SERIE }]);
    const r = await coingecko().releve(BITCOIN, MINUIT);
    expect(appels[0]?.url).not.toContain(CLEF);
    expect(r.url).not.toContain(CLEF);
    for (const p of r.points) expect(p.url).not.toContain(CLEF);
  });

  it("interroge l'hote du plan Demo", () => {
    expect(COINGECKO_BASE).toBe("https://api.coingecko.com/api/v3");
    expect(politiqueCoinGecko(CLEF).delaiMs).toBe(10_000);
  });
});

describe("CoinGecko — releve a minuit UTC, horodatage explicite", () => {
  it("demande une fenetre de dix minutes de part et d'autre de minuit, en dollars", async () => {
    const appels = stubReponses([{ corps: SERIE }]);
    await coingecko().releve(BITCOIN, MINUIT);
    const u = new URL(appels[0]!.url);
    expect(u.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
    expect(u.searchParams.get("vs_currency")).toBe("usd");
    expect(Number(u.searchParams.get("from"))).toBe(M / 1000 - 600);
    expect(Number(u.searchParams.get("to"))).toBe(M / 1000 + 600);
  });

  it("retient le point de 00:00:00Z, avec l'horodatage porte par la donnee", async () => {
    stubReponses([{ corps: SERIE }]);
    const r = await coingecko().releve(BITCOIN, MINUIT);
    const prix = r.points.find((p) => p.nature === "prix");
    expect(prix).toMatchObject({ valeur: 76554.98664973286, unite: "USD" });
    expect(prix?.horodatageDonnee).toBe("2026-09-11T00:00:00.000Z");
    expect(prix?.horodatageRequete).toBe(new Date(T0).toISOString());
  });

  it("prend capitalisation et volume au MEME instant que le prix", async () => {
    // Des mesures d'instants differents dans un meme releve violeraient
    // EP-006 sans que rien ne le montre.
    stubReponses([{ corps: SERIE }]);
    const r = await coingecko().releve(BITCOIN, MINUIT);
    expect(r.points.find((p) => p.nature === "capitalisation")?.valeur).toBe(1537413069633.6875);
    expect(r.points.find((p) => p.nature === "volume")?.valeur).toBe(30257901047.74022);
    expect(new Set(r.points.map((p) => p.horodatageDonnee)).size).toBe(1);
  });

  it("agregat, fiabilite primaire (emetteur de son agregat), attribution exigee", async () => {
    stubReponses([{ corps: SERIE }]);
    const r = await coingecko().releve(BITCOIN, MINUIT);
    expect(r.points[0]).toMatchObject({
      source: "CoinGecko",
      fiabilite: "primaire",
      usage: "citable",
      perimetre: { type: "agrege" },
    });
    expect(r.points[0]?.reserves.join(" ")).toMatch(/selon CoinGecko/);
  });
});

describe("CoinGecko — echecs explicites", () => {
  it("refuse une reponse dont la forme a change", async () => {
    stubReponses([{ corps: { prices: "indisponible" } }]);
    await expect(coingecko().releve(BITCOIN, MINUIT)).rejects.toThrow(/schema de reponse modifie/);
  });

  it("refuse une serie sans point a minuit, au lieu d'en prendre un autre", async () => {
    stubReponses([
      {
        corps: {
          prices: [[M - 3_600_000, 76000]],
          market_caps: [[M - 3_600_000, 1]],
          total_volumes: [[M - 3_600_000, 1]],
        },
      },
    ]);
    await expect(coingecko().releve(BITCOIN, MINUIT)).rejects.toThrow(/minuit/);
  });

  it("refuse une valeur nulle a minuit", async () => {
    stubReponses([
      { corps: { ...SERIE, prices: SERIE.prices.map(([t, v]) => [t, t === M ? null : v]) } },
    ]);
    await expect(coingecko().releve(BITCOIN, MINUIT)).rejects.toThrow(/valeur absente/);
  });

  it("clef refusee : pas de reprise, motif du fournisseur", async () => {
    const appels = stubReponses([
      { status: 401, corps: { status: { error_code: 10002, error_message: "Invalid API key" } } },
    ]);
    await expect(coingecko().releve(BITCOIN, MINUIT)).rejects.toThrow(/401.*Invalid API key/);
    expect(appels).toHaveLength(1);
  });
});

describe("CoinGecko — sonde de sante", () => {
  it("rend ok quand /ping repond comme attendu", async () => {
    stubReponses([{ corps: { gecko_says: "(V3) To the Moon!" } }]);
    expect(await coingecko().sante()).toMatchObject({ ok: true });
  });

  it("rend ko quand la reponse du ping a change de forme", async () => {
    stubReponses([{ corps: { autre: 1 } }]);
    expect((await coingecko().sante()).ok).toBe(false);
  });
});
