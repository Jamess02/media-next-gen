/**
 * Adaptateur reel Banque mondiale.
 *
 * `fetch` est remplace par un bouchon : un test qui dependrait du reseau
 * echouerait hors ligne et testerait la disponibilite de l'API plutot que notre
 * code. Les charges utiles reproduisent la forme reelle de l'API v2.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { worldBankAdapter } from "../src/sources/worldbank.js";
import { stubFetch } from "./helpers.js";

const QUERY = { topic: "inflation", since: "2020-01-01T00:00:00Z" };

const adapter = worldBankAdapter({
  country: "EMU",
  indicator: "FP.CPI.TOTL.ZG",
  years: 3,
});

const point = (date: string, value: number | null) => ({
  indicator: { id: "FP.CPI.TOTL.ZG", value: "Inflation, consumer prices (annual %)" },
  country: { id: "XC", value: "Euro area" },
  countryiso3code: "EMU",
  date,
  value,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptateur Banque mondiale", () => {
  it("extrait la derniere valeur non nulle", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 3, lastupdated: "2026-07-13" },
      [point("2025", 2.4), point("2024", 2.9), point("2023", 5.4)],
    ]);

    const outcome = await adapter.fetch(QUERY);
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.observations[0]?.resume).toMatch(/2\.4 \(2025\)/);
  });

  it("arrondit les flottants bruts de l'API (EP-005)", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 1, lastupdated: "2026-07-13" },
      [point("2025", 2.46705543774613)],
    ]);

    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    // Quatorze decimales sur un taux d'inflation affirment une precision
    // que la mesure n'a pas.
    expect(resume).toMatch(/2\.47 \(2025\)/);
    expect(resume).not.toMatch(/2\.46705543774613/);
  });

  it("n'invente pas de decimales sur une valeur entiere (EP-005)", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 1, lastupdated: "2026-07-13" },
      [point("2025", 3)],
    ]);

    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/: 3 \(2025\)/);
    expect(resume).not.toMatch(/3\.00/);
  });

  it("reporte `lastupdated` en date de publication (§5.2)", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 1, lastupdated: "2026-07-13" },
      [point("2025", 2.4)],
    ]);

    const outcome = await adapter.fetch(QUERY);
    expect(outcome.observations[0]?.date_published).toBe(
      "2026-07-13T00:00:00.000Z",
    );
  });

  it("signale les annees manquantes plutot que de les ignorer (EP-005)", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 3, lastupdated: "2026-07-13" },
      [point("2025", null), point("2024", 2.9), point("2023", null)],
    ]);

    const outcome = await adapter.fetch(QUERY);
    const resume = outcome.observations[0]?.resume ?? "";
    expect(resume).toMatch(/Couverture : 1\/3 annees renseignees/);
    expect(resume).toMatch(/manquantes : 2025, 2023/);
  });

  it("produit une URL citable distincte de l'URL d'API interrogee (§9.4)", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 1, lastupdated: "2026-07-13" },
      [point("2025", 2.4)],
    ]);

    const outcome = await adapter.fetch(QUERY);
    expect(outcome.requestedUrl).toMatch(/^https:\/\/api\.worldbank\.org\/v2\//);
    expect(outcome.observations[0]?.url).toMatch(
      /^https:\/\/data\.worldbank\.org\/indicator\//,
    );
  });

  it("echoue sur une reponse HTTP non OK", async () => {
    stubFetch(null, { ok: false, status: 503 });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/HTTP 503/);
  });

  it("echoue sur un payload inattendu, malgre un HTTP 200", async () => {
    // L'API repond 200 avec un objet d'erreur si l'indicateur est inconnu :
    // se fier au seul code HTTP laisserait passer une reponse vide.
    stubFetch({ message: [{ id: "120", value: "Invalid value" }] });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/reponse inattendue/);
  });

  it("echoue si la serie ne contient aucune valeur", async () => {
    stubFetch([
      { page: 1, pages: 1, total: 2, lastupdated: "2026-07-13" },
      [point("2025", null), point("2024", null)],
    ]);
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/aucune valeur non nulle/);
  });
});
