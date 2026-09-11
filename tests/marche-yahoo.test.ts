/**
 * Connecteur Yahoo Finance — option (b), TypeScript natif, validee par
 * l'editeur le 2026-09-11.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Yahoo est un SIGNAL : agregateur grand public, jamais cite, jamais sur le
 * chemin critique. Il n'a pas de version a epingler — c'est le SCHEMA de sa
 * reponse qui fait contrat, versionne dans le code. Un changement de Yahoo
 * doit produire un echec bruyant qui nomme ce contrat, jamais une valeur nulle
 * dans un article.
 *
 * MESURES du 2026-09-11 : l'endpoint repond HTTP 200 avec notre agent declare,
 * sans cookie ni jeton — aucun contournement ; les valeurs portent des
 * artefacts de flottant 32 bits (8116.759765625) ; le Nikkei rend une cloture
 * `null` pour la seance en cours.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { INSTRUMENTS } from "../src/marche/instruments.js";
import { CONTRAT_YAHOO, POLITIQUE_YAHOO, connecteurYahoo } from "../src/marche/yahoo.js";
import { MINUIT, T0, horlogeFactice, stubReponses } from "./helpers-marche.js";

afterEach(() => vi.unstubAllGlobals());

const CAC40 = INSTRUMENTS.find((i) => i.id === "cac40")!;
const NIKKEI = INSTRUMENTS.find((i) => i.id === "nikkei225")!;
const REF_S = MINUIT.getTime() / 1000;

/** Reponse reelle du CAC 40, abregee aux champs du contrat. */
function chartCac40(o: { meta?: Record<string, unknown>; close?: Array<number | null> } = {}) {
  const timestamp = [1788764400, 1788850800, 1788937200, 1789023600];
  return {
    chart: {
      result: [
        {
          meta: {
            currency: "EUR",
            symbol: "^FCHI",
            exchangeName: "PAR",
            instrumentType: "INDEX",
            exchangeTimezoneName: "Europe/Paris",
            priceHint: 2,
            longName: "CAC 40",
            ...o.meta,
          },
          timestamp,
          indicators: {
            quote: [
              {
                close: o.close ?? [8306.150390625, 8317.98046875, 8156.669921875, 8116.759765625],
                open: [8272.76, 8268.12, 8258.24, 8169.65],
                high: [8317.37, 8320.05, 8277.24, 8190.08],
                low: [8255.72, 8257.6, 8141.42, 8114],
                volume: [35204400, 42624800, 60176300, 49671000],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

const yahoo = () => connecteurYahoo({ horloge: horlogeFactice().h });

describe("Yahoo — aucun contournement, un debit client prudent", () => {
  it("s'annonce sous son nom : aucune usurpation de navigateur", async () => {
    const appels = stubReponses([{ corps: chartCac40() }]);
    await yahoo().releve(CAC40, MINUIT);
    expect(appels[0]?.entetes["user-agent"]).toBe("media-next-gen (pipeline editorial)");
    expect(Object.keys(appels[0]?.entetes ?? {}).map((n) => n.toLowerCase())).not.toContain("cookie");
    expect(appels[0]?.url).not.toMatch(/crumb/);
  });

  it("limite le debit bien en deca de ce que Yahoo tolere, avec un delai de dix secondes", () => {
    expect(POLITIQUE_YAHOO.intervalleMinMs).toBeGreaterThanOrEqual(2_000);
    expect(POLITIQUE_YAHOO.delaiMs).toBe(10_000);
  });

  it("interroge une fenetre CLOSE bornee : l'URL se rejoue", async () => {
    const appels = stubReponses([{ corps: chartCac40() }]);
    await yahoo().releve(CAC40, MINUIT);
    const u = new URL(appels[0]!.url);
    expect(u.pathname).toBe("/v8/finance/chart/%5EFCHI");
    expect(Number(u.searchParams.get("period2"))).toBe(REF_S);
    expect(Number(u.searchParams.get("period1"))).toBeLessThan(REF_S);
    expect(u.searchParams.get("interval")).toBe("1d");
  });
});

describe("Yahoo — un signal, jamais une preuve", () => {
  it("fiabilite secondaire, usage signal", async () => {
    stubReponses([{ corps: chartCac40() }]);
    const r = await yahoo().releve(CAC40, MINUIT);
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toMatchObject({
      source: "Yahoo Finance",
      fiabilite: "secondaire",
      usage: "signal",
      perimetre: { type: "agrege" },
    });
  });

  it("retient la derniere seance close, date locale de la place comprise", async () => {
    stubReponses([{ corps: chartCac40() }]);
    const r = await yahoo().releve(CAC40, MINUIT);
    expect(r.points[0]?.mesure).toMatch(/seance du 2026-09-10 \(Europe\/Paris\)/);
    expect(r.points[0]?.horodatageDonnee).toBe("2026-09-10T07:00:00.000Z");
    expect(r.points[0]?.horodatageRequete).toBe(new Date(T0).toISOString());
  });

  it("arrondit au priceHint de Yahoo : pas d'artefact de flottant (EP-005)", async () => {
    stubReponses([{ corps: chartCac40() }]);
    const r = await yahoo().releve(CAC40, MINUIT);
    expect(r.points[0]).toMatchObject({ valeur: 8116.76, unite: "points", nature: "niveau" });
  });

  it("saute une cloture nulle et une seance non close — le cas MESURE du Nikkei", async () => {
    const corps = chartCac40({
      meta: { symbol: "^N225", currency: "JPY", exchangeTimezoneName: "Asia/Tokyo" },
      close: [43000.5, 43100.25, 43200.75, null],
    });
    // Derniere barre a minuit pile : la seance du jour, pas encore close.
    (corps.chart.result[0] as { timestamp: number[] }).timestamp = [
      REF_S - 3 * 86_400,
      REF_S - 2 * 86_400,
      REF_S - 86_400,
      REF_S,
    ];
    stubReponses([{ corps }]);
    const r = await yahoo().releve(NIKKEI, MINUIT);
    expect(r.points[0]?.valeur).toBe(43200.75);
  });
});

describe("Yahoo — le schema fait contrat, et le contrat est versionne", () => {
  it("refuse une reponse privee d'un champ du contrat, en nommant la version", async () => {
    const casse = chartCac40();
    delete (casse.chart.result[0] as { indicators?: unknown }).indicators;
    stubReponses([{ corps: casse }]);
    const erreur = await yahoo().releve(CAC40, MINUIT).catch((e: unknown) => String(e));
    expect(erreur).toMatch(/schema de reponse modifie/);
    expect(erreur).toContain(CONTRAT_YAHOO);
  });

  it("refuse une devise changee : ce serait changer l'unite du chiffre", async () => {
    stubReponses([{ corps: chartCac40({ meta: { currency: "USD" } }) }]);
    await expect(yahoo().releve(CAC40, MINUIT)).rejects.toThrow(/devise USD au lieu de EUR/);
  });

  it("refuse un symbole different de celui demande", async () => {
    stubReponses([{ corps: chartCac40({ meta: { symbol: "^GSPC" } }) }]);
    await expect(yahoo().releve(CAC40, MINUIT)).rejects.toThrow(/symbole/);
  });

  it("rapporte l'erreur que Yahoo declare", async () => {
    stubReponses([
      {
        status: 404,
        corps: { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } },
      },
    ]);
    await expect(yahoo().releve(CAC40, MINUIT)).rejects.toThrow(/No data found/);
  });

  it("dit clairement qu'aucune seance close n'existe dans la fenetre", async () => {
    stubReponses([{ corps: chartCac40({ close: [null, null, null, null] }) }]);
    await expect(yahoo().releve(CAC40, MINUIT)).rejects.toThrow(/aucune seance close/);
  });
});

describe("Yahoo — sonde de sante", () => {
  it("rend ok quand le contrat est respecte", async () => {
    stubReponses([{ corps: chartCac40() }]);
    const etat = await yahoo().sante();
    expect(etat.ok).toBe(true);
    expect(etat.detail).toContain(CONTRAT_YAHOO);
  });

  it("rend ko, avec le motif, quand le contrat est rompu", async () => {
    stubReponses([{ corps: { chart: { result: [], error: null } } }]);
    const etat = await yahoo().sante();
    expect(etat.ok).toBe(false);
    expect(etat.detail).toMatch(/schema de reponse modifie/);
  });
});
