/**
 * Adaptateurs de sources reelles.
 *
 * Chaque bloc cible le PIEGE propre a sa source — celui qui produirait une
 * donnee fausse sans bruit :
 *   FMI       : projections melangees aux observations
 *   Eurostat  : index a plat mal interprete si une dimension n'est pas figee
 *   USGS      : solution automatique presentee comme definitive
 *   FRED      : "." converti en 0, et clef d'API dans l'URL
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSourceCatalogue } from "../src/sources/catalogue.js";
import { eurostatAdapter } from "../src/sources/eurostat.js";
import { fredAdapter } from "../src/sources/fred.js";
import { imfAdapter } from "../src/sources/imf.js";
import { usgsAdapter } from "../src/sources/usgs.js";
import { lastFetchedUrl, stubFetch } from "./helpers.js";

const QUERY = { topic: "test", since: "2026-01-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------
 * FMI
 * ---------------------------------------------------------------------- */

describe("FMI — separation observations / projections (§3)", () => {
  const adapter = imfAdapter({
    country: "FRA",
    indicator: "NGDP_RPCH",
    label: "Croissance du PIB reel",
  });

  const payload = {
    values: {
      NGDP_RPCH: {
        FRA: { "2023": 1.1, "2024": 1.2, "2025": 0.8, "2026": 1.3, "2027": 1.5 },
        DEU: { "2024": -0.2 },
      },
    },
  };

  beforeEach(() => {
    // Annee courante figee a 2026 : 2026 et 2027 sont donc des projections.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00Z"));
  });

  it("retient la derniere annee ANTERIEURE a l'annee en cours", async () => {
    stubFetch(payload);
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    // 2025, pas 2027 : publier une prevision a un an comme un fait serait
    // exactement l'erreur que le §3 interdit.
    expect(resume).toMatch(/0\.8 pour 2025/);
    expect(resume).not.toMatch(/pour 2027/);
  });

  it("annonce le nombre de projections presentes dans la serie", async () => {
    stubFetch(payload);
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/2 annee\(s\) de PROJECTIONS \(2026-2027\)/);
  });

  it("declare la reserve sur le caractere estime de la derniere annee (EP-003)", async () => {
    stubFetch(payload);
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/estimation plutot qu'un chiffre/);
  });

  it("echoue si la serie ne contient que des projections", async () => {
    stubFetch({ values: { NGDP_RPCH: { FRA: { "2026": 1.3, "2027": 1.5 } } } });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/que des projections/);
  });

  it("echoue sur un code pays absent de la reponse", async () => {
    stubFetch({ values: { NGDP_RPCH: { DEU: { "2024": -0.2 } } } });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/aucune serie/);
  });

  it("ne fabrique pas de date de publication (§8)", async () => {
    stubFetch(payload);
    // L'API DataMapper ne date pas ses series : on rend null plutot que
    // d'inventer une date.
    expect((await adapter.fetch(QUERY)).observations[0]?.date_published).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Eurostat
 * ---------------------------------------------------------------------- */

describe("Eurostat — indexation JSON-stat", () => {
  const adapter = eurostatAdapter({
    dataset: "prc_hicp_manr",
    filters: { geo: "EA", coicop: "CP00", unit: "RCH_A", freq: "M" },
    label: "IPCH",
  });

  const dataset = (overrides: Record<string, unknown> = {}) => ({
    label: "HICP - monthly data (annual rate of change)",
    updated: "2026-02-06T23:00:00+0100",
    value: { "0": 2.1, "1": 2.1, "2": 2 },
    id: ["freq", "unit", "coicop", "geo", "time"],
    size: [1, 1, 1, 1, 3],
    dimension: {
      geo: { category: { index: { EA: 0 }, label: { EA: "Euro area" } } },
      time: {
        category: { index: { "2025-10": 0, "2025-11": 1, "2025-12": 2 } },
      },
    },
    ...overrides,
  });

  it("retient la periode la plus recente", async () => {
    stubFetch(dataset());
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/2 pour 2025-12/);
    expect(resume).toMatch(/Euro area/);
  });

  it("REFUSE de deviner quand une dimension n'est pas figee", async () => {
    // Deux pays et trois periodes : l'index a plat ne correspond plus a la
    // seule position temporelle. Lire quand meme donnerait un chiffre
    // plausible mais faux — le pire cas possible.
    stubFetch(
      dataset({
        size: [1, 1, 1, 2, 3],
        dimension: {
          geo: { category: { index: { EA: 0, FR: 1 } } },
          time: {
            category: { index: { "2025-10": 0, "2025-11": 1, "2025-12": 2 } },
          },
        },
      }),
    );
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/dimensions non figees : geo/);
  });

  it("compte les periodes manquantes (EP-005)", async () => {
    // JSON-stat omet les valeurs absentes : l'index 1 n'existe pas.
    stubFetch(dataset({ value: { "0": 2.1, "2": 2 } }));
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/2\/3 periodes renseignees/);
    expect(resume).toMatch(/manquantes : 2025-11/);
  });

  it("reporte la date de mise a jour du jeu de donnees (§5.2)", async () => {
    stubFetch(dataset());
    const published = (await adapter.fetch(QUERY)).observations[0]?.date_published;
    expect(published).toBe("2026-02-06T22:00:00.000Z");
  });

  it("echoue si aucune periode n'est renseignee", async () => {
    stubFetch(dataset({ value: {} }));
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/aucune valeur renseignee/);
  });
});

/* -------------------------------------------------------------------------
 * USGS
 * ---------------------------------------------------------------------- */

describe("USGS — statut des solutions (§5.2)", () => {
  const adapter = usgsAdapter({ minMagnitude: 6, limit: 3 });

  const feature = (overrides: Record<string, unknown> = {}) => ({
    properties: {
      mag: 6.4,
      place: "145 km N of Caluula, Somalia",
      time: 1787864858352,
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000tcf3",
      status: "reviewed",
      tsunami: 0,
      alert: "green",
      ...overrides,
    },
    geometry: { coordinates: [50.1, 12.9, 10.5] },
  });

  const collection = (features: unknown[]) => ({
    type: "FeatureCollection",
    features,
  });

  it("signale une solution PRELIMINAIRE comme revisable", async () => {
    stubFetch(collection([feature({ status: "automatic" })]));
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/PRELIMINAIRE/);
    expect(resume).toMatch(/peut etre revisee/);
  });

  it("distingue une solution revue", async () => {
    stubFetch(collection([feature()]));
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/revue par un sismologue/);
    expect(resume).not.toMatch(/PRELIMINAIRE/);
  });

  it("utilise la fenetre de fraicheur dans la requete (§5.1)", async () => {
    stubFetch(collection([feature()]));
    await adapter.fetch(QUERY);
    expect(lastFetchedUrl()).toMatch(/starttime=2026-01-01/);
  });

  it("rend une observation par seisme, chacune avec sa page evenement", async () => {
    stubFetch(
      collection([
        feature(),
        feature({
          url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000zzzz",
        }),
      ]),
    );
    const observations = (await adapter.fetch(QUERY)).observations;
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((o) => o.url)).size).toBe(2);
  });

  it("ecarte un evenement sans magnitude ou sans page citable (§2)", async () => {
    stubFetch(collection([feature({ mag: null }), feature()]));
    expect((await adapter.fetch(QUERY)).observations).toHaveLength(1);
  });

  it("signale une alerte tsunami", async () => {
    stubFetch(collection([feature({ tsunami: 1 })]));
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/Alerte tsunami/);
  });

  it("echoue si aucun evenement exploitable", async () => {
    stubFetch(collection([]));
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/aucun seisme exploitable/);
  });
});

/* -------------------------------------------------------------------------
 * FRED
 * ---------------------------------------------------------------------- */

describe("FRED — clef dans l'URL et valeurs manquantes", () => {
  const adapter = fredAdapter({
    seriesId: "FEDFUNDS",
    label: "Taux des fonds federaux",
    apiKey: "CLEF_DE_TEST",
    limit: 3,
  });

  const payload = (observations: unknown[]) => ({
    realtime_start: "2026-08-28",
    observations,
  });

  it("ne convertit PAS les valeurs \".\" en zero", async () => {
    // Un Number(".") naif donnerait NaN, un parseFloat laxiste 0 : les deux
    // fabriqueraient une donnee qui n'existe pas.
    stubFetch(
      payload([
        { date: "2026-08-01", value: "." },
        { date: "2026-07-01", value: "4.33" },
      ]),
    );
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/4\.33 au 2026-07-01/);
    expect(resume).toMatch(/1\/2 observations renseignees/);
    expect(resume).toMatch(/manquantes : 2026-08-01/);
  });

  it("transporte la clef dans l'URL — d'ou la necessite du caviardage", async () => {
    stubFetch(payload([{ date: "2026-07-01", value: "4.33" }]));
    await adapter.fetch(QUERY);
    // Ce test documente le risque plutot que de le nier : la clef EST dans
    // l'URL. C'est le journal d'audit qui la caviarde (cf. gateway.test.ts).
    expect(lastFetchedUrl()).toMatch(/api_key=CLEF_DE_TEST/);
  });

  it("signale le millesime interroge (§5.2)", async () => {
    stubFetch(payload([{ date: "2026-07-01", value: "4.33" }]));
    const resume = (await adapter.fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/Millesime interroge : 2026-08-28/);
    expect(resume).toMatch(/FRED revise ses series/);
  });

  it("echoue si toutes les observations sont manquantes", async () => {
    stubFetch(payload([{ date: "2026-08-01", value: "." }]));
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/aucune valeur renseignee/);
  });
});

/* -------------------------------------------------------------------------
 * Catalogue
 * ---------------------------------------------------------------------- */

describe("catalogue des sources", () => {
  it("inclut les sources sans clef", () => {
    const { adapters } = buildSourceCatalogue({});
    const ids = adapters.map((a) => a.id);
    expect(ids.some((id) => id.startsWith("worldbank:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("imf:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("eurostat:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("usgs:"))).toBe(true);
  });

  it("ecarte FRED sans clef, et dit pourquoi (EP-003)", () => {
    const { adapters, skipped } = buildSourceCatalogue({});
    expect(adapters.some((a) => a.id.startsWith("fred:"))).toBe(false);
    const fred = skipped.find((s) => s.id.startsWith("fred:"));
    expect(fred?.reason).toMatch(/FRED_API_KEY absente/);
  });

  it("inclut FRED quand la clef est fournie", () => {
    const { adapters, skipped } = buildSourceCatalogue({ FRED_API_KEY: "abc" });
    expect(adapters.some((a) => a.id.startsWith("fred:"))).toBe(true);
    expect(skipped.some((s) => s.id.startsWith("fred:"))).toBe(false);
  });

  it("traite une clef vide comme absente", () => {
    const { adapters } = buildSourceCatalogue({ FRED_API_KEY: "   " });
    expect(adapters.some((a) => a.id.startsWith("fred:"))).toBe(false);
  });

  it("documente les sources ecartees pour raisons externes", () => {
    const { skipped } = buildSourceCatalogue({});
    const ids = skipped.map((s) => s.id);
    expect(ids).toContain("gdelt:doc");
    expect(ids).toContain("reliefweb:reports");
    expect(skipped.find((s) => s.id === "gdelt:doc")?.reason).toMatch(
      /certificat TLS expire/,
    );
  });
});
