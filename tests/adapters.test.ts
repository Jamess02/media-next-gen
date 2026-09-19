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

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSourceCatalogue } from "../src/sources/catalogue.js";
import { eurostatAdapter } from "../src/sources/eurostat.js";
import { fredAdapter } from "../src/sources/fred.js";
import { imfAdapter } from "../src/sources/imf.js";
import { usgsAdapter } from "../src/sources/usgs.js";
import { classifySource } from "../src/sources/registry.js";
import type { SourceAdapter } from "../src/sources/types.js";
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
    unit: "%",
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
    // L'unite accompagne la valeur : une serie ne se branche plus sans elle,
    // depuis qu'un modele a redige "6 737 204 (unites)" faute de la trouver.
    expect(resume).toMatch(/4\.33 % au 2026-07-01/);
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

  it("ecarte Currents sans clef, et dit pourquoi (EP-003)", () => {
    const { adapters, skipped } = buildSourceCatalogue({});
    expect(adapters.some((a) => a.id.startsWith("currents:"))).toBe(false);
    expect(
      skipped.find((s) => s.id.startsWith("currents:"))?.reason,
    ).toMatch(/CURRENTS_API_KEY absente/);
  });

  it("inclut Currents quand la clef est fournie", () => {
    const { adapters, skipped } = buildSourceCatalogue({
      CURRENTS_API_KEY: "abc",
    });
    expect(adapters.some((a) => a.id.startsWith("currents:"))).toBe(true);
    expect(skipped.some((s) => s.id.startsWith("currents:"))).toBe(false);
  });

  it("traite une clef Currents vide comme absente", () => {
    const { adapters } = buildSourceCatalogue({ CURRENTS_API_KEY: "   " });
    expect(adapters.some((a) => a.id.startsWith("currents:"))).toBe(false);
  });

  it("ecarte newsdata sans clef, et dit pourquoi (EP-003)", () => {
    const { adapters, skipped } = buildSourceCatalogue({});
    expect(adapters.some((a) => a.id.startsWith("newsdata:"))).toBe(false);
    expect(
      skipped.find((s) => s.id.startsWith("newsdata:"))?.reason,
    ).toMatch(/NEWSDATA_API_KEY absente/);
  });

  it("inclut newsdata quand la clef est fournie", () => {
    const { adapters, skipped } = buildSourceCatalogue({
      NEWSDATA_API_KEY: "pub_abc",
    });
    expect(adapters.some((a) => a.id.startsWith("newsdata:"))).toBe(true);
    expect(skipped.some((s) => s.id.startsWith("newsdata:"))).toBe(false);
  });

  it("traite une clef newsdata vide comme absente", () => {
    const { adapters } = buildSourceCatalogue({ NEWSDATA_API_KEY: "   " });
    expect(adapters.some((a) => a.id.startsWith("newsdata:"))).toBe(false);
  });

  it("branche les emetteurs geopolitiques et evenementiels, sans clef", () => {
    // Un theme sans source produit un arret en collecte : les sujets de
    // geopolitique demandes le 2026-09-13 n'ont de sens que si les emetteurs
    // sont branches d'abord.
    const ids = buildSourceCatalogue({}).adapters.map((a) => a.id);
    expect(ids).toContain("onu:paix-securite");
    expect(ids).toContain("gdacs:alertes");
  });

  it("documente les flux geopolitiques ECARTES, avec leur mesure", () => {
    const { skipped } = buildSourceCatalogue({});
    const motif = (id: string) => skipped.find((s) => s.id === id)?.reason ?? "";
    // Meme piege que le flux h41 de la Fed : un flux qui repond mais dont la
    // derniere entree a 199 jours ferait porter a chaque article une mention
    // « source indisponible » trompeuse.
    expect(motif("oms:news")).toMatch(/199 jours/);
    // Refus d'un client honnete : le contourner supposerait d'usurper un
    // navigateur, ce que ce projet n'autorise pas.
    expect(motif("smithsonian:volcans")).toMatch(/403/);
    expect(motif("consilium:communiques")).toMatch(/403/);
  });

  it("branche arXiv pour la veille technologique", () => {
    expect(buildSourceCatalogue({}).adapters.map((a) => a.id)).toContain("arxiv:ia");
  });

  it("classe arXiv en TIER 3 : une prepublication n'etablit rien", () => {
    // Decision de l'editeur du 2026-09-19. arXiv est bien l'emetteur du
    // document, mais le document n'a ete relu par personne : le tier dit ici
    // ce que vaut le CONTENU pour fonder un fait, et la mention le redit.
    const c = classifySource("https://arxiv.org/abs/2609.20822v1");
    expect(c.tier).toBe(3);
    expect(c.registered, "domaine absent du registre : tier 3 par defaut").toBe(true);
    expect(c.name).toMatch(/arXiv/i);
  });

  it("accole a chaque observation la mention de PREPUBLICATION", async () => {
    // Sans elle, « des chercheurs montrent que... » se lirait comme un
    // resultat etabli, alors qu'aucun comite de lecture n'est passe.
    const arxiv = buildSourceCatalogue({}).adapters.find((a) => a.id === "arxiv:ia");
    expect(arxiv, "arXiv absent du catalogue").toBeDefined();

    stubFetch(undefined, {
      asText: `<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <title>Un travail sur les modeles de langage</title>
            <link href="https://arxiv.org/abs/2609.20822v1" rel="alternate"/>
            <published>2026-09-17T17:59:58Z</published>
            <summary>Resume du travail.</summary>
          </entry>
        </feed>`,
    });

    const r = await (arxiv as SourceAdapter).fetch({
      topic: "modeles de langage",
      since: "2026-01-01T00:00:00Z",
    });
    expect(r.observations[0]?.resume).toMatch(/prepublication/i);
    expect(r.observations[0]?.url).toBe("https://arxiv.org/abs/2609.20822v1");
  });

  /* ---- Debit et cache : la partie qui n'a AUCUN code de retour pour alerter -- */

  const FLUX_ARXIV = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Un travail sur les modeles de langage</title>
        <link href="https://arxiv.org/abs/2609.20822v1" rel="alternate"/>
        <published>2026-09-17T17:59:58Z</published>
        <summary>Resume du travail.</summary>
      </entry>
    </feed>`;

  /** Bouchon qui DATE chaque depart : c'est la mesure du test. */
  function stubQuiDate(corps: string = FLUX_ARXIV): number[] {
    const departs: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        departs.push(Date.now());
        return { ok: true, status: 200, text: async () => corps };
      }),
    );
    return departs;
  }

  // UN SEUL catalogue par test : deux constructions rendraient deux espaceurs
  // distincts, et le test du debit partage ne prouverait plus rien.
  let catalogueDuTest: ReturnType<typeof buildSourceCatalogue> | null = null;

  const parIdentifiant = (id: string): SourceAdapter => {
    catalogueDuTest ??= buildSourceCatalogue({});
    const a = catalogueDuTest.adapters.find((x) => x.id === id);
    if (a === undefined) throw new Error(id + " absent du catalogue");
    return a;
  };

  const arxivDeLaSuite = (): SourceAdapter => parIdentifiant("arxiv:ia");

  let cacheTmp: string;
  let cacheAvant: string | undefined;

  beforeEach(async () => {
    // Dossier NEUF a chaque test. Sans lui, la deuxieme execution de la suite
    // lirait le cache laisse par la premiere : zero requete, et le test du
    // debit ne mesurerait plus rien tout en restant vert.
    catalogueDuTest = null;
    cacheTmp = await mkdtemp(join(tmpdir(), "mng-arxiv-"));
    cacheAvant = process.env["SOURCES_CACHE_DIR"];
    // Lue a la CONSTRUCTION du catalogue : la poser ici suffit, et chaque test
    // repart d"un cache vide sans dependre de ce que le precedent a ecrit.
    process.env["SOURCES_CACHE_DIR"] = cacheTmp;
  });

  afterEach(async () => {
    if (cacheAvant === undefined) delete process.env["SOURCES_CACHE_DIR"];
    else process.env["SOURCES_CACHE_DIR"] = cacheAvant;
    await rm(cacheTmp, { recursive: true, force: true });
  });

  it("ESPACE de 3 s deux collectes arXiv concurrentes (conditions d'usage)", async () => {
    // arXiv formule sa limite en conditions d'usage, pas en code de retour :
    // « no more than one request every three seconds ». Aucun 429 ne viendra
    // nous avertir qu'on la franchit — on serait simplement en faute.
    //
    // CONCURRENTES, et c'est tout le sujet : une vague produit six articles et
    // la passerelle interroge les sources de chacun. Le cache n'aide pas ici,
    // puisque les six partent avant que la premiere reponse ne soit revenue.
    //
    // CE TEST ATTEND VRAIMENT TROIS SECONDES. Les horloges feintes de vitest
    // suspendent la chaine (essaye : expiration a 5 s sans rien mesurer), et
    // injecter une horloge obligerait a construire l'adaptateur a la main —
    // donc a ne plus prouver ce qui compte ici : que le CATALOGUE a bien pose
    // l'intervalle sur arXiv. Trois secondes une fois, contre le risque
    // d'etre en faute vis-a-vis d'une source, est un prix honnete.
    const departs = stubQuiDate();
    const arxiv = arxivDeLaSuite();
    await Promise.all([arxiv.fetch(QUERY), arxiv.fetch(QUERY)]);

    expect(departs.length, "les deux collectes n'ont pas atteint le reseau").toBe(2);
    expect((departs[1] ?? 0) - (departs[0] ?? 0)).toBeGreaterThanOrEqual(3_000);
  });

  it("MET EN CACHE le flux arXiv : la seconde collecte ne repart pas", async () => {
    // Le flux ne change qu'une fois par jour. Redemander a chaque article
    // d'une meme vague consommerait le debit sans rien apprendre.
    const departs = stubQuiDate();
    const arxiv = arxivDeLaSuite();

    await arxiv.fetch(QUERY);
    await arxiv.fetch(QUERY);

    expect(departs.length, "le flux est redemande a chaque collecte").toBe(1);
  });

  it("ECRIT dans la racine imposee, jamais dans le cache du depot", async () => {
    // Le defaut qui a motive SOURCES_CACHE_DIR, constate le 2026-09-19 : la
    // suite deposait son flux BOUCHONNE dans .cache/sources, ou le vrai
    // pipeline l'aurait servi pendant une heure comme s'il venait d'arXiv. Un
    // article aurait cite une prepublication fabriquee par un test.
    stubQuiDate();
    await arxivDeLaSuite().fetch(QUERY);

    const ecrit = await readdir(cacheTmp);
    expect(ecrit.length, "rien n'a ete ecrit dans la racine imposee").toBeGreaterThan(0);
  });

  /* ---- GitHub : la publication d'une version, pas ce qu'elle promet -------- */

  const FLUX_GITHUB = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Release 5.17.0</title>
        <link rel="alternate" href="https://github.com/huggingface/transformers/releases/tag/v5.17.0"/>
        <updated>2026-09-10T12:03:18Z</updated>
        <content type="html">&lt;p&gt;Prise en charge de deux architectures.&lt;/p&gt;</content>
      </entry>
    </feed>`;

  const DEPOTS_BRANCHES = ["github:transformers", "github:ollama", "github:openssl"];

  it("branche les trois depots dont le flux porte de VRAIES versions", () => {
    const ids = buildSourceCatalogue({}).adapters.map((a) => a.id);
    for (const id of DEPOTS_BRANCHES) expect(ids).toContain(id);
  });

  it("ECARTE les depots dont le flux n'est que du bruit machine, et DATE la mesure", () => {
    // MESURE du 2026-09-19. Les trois repondent HTTP 200 : les brancher sur ce
    // seul critere aurait inonde le Veilleur de faux evenements.
    //   pytorch/pytorch   : « viable/strict/1789847421 », marqueurs internes
    //                       d'integration continue, plusieurs par heure
    //   ggml-org/llama.cpp: « b11056 », numeros de compilation, plusieurs/jour
    //   vllm-project/vllm : « v0.30.0rc2 », « proto-v0.3.0 », des candidates
    const { skipped } = buildSourceCatalogue({});
    for (const id of ["github:pytorch", "github:llama-cpp", "github:vllm"]) {
      const motif = skipped.find((s) => s.id === id)?.reason ?? "";
      expect(motif, `${id} ecarte sans motif`).toMatch(/2026-09-19/);
      expect(motif.length, `${id} : motif trop court pour etre verifiable`).toBeGreaterThan(60);
    }
  });

  it("classe en TIER 2 la page de versions d'un depot VERIFIE", () => {
    // La publication d'une version est un fait a distance zero : le depot du
    // projet EST le lieu ou elle a lieu. Sans tier 1 ou 2, aucune claim ne
    // pourrait etre typee « fait » (§3), et « la version 5.17 est sortie le 10
    // septembre » — pourtant verifiable a cette adresse — deviendrait indicible.
    const c = classifySource(
      "https://github.com/huggingface/transformers/releases/tag/v5.17.0",
    );
    expect(c.tier).toBe(2);
    expect(c.registered).toBe(true);
    // Le nom affiche au lecteur est celui du PROJET : c'est lui qui publie,
    // GitHub n'est que l'hebergeur. Sans cette assertion, renommer l'entree
    // « GitHub » passait inapercu — constate par mutation.
    expect(c.name).toMatch(/transformers/i);
  });

  it("laisse TOUT LE RESTE de github.com en tier 3", () => {
    // Le point le plus important du lot. github.com heberge n'importe qui :
    // une entree de domaine au tier 2 aurait promu le README du premier venu au
    // rang de donnee publique. Seuls les chemins MESURES sont releves.
    for (const url of [
      "https://github.com/quelquun/son-depot",
      "https://github.com/quelquun/son-depot/releases/tag/v1",
      "https://github.com/huggingface/transformers/blob/main/README.md",
    ]) {
      const c = classifySource(url);
      expect(c.tier, `${url} promu a tort`).toBe(3);
      // Enregistre quand meme : sinon le lecteur voit « github.com » au lieu
      // du nom de l'editeur, et la mutation « entree retiree » passerait.
      expect(c.registered, `${url} : hote nu affiche au lecteur`).toBe(true);
    }
  });

  it("dit que la note de version est DECLAREE par l'editeur, pas auditee", async () => {
    // Le piege propre a la technologie, et celui que l'editeur a nomme : la
    // date et le numero sont verifiables ; « deux fois plus rapide » ne l'est
    // pas, et sort pourtant du meme document.
    stubQuiDate(FLUX_GITHUB);
    const gh = parIdentifiant("github:transformers");
    const r = await gh.fetch({ topic: "architectures", since: "2026-01-01T00:00:00Z" });

    expect(r.observations[0]?.resume).toMatch(/declare|non audite/i);
    expect(r.observations[0]?.url).toBe(
      "https://github.com/huggingface/transformers/releases/tag/v5.17.0",
    );
  });

  it("PARTAGE un seul espaceur entre les depots : la limite est celle de l'hote", async () => {
    // Trois adaptateurs, UN serveur. Trois espaceurs prives constateraient
    // chacun « aucun appel recent » et partiraient ensemble : la limite serait
    // respectee trois fois, et franchie une.
    //
    // Ce test attend reellement (voir la note du test arXiv) : c'est le seul
    // montage qui prouve que le CATALOGUE partage l'instance.
    const departs = stubQuiDate(FLUX_GITHUB);
    const q = { topic: "versions", since: "2026-01-01T00:00:00Z" };
    await Promise.all([
      parIdentifiant("github:transformers").fetch(q),
      parIdentifiant("github:ollama").fetch(q),
    ]);

    expect(departs.length).toBe(2);
    expect((departs[1] ?? 0) - (departs[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
  });

  it("branche les sources du 2026-09-19 dont le flux repond reellement", () => {
    const ids = buildSourceCatalogue({}).adapters.map((a) => a.id);
    expect(ids).toContain("bce:blog");
    expect(ids).toContain("brecorder:latest");
  });

  it("classe la BCE en TIER 1 : sans entree au registre, elle passerait pour de la presse", () => {
    // Le domaine etait absent du registre. Un billet de la banque centrale
    // retombait donc au tier 3 par defaut, et EP-001 — la source primaire
    // passe avant la synthese de presse — ne jouait jamais en sa faveur.
    expect(classifySource("https://www.ecb.europa.eu/press/blog/html/x.en.html").tier).toBe(1);
    // Business Recorder est de la presse, et le reste : son tier ne doit pas
    // etre releve par sympathie pour la qualite du titre.
    //
    // On exige `registered`, et pas seulement le tier. Tout domaine INCONNU
    // retombe en tier 3 par defaut : l'assertion sur le seul tier passait donc
    // meme apres retrait de l'entree du registre — constate par mutation. Un
    // domaine non enregistre n'est pas « classe en presse », il est ignore, et
    // le lecteur voit alors un nom d'hote a la place du nom de l'editeur.
    const br = classifySource("https://www.brecorder.com/news/1");
    expect(br.tier).toBe(3);
    expect(br.registered).toBe(true);
    expect(br.name).toBe("Business Recorder");
  });

  it("ECARTE Oracle faute de surface machine, et DATE la mesure", () => {
    // MESURE du 2026-09-19 : investor.oracle.com refuse notre agent declare
    // (page, /rss/news-releases.xml, /rss/pressrelease.aspx), oracle.com/news/
    // et la salle de presse ne declarent aucun flux, et le seul fichier qui
    // repond est un leurre servi en text/html dont la derniere entree date de
    // 2008. Le motif doit porter ces trois faits : sans eux, quelqu'un
    // rebranchera le leurre et fera entrer des depeches vieilles de 18 ans.
    const { skipped } = buildSourceCatalogue({});
    const motif = skipped.find((s) => s.id === "oracle:investor-news")?.reason ?? "";
    expect(motif).toMatch(/403/);
    expect(motif).toMatch(/2026-09-19/);
    expect(motif).toMatch(/2008/);
  });

  it("couvre PLUSIEURS series par emetteur, pas une seule", () => {
    // USGS, FMI et Banque mondiale etaient branches, mais chacun sur une ou
    // deux series figees. Elargir leur couverture, c'est donner au pipeline de
    // quoi expliquer ce qu'un evenement COUTE — la demande de l'editeur du
    // 2026-09-13 sur les consequences et les reponses publiques.
    const ids = buildSourceCatalogue({}).adapters.map((a) => a.id);
    expect(ids).toContain("worldbank:WLD:MS.MIL.XPND.GD.ZS");
    expect(ids).toContain("worldbank:WLD:DT.ODA.ODAT.CD");
    expect(ids).toContain("imf:FRA:GGXWDG_NGDP");
    expect(ids).toContain("imf:USA:GGXWDG_NGDP");
  });

  it("refuse un filtre sismique qui echouerait presque toujours, et le mesure", () => {
    // MESURE du 2026-09-13 : magnitude >= 6 rend 10 seismes sur 30 jours, mais
    // le filtre d'alerte PAGER orange n'en rend que 6 par AN. Branche, il
    // echouerait a presque chaque collecte et ferait porter a chaque article
    // une mention « source indisponible » — le piege du flux h41 de la Fed.
    const { skipped } = buildSourceCatalogue({});
    const raison = skipped.find((s) => s.id === "usgs:alerte-pager")?.reason ?? "";
    expect(raison).toMatch(/2026-09-13/);
    expect(raison).toMatch(/par an/);
  });

  it("branche les deux flux de la SEC, sans clef", () => {
    const ids = buildSourceCatalogue({}).adapters.map((a) => a.id);
    expect(ids).toContain("sec:communiques");
    expect(ids).toContain("sec:discours");
  });

  it("ne dit plus que la SEC est inaccessible : la mesure dit l'inverse", () => {
    // Le catalogue affirmait un HTTP 403 « sans User-Agent nominatif », mesure
    // du 2026-09-02. Au 2026-09-13, TOUTES les surfaces repondent 200 au meme
    // agent honnete, EDGAR et data.sec.gov compris. Un motif d'ecart perime
    // est pire qu'absent : il fait renoncer a une source disponible.
    const { skipped } = buildSourceCatalogue({});
    for (const s of skipped.filter((x) => x.id.startsWith("sec"))) {
      // L'invariant n'est pas « ne jamais ecrire 403 » — rappeler une mesure
      // perimee est utile — mais « ne plus PRESENTER l'acces comme refuse ».
      expect(s.reason, s.id).not.toMatch(/rendent HTTP 403|403 sans|exige une adresse/);
      // Et toute raison d'ecarter la SEC doit porter la date de sa mesure :
      // c'est ce qui permet de reperer la prochaine qui se perimera.
      expect(s.reason, s.id).toMatch(/2026-09-13/);
    }
    // Ce qui manque a EDGAR n'est plus un acces, mais un CHOIX editorial :
    // quelle entreprise, quel formulaire — comme pour Comtrade.
    expect(skipped.find((s) => s.id === "sec-edgar:depots")?.reason).toMatch(
      /decision editoriale|choix editorial/i,
    );
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
