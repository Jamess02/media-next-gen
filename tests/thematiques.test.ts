/**
 * Thematique d'un article, DERIVEE des emetteurs qu'il cite.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Demande de l'editeur du 2026-09-19 : ranger les brouillons du studio par
 * thematique. Le contrat §7 n'en porte aucune, et les 41 brouillons deja
 * produits n'en porteront jamais.
 *
 * POURQUOI LES EMETTEURS, ET NON LE TITRE. Classer d'apres les mots d'un titre
 * est une devinette, et une devinette qui se trompe range l'article sous une
 * rubrique fausse — pire qu'une absence de rangement, parce qu'une etiquette se
 * lit comme une information. Le depot applique deja ce principe aux sources :
 * le tier est DERIVE du domaine, jamais declare.
 *
 * CE QUE CETTE TAXONOMIE N'EST PAS. Ce ne sont PAS les `domaine` des themes de
 * vague, et la tentation etait forte de les reutiliser. Verification faite, ils
 * classent par ANGLE EDITORIAL et non par emetteur : le domaine « humanitaire »
 * vise GDACS et l'ONU, et le domaine « institutions » vise « les communiques
 * recents des banques centrales : Reserve federale et Banque du Japon ». Les
 * memes emetteurs servent plusieurs domaines. Un rangement derive des sources
 * ne peut donc pas reproduire cet angle, et pretendre le contraire ferait dire
 * a l'etiquette ce qu'elle ne sait pas.
 *
 * MESURE du 2026-09-19 : sur les 92 sources citees par les 41 brouillons, tous
 * les emetteurs sont connus. « non classe » reste donc l'exception.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_VEILLEUR } from "../src/agents/veilleur.js";

import {
  NON_CLASSE,
  THEMATIQUES,
  thematiqueDeLArticle,
  thematiqueDesSources,
} from "../src/sources/thematiques.js";

const u = {
  usgs: "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson",
  gdacs: "https://www.gdacs.org/xml/rss.xml",
  fred: "https://fred.stlouisfed.org/series/FEDFUNDS",
  fed: "https://www.federalreserve.gov/feeds/press_all.xml",
  bce: "https://www.ecb.europa.eu/press/blog/html/x.en.html",
  boj: "https://www.boj.or.jp/en/rss/whatsnew.xml",
  banqueMondiale: "https://data.worldbank.org/indicator/NY.GDP.MKTP.CD",
  fmi: "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/FRA",
  eurostat: "https://ec.europa.eu/eurostat/prc_hicp_manr",
  comtrade: "https://comtrade.un.org/data/ZMB/202607",
  ofac: "https://ofac.treasury.gov/recent-actions",
  onu: "https://news.un.org/feed/subscribe/fr/news/topic/peace-and-security/feed/rss.xml",
  reliefweb: "https://reliefweb.int/updates/rss.xml",
  sec: "https://www.sec.gov/news/pressreleases.rss",
  binance: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT",
  presse: "https://www.brecorder.com/news/40440238/spi-based-inflation",
  inconnu: "https://exemple.test/quelque-chose",
};

describe("thematique derivee des emetteurs", () => {
  it("range les releves sismiques et les alertes de catastrophe", () => {
    expect(thematiqueDesSources([u.usgs])).toBe("risques naturels");
    expect(thematiqueDesSources([u.gdacs])).toBe("risques naturels");
  });

  it("range les banques centrales, BCE nouvellement branchee comprise", () => {
    for (const url of [u.fred, u.fed, u.bce, u.boj]) {
      expect(thematiqueDesSources([url]), url).toBe("banques centrales");
    }
  });

  it("range les series economiques internationales", () => {
    for (const url of [u.banqueMondiale, u.fmi, u.eurostat, u.comtrade]) {
      expect(thematiqueDesSources([url]), url).toBe("macroeconomie");
    }
  });

  it("range sanctions et Nations unies en geopolitique", () => {
    expect(thematiqueDesSources([u.ofac])).toBe("geopolitique");
    expect(thematiqueDesSources([u.onu])).toBe("geopolitique");
  });

  it("distingue l'humanitaire de la geopolitique, meme au sein de l'ONU", () => {
    // ReliefWeb et news.un.org sont tous deux onusiens : c'est l'EMETTEUR qui
    // tranche, pas l'organisation qui le chapeaute.
    expect(thematiqueDesSources([u.reliefweb])).toBe("humanitaire");
  });

  it("range le regulateur des marches et les donnees de marche", () => {
    expect(thematiqueDesSources([u.sec])).toBe("regulation");
    expect(thematiqueDesSources([u.binance])).toBe("marches");
  });
});

describe("plusieurs emetteurs", () => {
  it("retient la thematique MAJORITAIRE", () => {
    expect(thematiqueDesSources([u.banqueMondiale, u.fmi, u.fred])).toBe("macroeconomie");
  });

  it("tranche une egalite de facon REPRODUCTIBLE", () => {
    // Deux lectures du meme article doivent donner le meme rangement, sinon
    // l'interface se reorganise d'un rafraichissement a l'autre. L'ordre des
    // urls ne doit donc rien changer.
    const a = thematiqueDesSources([u.fred, u.banqueMondiale]);
    const b = thematiqueDesSources([u.banqueMondiale, u.fred]);
    expect(a).toBe(b);
    expect(THEMATIQUES).toContain(a);
  });

  it("compte chaque emetteur UNE fois, quel que soit le nombre d'urls", () => {
    // Trois releves FRED dans un article ne font pas de lui trois fois un
    // article de banque centrale : sans cela, une serie longue ecraserait
    // toujours le reste.
    expect(
      thematiqueDesSources([u.fred, u.fred, u.fred, u.banqueMondiale, u.fmi]),
    ).toBe("macroeconomie");
  });

  it("ignore la presse : elle dit le SUPPORT, pas le sujet", () => {
    expect(thematiqueDesSources([u.presse, u.usgs])).toBe("risques naturels");
  });
});

describe("les enquetes sont a part", () => {
  it("range une ENQUETE sous investigateur, quels que soient ses emetteurs", () => {
    // Demande de l'editeur du 2026-09-19. « investigateur » n'est pas un
    // emetteur mais un FORMAT : une enquete sur la Fed cite FRED et tomberait
    // sinon dans « banques centrales », noyee parmi les breves.
    //
    // Rien n'est devine pour autant : le mode est porte par le contrat §7.
    expect(thematiqueDeLArticle("enquete", [u.fred])).toBe("investigateur");
    expect(thematiqueDeLArticle("enquete", [u.usgs, u.ofac])).toBe("investigateur");
  });

  it("une enquete SANS aucune source reste une enquete", () => {
    expect(thematiqueDeLArticle("enquete", [])).toBe("investigateur");
  });

  it("les autres modes suivent leurs EMETTEURS", () => {
    expect(thematiqueDeLArticle("constat", [u.fred])).toBe("banques centrales");
    expect(thematiqueDeLArticle("prospectif", [u.usgs])).toBe("risques naturels");
  });

  it("un article SANS mode suit ses emetteurs", () => {
    // Trente et un brouillons sont anterieurs a l'introduction du champ : ils
    // n'en portent pas, et doivent continuer d'etre ranges.
    expect(thematiqueDeLArticle(undefined, [u.banqueMondiale])).toBe("macroeconomie");
  });

  it("compte investigateur parmi les thematiques", () => {
    expect(THEMATIQUES).toContain("investigateur");
  });
});

describe("ce qui n'est pas classable", () => {
  it("rend NON_CLASSE sans aucune source", () => {
    expect(thematiqueDesSources([])).toBe(NON_CLASSE);
  });

  it("rend NON_CLASSE quand aucun emetteur n'est reconnu", () => {
    // Mieux vaut un article visiblement non range qu'un article range sous une
    // rubrique fausse : la seconde se lit comme une information.
    expect(thematiqueDesSources([u.inconnu])).toBe(NON_CLASSE);
  });

  it("rend NON_CLASSE quand seule de la presse est citee", () => {
    expect(thematiqueDesSources([u.presse])).toBe(NON_CLASSE);
  });

  it("ne compte PAS NON_CLASSE parmi les thematiques", () => {
    expect(THEMATIQUES).not.toContain(NON_CLASSE);
  });

  it("ignore une url inanalysable sans faire tomber le classement", () => {
    expect(thematiqueDesSources(["pas une url", u.usgs])).toBe("risques naturels");
  });
});

describe("technologie", () => {
  it("range les prepublications, les versions et la diffusion des modeles", () => {
    expect(thematiqueDesSources(["https://arxiv.org/abs/2609.20822v1"])).toBe("technologie");
    expect(
      thematiqueDesSources(["https://github.com/openssl/openssl/releases/tag/x"]),
    ).toBe("technologie");
    expect(
      thematiqueDesSources(["https://huggingface.co/api/models/Qwen/Qwen3.8-27B"]),
    ).toBe("technologie");
  });

  it("ne DEPLACE aucun article deja range : la technologie perd les egalites", () => {
    // « Ne modifie pas les thematiques existantes » (editeur, 2026-09-19). Un
    // article qui cite un emetteur deja range ET un emetteur technologique
    // doit rester la ou il etait : d'ou la place de « technologie » en fin de
    // liste, l'ordre tranchant les egalites.
    expect(
      thematiqueDesSources([
        "https://www.sec.gov/cgi-bin/browse-edgar",
        "https://github.com/openssl/openssl/releases/tag/x",
      ]),
    ).toBe("regulation");
    expect(
      thematiqueDesSources([
        "https://fred.stlouisfed.org/series/TEST",
        "https://arxiv.org/abs/2609.20822v1",
      ]),
    ).toBe("banques centrales");
  });

  it("l'emporte quand la technologie est majoritaire", () => {
    expect(
      thematiqueDesSources([
        "https://arxiv.org/abs/1",
        "https://huggingface.co/api/models/a/b",
        "https://www.sec.gov/x",
      ]),
    ).toBe("technologie");
  });
});

describe("les consignes nomment les types REELLEMENT produits", () => {
  it("le Veilleur connait les trois types technologiques du catalogue", () => {
    // COUPLAGE REEL, et c'est ce qui rend ce test utile la ou tester une
    // formulation ne le serait pas : le `type` d'une observation est ecrit
    // dans le catalogue et relu dans la consigne. Renommer l'un sans l'autre
    // laisserait une consigne qui ne s'applique plus a rien, sans que rien
    // n'echoue.
    for (const type of ["prepublication", "version-publiee", "diffusion-modele"]) {
      expect(INSTRUCTIONS_VEILLEUR, `type absent des consignes : ${type}`).toContain(type);
    }
  });

  it("chaque type nomme dans la consigne est produit par un adaptateur", () => {
    const source = readFileSync(
      new URL("../src/sources/catalogue.ts", import.meta.url),
      "utf8",
    );
    for (const type of ["prepublication", "version-publiee"]) {
      expect(source, `type sans adaptateur : ${type}`).toContain(`type: "${type}"`);
    }
    const hf = readFileSync(
      new URL("../src/sources/huggingface.ts", import.meta.url),
      "utf8",
    );
    expect(hf).toContain('type: "diffusion-modele"');
  });
});
