/**
 * Donnees de marche — ce que le gate exige avant publication.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Trois sources, trois statuts, decides par l'editeur le 2026-09-11 :
 *
 *  - Binance : tier 1 pour SES PROPRES donnees, mais une plateforme parmi
 *    d'autres. Son prix n'est pas « le prix du bitcoin » : il se dit « sur
 *    Binance », et il est cote en USDT, pas en dollars.
 *  - CoinGecko : tier 2, un agregat multi-plateformes. La valeur depend de sa
 *    methodologie, et le plan Demo EXIGE l'attribution pres de la donnee.
 *  - Yahoo Finance : un signal de pre-verification. Jamais cite : la source
 *    citee est l'emetteur d'origine (Euronext pour le CAC 40...).
 *
 * Aucune de ces exigences n'est laissee a un prompt. Une consigne se suit ou
 * s'oublie ; ces regles bloquent.
 */

import { describe, expect, it } from "vitest";

import { emetteurAttendu, sourceDeMarche } from "../src/protocol/sources-de-marche.js";
import { runEditorialGate, type Violation } from "../src/protocol/rules.js";
import type { Claim } from "../src/protocol/schema.js";
import { classifySource } from "../src/sources/registry.js";
import { PROSE_MINIMALE, article, claim } from "./helpers.js";

const BINANCE =
  "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=1788998400000&endTime=1789084799999";
const COINGECKO =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=1789084200&to=1789085400";
const YAHOO =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EFCHI?period1=1788480000&period2=1789084800&interval=1d";

const ref = (url: string, tier: 1 | 2 | 3) => ({
  url,
  tier,
  date_observed: "2026-09-11T08:00:00Z",
  date_published: "2026-09-10T23:59:59.999Z",
});

/** Claim adossee a une source de marche, texte fourni par le test. */
function claimMarche(texte: string, sources: Claim["sources"], figure?: Claim["figure"]): Claim {
  return claim({
    id: "c1",
    text: texte,
    type: "fait",
    evidence_level: 3,
    sources,
    ...(figure === undefined ? {} : { figure }),
  });
}

/** Corps redige dont UN paragraphe porte la reference, avec le texte fourni. */
const corps = (paragraphe: string): string => `${paragraphe}\n${PROSE_MINIMALE}`;

const regles = (violations: readonly Violation[], rule: string): Violation[] =>
  violations.filter((v) => v.rule === rule);

/* -------------------------------------------------------------------------
 * Registre : tiers decides par l'editeur
 * ---------------------------------------------------------------------- */

describe("registre — tiers des sources de marche", () => {
  it("Binance est tier 1 pour ses propres donnees (decision de l'editeur)", () => {
    expect(classifySource(BINANCE)).toMatchObject({ tier: 1, registered: true });
  });

  it("CoinGecko est tier 2 : donnee publique agregee et sourcee", () => {
    expect(classifySource(COINGECKO)).toMatchObject({ tier: 2, registered: true });
  });

  it("Yahoo Finance est tier 3 : il ne peut fonder aucun fait", () => {
    expect(classifySource(YAHOO)).toMatchObject({ tier: 3, registered: true });
  });

  it("un autre domaine de Binance n'herite PAS du tier 1", () => {
    // Le tier 1 couvre les donnees de marche publiques, pas les billets de
    // blog ou les annonces d'une plateforme qui commente son propre marche.
    expect(classifySource("https://www.binance.com/fr/blog/markets/x").tier).toBe(3);
  });
});

/* -------------------------------------------------------------------------
 * Perimetre et usage, derives du domaine comme le tier
 * ---------------------------------------------------------------------- */

describe("perimetre et usage — derives du domaine, jamais declares", () => {
  it("Binance : plateforme unique, citable, cotee en USDT", () => {
    expect(sourceDeMarche(BINANCE)).toMatchObject({
      nom: "Binance",
      perimetre: "plateforme-unique",
      usage: "citable",
      cotation: "USDT",
    });
  });

  it("CoinGecko : agregat, citable", () => {
    expect(sourceDeMarche(COINGECKO)).toMatchObject({
      nom: "CoinGecko",
      perimetre: "agrege",
      usage: "citable",
    });
  });

  it("Yahoo Finance : signal, jamais citable — sur ses deux hotes", () => {
    expect(sourceDeMarche(YAHOO)?.usage).toBe("signal");
    expect(sourceDeMarche(YAHOO.replace("query1", "query2"))?.usage).toBe("signal");
  });

  it("une source hors marche n'a pas de perimetre de marche", () => {
    expect(sourceDeMarche("https://fred.stlouisfed.org/series/WALCL")).toBeNull();
    expect(sourceDeMarche("pas une url")).toBeNull();
  });

  it("rend l'emetteur d'origine qu'un signal Yahoo designe", () => {
    expect(emetteurAttendu(YAHOO)).toMatchObject({ nom: "Euronext", domaine: "euronext.com" });
  });

  it("le « Brent » de Yahoo designe le NYMEX, pas le Brent de reference ICE", () => {
    // MESURE du 2026-09-11 : BZ=F rend exchangeName "NYM" et le libelle
    // « Brent Crude Oil Last Day Financial Futures ». Renvoyer le lecteur a ICE
    // lui ferait comparer deux contrats differents.
    const brent = emetteurAttendu(
      "https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?period1=1&period2=2&interval=1d",
    );
    expect(brent?.nom).toMatch(/NYMEX/);
  });
});

/* -------------------------------------------------------------------------
 * PLATEFORME_NON_NOMMEE
 * ---------------------------------------------------------------------- */

describe("PLATEFORME_NON_NOMMEE — une donnee Binance se dit « sur Binance »", () => {
  it("bloque une claim adossee a Binance dont le texte ne nomme pas Binance", () => {
    const c = claimMarche("Le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.", [
      ref(BINANCE, 1),
    ]);
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Le bitcoin a recule [[c1]].") })).violations,
      "PLATEFORME_NON_NOMMEE",
    );
    expect(v.some((x) => x.path === "claims[0].text")).toBe(true);
    expect(v[0]?.severity).toBe("blocking");
    expect(v[0]?.message).toMatch(/sur Binance/);
  });

  it("laisse passer la claim ET le paragraphe qui nomment Binance", () => {
    const c = claimMarche(
      "Sur Binance, le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.",
      [ref(BINANCE, 1)],
    );
    const v = runEditorialGate(
      article({
        claims: [c],
        body: corps("Sur Binance, premiere plateforme par les volumes, le bitcoin a recule [[c1]]."),
      }),
    ).violations;
    expect(regles(v, "PLATEFORME_NON_NOMMEE")).toEqual([]);
  });

  it("bloque le paragraphe du CORPS qui reference la claim sans nommer Binance", () => {
    // C'est le corps que le lecteur lit en continu : une claim correcte dans la
    // fiche de preuve ne rattrape pas une phrase qui parle du « prix du
    // bitcoin » tout court.
    const c = claimMarche(
      "Sur Binance, le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.",
      [ref(BINANCE, 1)],
    );
    const v = regles(
      runEditorialGate(
        article({ claims: [c], body: corps("Le prix du bitcoin a recule en fin de journee [[c1]].") }),
      ).violations,
      "PLATEFORME_NON_NOMMEE",
    );
    expect(v.map((x) => x.path)).toEqual(["body"]);
  });

  it("accepte que la plateforme soit nommee ailleurs dans le MEME paragraphe", () => {
    const c = claimMarche(
      "Sur Binance, le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.",
      [ref(BINANCE, 1)],
    );
    const v = runEditorialGate(
      article({
        claims: [c],
        body: corps(
          "Les chiffres qui suivent sont ceux de Binance, et d'elle seule. Le bitcoin y a cloture en baisse [[c1]].",
        ),
      }),
    ).violations;
    expect(regles(v, "PLATEFORME_NON_NOMMEE")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * AGREGAT_NON_ATTRIBUE
 * ---------------------------------------------------------------------- */

describe("AGREGAT_NON_ATTRIBUE — un agregat CoinGecko se dit « selon CoinGecko »", () => {
  it("bloque une claim CoinGecko qui n'attribue pas la donnee", () => {
    const c = claimMarche("Le bitcoin valait 76 555 dollars le 11 septembre 2026 a minuit UTC.", [
      ref(COINGECKO, 2),
    ]);
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Selon CoinGecko, le prix a recule [[c1]].") }))
        .violations,
      "AGREGAT_NON_ATTRIBUE",
    );
    expect(v.map((x) => x.path)).toEqual(["claims[0].text"]);
    expect(v[0]?.message).toMatch(/selon CoinGecko/);
  });

  it("laisse passer une claim et un corps qui attribuent a CoinGecko", () => {
    const c = claimMarche(
      "Selon CoinGecko, le bitcoin valait 76 555 dollars le 11 septembre 2026 a minuit UTC.",
      [ref(COINGECKO, 2)],
    );
    const v = runEditorialGate(
      article({ claims: [c], body: corps("Selon CoinGecko, le prix moyen a recule [[c1]].") }),
    ).violations;
    expect(regles(v, "AGREGAT_NON_ATTRIBUE")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * SOURCE_SIGNAL_CITEE
 * ---------------------------------------------------------------------- */

describe("SOURCE_SIGNAL_CITEE — Yahoo Finance ne se cite jamais", () => {
  it("bloque une claim qui cite Yahoo, et designe l'emetteur a citer", () => {
    const c = claimMarche("Le CAC 40 a cloture a 8 116,76 points le 10 septembre 2026.", [
      ref(YAHOO, 3),
    ]);
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Le CAC 40 a recule [[c1]].") })).violations,
      "SOURCE_SIGNAL_CITEE",
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("blocking");
    expect(v[0]?.message).toMatch(/Euronext/);
  });

  it("bloque meme quand une source primaire accompagne le signal", () => {
    // Le fact-checker retire le signal des citations en amont ; s'il arrive
    // jusqu'ici, c'est qu'un chemin a contourne ce retrait. Le gate le refuse.
    const c = claimMarche("Sur Binance, le bitcoin a cloture a 76 568,72 USDT.", [
      ref(BINANCE, 1),
      ref(YAHOO, 3),
    ]);
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Sur Binance, recul [[c1]].") })).violations,
      "SOURCE_SIGNAL_CITEE",
    );
    expect(v).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * USDT_PRESENTE_EN_DOLLARS
 * ---------------------------------------------------------------------- */

describe("USDT_PRESENTE_EN_DOLLARS — un stablecoin n'est pas le dollar", () => {
  const texte = "Sur Binance, le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.";

  it("bloque un chiffre structure en dollars adosse a Binance seul", () => {
    const c = claimMarche(texte, [ref(BINANCE, 1)], {
      label: "Bitcoin sur Binance",
      value: 76568.72,
      unit: "dollars",
      as_of: "2026-09-10",
    });
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Sur Binance, recul [[c1]].") })).violations,
      "USDT_PRESENTE_EN_DOLLARS",
    );
    expect(v.map((x) => x.path)).toEqual(["claims[0].figure.unit"]);
  });

  it("bloque un montant en dollars dans le texte d'une claim Binance", () => {
    const c = claimMarche("Sur Binance, le bitcoin a cloture a 76 568 $ le 10 septembre 2026.", [
      ref(BINANCE, 1),
    ]);
    const v = regles(
      runEditorialGate(article({ claims: [c], body: corps("Sur Binance, recul [[c1]].") })).violations,
      "USDT_PRESENTE_EN_DOLLARS",
    );
    expect(v).toHaveLength(1);
  });

  it("laisse passer l'USDT, ecrit comme tel", () => {
    const c = claimMarche(texte, [ref(BINANCE, 1)], {
      label: "Bitcoin sur Binance",
      value: 76568.72,
      unit: "USDT",
      as_of: "2026-09-10",
    });
    const v = runEditorialGate(
      article({ claims: [c], body: corps("Sur Binance, recul [[c1]].") }),
    ).violations;
    expect(regles(v, "USDT_PRESENTE_EN_DOLLARS")).toEqual([]);
  });

  it("laisse passer des dollars quand une source cotee en dollars est aussi citee", () => {
    const c = claimMarche(
      "Le bitcoin valait 76 555 dollars selon CoinGecko et 76 568,72 USDT sur Binance.",
      [ref(COINGECKO, 2), ref(BINANCE, 1)],
    );
    const v = runEditorialGate(
      article({ claims: [c], body: corps("Selon CoinGecko et sur Binance, recul [[c1]].") }),
    ).violations;
    expect(regles(v, "USDT_PRESENTE_EN_DOLLARS")).toEqual([]);
  });
});

describe("les sources hors marche ne sont pas concernees", () => {
  it("n'exige aucun nommage d'une claim FRED", () => {
    const v = runEditorialGate(article()).violations;
    for (const rule of [
      "PLATEFORME_NON_NOMMEE",
      "AGREGAT_NON_ATTRIBUE",
      "SOURCE_SIGNAL_CITEE",
      "USDT_PRESENTE_EN_DOLLARS",
    ]) {
      expect(regles(v, rule), rule).toEqual([]);
    }
  });
});
