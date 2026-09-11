/**
 * Connecteur Binance — donnees publiques de marche, sans clef.
 *
 * Ecrits AVANT le code (TDD).
 *
 * La charge utile de reference est la bougie REELLE du 2026-09-10 pour
 * BTCUSDT, obtenue le 2026-09-11 sur data-api.binance.vision.
 *
 * Ce que ces tests verrouillent : l'hote de donnees publiques et lui seul, pas
 * de clef ni de signature, une URL rejouable, l'unite USDT, les deux
 * horodatages, et un echec bruyant des que la forme change.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { BINANCE_CHEMINS, POLITIQUE_BINANCE, connecteurBinance } from "../src/marche/binance.js";
import { INSTRUMENTS } from "../src/marche/instruments.js";
import { MINUIT, T0, horlogeFactice, stubReponses } from "./helpers-marche.js";

afterEach(() => vi.unstubAllGlobals());

const BITCOIN = INSTRUMENTS.find((i) => i.id === "bitcoin")!;

/** Reponse reelle, mesuree le 2026-09-11. */
const BOUGIE_REELLE = [
  1788998400000,
  "78306.43000000",
  "78564.39000000",
  "76464.00000000",
  "76568.72000000",
  "15320.36904000",
  1789084799999,
  "1188117943.77201960",
  3080707,
  "6426.97352000",
  "498398012.04048190",
  "0",
];

const binance = () => connecteurBinance({ horloge: horlogeFactice().h });

describe("Binance — perimetre technique impose par l'editeur", () => {
  it("interroge data-api.binance.vision, jamais api.binance.com", () => {
    expect(POLITIQUE_BINANCE.base).toBe("https://data-api.binance.vision");
  });

  it("n'autorise que les endpoints publics de la liste, plus la sonde de sante", () => {
    expect([...BINANCE_CHEMINS].sort()).toEqual(
      [
        "/api/v3/aggTrades",
        "/api/v3/avgPrice",
        "/api/v3/depth",
        "/api/v3/exchangeInfo",
        "/api/v3/klines",
        "/api/v3/ping",
        "/api/v3/ticker/24hr",
      ].sort(),
    );
  });

  it("borne chaque requete a dix secondes", () => {
    expect(POLITIQUE_BINANCE.delaiMs).toBe(10_000);
  });

  it("suit le poids consomme et s'arrete avant le plafond mesure de 6000 par minute", () => {
    expect(POLITIQUE_BINANCE.poids).toMatchObject({ entete: "x-mbx-used-weight-1m", plafond: 6000 });
    expect(POLITIQUE_BINANCE.poids!.seuil).toBeLessThan(6000);
  });
});

describe("Binance — releve de reference", () => {
  it("demande la bougie journaliere CLOSE de la veille, bornes explicites : l'URL se rejoue", async () => {
    const appels = stubReponses([{ corps: [BOUGIE_REELLE] }]);
    await binance().releve(BITCOIN, MINUIT);
    expect(appels[0]?.url).toBe(
      "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d" +
        "&startTime=1788998400000&endTime=1789084799999",
    );
  });

  it("n'envoie ni clef de compte ni signature", async () => {
    const appels = stubReponses([{ corps: [BOUGIE_REELLE] }]);
    await binance().releve(BITCOIN, MINUIT);
    const noms = Object.keys(appels[0]?.entetes ?? {}).map((n) => n.toLowerCase());
    expect(noms).not.toContain("x-mbx-apikey");
    expect(appels[0]?.url).not.toMatch(/signature|timestamp=/);
  });

  it("rend la cloture en USDT — jamais en dollars", async () => {
    stubReponses([{ corps: [BOUGIE_REELLE] }]);
    const r = await binance().releve(BITCOIN, MINUIT);
    const cloture = r.points.find((p) => p.mesure.startsWith("cloture"));
    expect(cloture).toMatchObject({ valeur: 76568.72, unite: "USDT", nature: "prix" });
  });

  it("rend les volumes de la paire, en BTC et en USDT", async () => {
    stubReponses([{ corps: [BOUGIE_REELLE] }]);
    const r = await binance().releve(BITCOIN, MINUIT);
    const volumes = r.points.filter((p) => p.nature === "volume");
    expect(volumes.map((p) => p.unite).sort()).toEqual(["BTC", "USDT"]);
  });

  it("chaque point porte l'horodatage de la DONNEE et celui de la REQUETE", async () => {
    stubReponses([{ corps: [BOUGIE_REELLE] }]);
    const r = await binance().releve(BITCOIN, MINUIT);
    for (const p of r.points) {
      expect(p.horodatageDonnee).toBe("2026-09-10T23:59:59.999Z");
      expect(p.horodatageRequete).toBe(new Date(T0).toISOString());
    }
  });

  it("plateforme unique, fiabilite primaire, usage citable", async () => {
    stubReponses([{ corps: [BOUGIE_REELLE] }]);
    const r = await binance().releve(BITCOIN, MINUIT);
    expect(r.points[0]).toMatchObject({
      source: "Binance",
      fiabilite: "primaire",
      usage: "citable",
      perimetre: { type: "plateforme-unique", plateforme: "Binance" },
    });
    expect(r.points[0]?.reserves.join(" ")).toMatch(/pas le dollar/);
  });
});

describe("Binance — schema modifie ou donnee aberrante : echec bruyant", () => {
  it("refuse une bougie qui n'a plus la forme d'un tableau de 12 champs", async () => {
    stubReponses([{ corps: [{ open: 1, close: 2 }] }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/schema de reponse modifie/);
  });

  it("refuse un prix qui n'est plus une chaine numerique", async () => {
    const casse = [...BOUGIE_REELLE];
    casse[4] = "N/A";
    stubReponses([{ corps: [casse] }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/schema de reponse modifie/);
  });

  it("dit clairement qu'aucune bougie n'a ete rendue", async () => {
    stubReponses([{ corps: [] }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/aucune bougie/);
  });

  it("refuse la bougie d'une autre journee que celle demandee", async () => {
    const decalee = [...BOUGIE_REELLE];
    decalee[0] = 1788998400000 - 86_400_000;
    stubReponses([{ corps: [decalee] }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/inattendue/);
  });

  it("refuse une bougie incoherente", async () => {
    const absurde = [...BOUGIE_REELLE];
    absurde[2] = "70000.00"; // plus haut sous le plus bas
    stubReponses([{ corps: [absurde] }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/incoherente/);
  });

  it("remonte le motif de Binance sur un symbole inconnu, sans reessayer", async () => {
    const appels = stubReponses([{ status: 400, corps: { code: -1121, msg: "Invalid symbol." } }]);
    await expect(binance().releve(BITCOIN, MINUIT)).rejects.toThrow(/Invalid symbol/);
    expect(appels).toHaveLength(1);
  });
});

describe("Binance — sonde de sante", () => {
  it("rend ok quand le ping repond", async () => {
    stubReponses([{ corps: {} }]);
    expect(await binance().sante()).toMatchObject({ ok: true });
  });

  it("rend le motif quand le service est indisponible", async () => {
    stubReponses([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const etat = await binance().sante();
    expect(etat.ok).toBe(false);
    expect(etat.detail).toMatch(/indisponible/);
  });
});
