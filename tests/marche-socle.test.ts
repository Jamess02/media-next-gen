/**
 * Socle des donnees de marche : instruments et garde-fous.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Les garde-fous sont appliques par le PONT vers la passerelle, a chaque point
 * de chaque connecteur : une garantie qu'un connecteur pourrait oublier n'en
 * serait pas une. Ils refusent ce qu'un chiffre de marche ne peut pas etre —
 * absent, negatif, date du futur, perime — AVANT qu'il n'atteigne un prompt.
 */

import { describe, expect, it } from "vitest";

import { EMETTEURS_YAHOO } from "../src/protocol/sources-de-marche.js";
import { verifierBougie, verifierPoint } from "../src/marche/garde-fous.js";
import { INSTRUMENTS, instrumentsPourSujet } from "../src/marche/instruments.js";
import type { PointDeMarche } from "../src/marche/types.js";

const JOUR = 86_400_000;
const MAINTENANT = new Date("2026-09-11T08:00:05.000Z");

const point = (o: Partial<PointDeMarche> = {}): PointDeMarche => ({
  instrument: "BTC/USDT",
  mesure: "cloture de la journee UTC du 2026-09-10",
  nature: "prix",
  valeur: 76568.72,
  unite: "USDT",
  horodatageDonnee: "2026-09-10T23:59:59.999Z",
  horodatageRequete: "2026-09-11T08:00:00.000Z",
  source: "Binance",
  url: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT",
  fiabilite: "primaire",
  perimetre: { type: "plateforme-unique", plateforme: "Binance" },
  usage: "citable",
  reserves: [],
  ...o,
});

/* -------------------------------------------------------------------------
 * Instruments : quel sujet appelle quelle donnee
 * ---------------------------------------------------------------------- */

describe("instruments — un sujet n'appelle que les donnees qui le concernent", () => {
  const ids = (sujet: string) => instrumentsPourSujet(sujet).map((i) => i.id);

  it("reconnait le bitcoin, avec ou sans majuscule ni accent", () => {
    expect(ids("Le Bitcoin face aux taux")).toContain("bitcoin");
    expect(ids("BTC et regulation")).toContain("bitcoin");
  });

  it("reconnait l'ether", () => {
    expect(ids("Ethereum apres la mise a jour")).toContain("ether");
  });

  it("un sujet crypto generique appelle le bitcoin ET l'ether", () => {
    expect(ids("cryptomonnaies et sanctions")).toEqual(expect.arrayContaining(["bitcoin", "ether"]));
    expect(ids("les actifs numeriques en Europe")).toEqual(expect.arrayContaining(["bitcoin", "ether"]));
  });

  it("reconnait le CAC 40 et le petrole, accents compris", () => {
    expect(ids("Le CAC 40 recule")).toContain("cac40");
    expect(ids("Le prix du pétrole et l'OPEP")).toEqual(expect.arrayContaining(["brent", "wti"]));
  });

  it("reconnait l'or sans confondre la conjonction « or »", () => {
    expect(ids("Le cours de l'or au plus haut")).toContain("or");
    expect(ids("Les réserves d'or des banques centrales")).toContain("or");
    expect(ids("Or, la croissance ralentit")).not.toContain("or");
    expect(ids("L'ordre mondial et le commerce")).not.toContain("or");
  });

  it("un sujet sans rapport n'appelle AUCUNE donnee de marche", () => {
    expect(ids("inflation annuelle en zone euro")).toEqual([]);
    expect(ids("seismes de magnitude 6 en septembre")).toEqual([]);
  });

  it("chaque instrument Yahoo a son emetteur d'origine declare", () => {
    // Sans lui, le fact-checker ne pourrait pas dire QUI citer a la place.
    for (const i of INSTRUMENTS) {
      if (i.yahoo === undefined) continue;
      expect(EMETTEURS_YAHOO[i.yahoo.symbole], i.id).toBeDefined();
    }
  });

  it("chaque instrument est servi par au moins un connecteur", () => {
    for (const i of INSTRUMENTS) {
      expect(i.binance ?? i.coingecko ?? i.yahoo, i.id).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------
 * Garde-fous : ce qu'un chiffre de marche ne peut pas etre
 * ---------------------------------------------------------------------- */

describe("garde-fous — donnees aberrantes refusees, avec leur motif", () => {
  it("accepte un point sain", () => {
    expect(verifierPoint(point(), MAINTENANT)).toBeNull();
  });

  it("refuse une valeur nulle — le cas MESURE du Nikkei en seance", () => {
    // Yahoo a rendu `close: null` pour la seance du Nikkei en cours le
    // 2026-09-11. Une conversion naive en ferait 0, soit un krach fabrique.
    const v = verifierPoint(point({ valeur: null as unknown as number }), MAINTENANT);
    expect(v).toMatch(/valeur absente/);
  });

  it("refuse NaN et l'infini", () => {
    expect(verifierPoint(point({ valeur: Number.NaN }), MAINTENANT)).toMatch(/valeur absente/);
    expect(verifierPoint(point({ valeur: Number.POSITIVE_INFINITY }), MAINTENANT)).toMatch(
      /valeur absente/,
    );
  });

  it("refuse un prix negatif", () => {
    expect(verifierPoint(point({ valeur: -5 }), MAINTENANT)).toMatch(/negati/);
  });

  it("refuse un prix nul, qui n'existe pas sur un marche actif", () => {
    expect(verifierPoint(point({ valeur: 0 }), MAINTENANT)).toMatch(/nul/);
  });

  it("accepte un volume nul, refuse un volume negatif", () => {
    expect(verifierPoint(point({ nature: "volume", valeur: 0 }), MAINTENANT)).toBeNull();
    expect(verifierPoint(point({ nature: "volume", valeur: -1 }), MAINTENANT)).toMatch(/negati/);
  });

  it("refuse une donnee datee du futur", () => {
    const v = verifierPoint(point({ horodatageDonnee: "2026-09-12T00:00:00.000Z" }), MAINTENANT);
    expect(v).toMatch(/futur/);
  });

  it("refuse une donnee plus recente que la requete qui l'a obtenue", () => {
    // Impossible par construction : c'est le signe d'une horloge fausse, d'un
    // cache altere, ou d'un fournisseur qui date mal ses donnees.
    const v = verifierPoint(
      point({
        horodatageRequete: "2026-09-11T07:00:00.000Z",
        horodatageDonnee: "2026-09-11T07:30:00.000Z",
      }),
      MAINTENANT,
    );
    expect(v).toMatch(/posterieure a la requete/);
  });

  it("tolere un decalage d'horloge de quelques minutes", () => {
    const v = verifierPoint(point({ horodatageDonnee: "2026-09-11T08:02:00.000Z", horodatageRequete: "2026-09-11T08:00:00.000Z" }), MAINTENANT);
    expect(v).toBeNull();
  });

  it("refuse un horodatage illisible", () => {
    expect(verifierPoint(point({ horodatageDonnee: "hier" }), MAINTENANT)).toMatch(/illisible/);
  });

  it("refuse une donnee perimee au-dela de l'age maximal", () => {
    const v = verifierPoint(
      point({ horodatageDonnee: new Date(MAINTENANT.getTime() - 5 * JOUR).toISOString() }),
      MAINTENANT,
      { ageMaxMs: 2 * JOUR },
    );
    expect(v).toMatch(/perime/);
  });
});

describe("garde-fous — coherence d'une bougie", () => {
  it("accepte une bougie coherente", () => {
    expect(verifierBougie({ ouverture: 10, haut: 12, bas: 9, cloture: 11 })).toBeNull();
  });

  it("refuse un plus haut sous le plus bas", () => {
    expect(verifierBougie({ ouverture: 10, haut: 8, bas: 9, cloture: 8.5 })).toMatch(/incoherente/);
  });

  it("refuse une cloture hors de la fourchette du jour", () => {
    expect(verifierBougie({ ouverture: 10, haut: 12, bas: 9, cloture: 13 })).toMatch(/incoherente/);
  });
});
