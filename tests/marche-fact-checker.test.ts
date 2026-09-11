/**
 * Livrable 3 — le fact-checker traite differemment primaire, secondaire et
 * signal.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Trois statuts, et trois traitements :
 *
 *  - PRIMAIRE (tier 1-2) : verification normale ;
 *  - SECONDAIRE (tier 3-4) : la remontee a la source primaire est requise pour
 *    un fait — `FACT_NEEDS_PRIMARY_SOURCE` le bloque deja au gate ; le modele,
 *    lui, doit le SAVOIR des l'entree, d'ou la nature de chaque source jointe
 *    a sa consigne ;
 *  - SIGNAL (Yahoo) : jamais une preuve. Retire des citations d'une claim qui
 *    a une autre source ; claim rejetee d'office si elle ne reposait que sur
 *    lui — AVANT l'appel au modele, qui n'a pas a payer pour juger une claim
 *    deja disqualifiee.
 *
 * Tout ce qui est deterministe ici est du code, pas une consigne.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalysteOutput } from "../src/agents/analyste.js";
import { Editeur } from "../src/agents/editeur.js";
import { appliquerUsagesDesSources, natureDesSources } from "../src/agents/fact-checker.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { MOCK_RESPONDERS } from "../src/fixtures/mock-scenario.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import { MOCK_ADAPTERS } from "../src/sources/mock-sources.js";
import type { SourceAdapter } from "../src/sources/types.js";

const YAHOO =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EFCHI?period1=1788480000&period2=1789084800&interval=1d";
const BINANCE =
  "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=1788998400000&endTime=1789084799999";
const COINGECKO =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=1789084200&to=1789085400";
const FRED = "https://fred.stlouisfed.org/series/ZEMBLAPOLRATE";
const PRESSE = "https://gnews.io/articles/zembla-monetary-tightening";

type Candidate = AnalysteOutput["candidates"][number];

const src = (url: string, tier: 1 | 2 | 3) => ({
  url,
  tier,
  date_observed: "2026-09-11T08:00:00Z",
  date_published: "2026-09-10T00:00:00Z",
});

const candidate = (id: string, sources: Candidate["sources"]): Candidate => ({
  id,
  text: `Texte de ${id}.`,
  type: "fait",
  proposed_evidence_level: 3,
  rationale: "test",
  sources,
});

describe("appliquerUsagesDesSources — un signal n'est jamais une preuve", () => {
  it("rejette d'office une claim adossee au seul signal, en nommant l'emetteur a citer", () => {
    const r = appliquerUsagesDesSources([candidate("c1", [src(YAHOO, 3)])]);
    expect(r.candidates).toEqual([]);
    expect(r.exclues).toHaveLength(1);
    expect(r.exclues[0]).toMatch(/^c1 : rejetee/);
    expect(r.exclues[0]).toMatch(/emetteur d'origine/);
    expect(r.exclues[0]).toMatch(/Euronext/);
  });

  it("retire le signal des citations d'une claim qui a une autre source, et le dit", () => {
    const r = appliquerUsagesDesSources([candidate("c1", [src(BINANCE, 1), src(YAHOO, 3)])]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.sources.map((s) => s.url)).toEqual([BINANCE]);
    expect(r.ajustements.join(" ")).toMatch(/c1 : Yahoo Finance retire des citations/);
    expect(r.exclues).toEqual([]);
  });

  it("ne touche pas une claim sans signal", () => {
    const c = candidate("c1", [src(FRED, 1), src(PRESSE, 3)]);
    const r = appliquerUsagesDesSources([c]);
    expect(r.candidates).toEqual([c]);
    expect(r.exclues).toEqual([]);
    expect(r.ajustements).toEqual([]);
  });
});

describe("natureDesSources — ce que le fact-checker doit savoir de chaque source", () => {
  const nature = natureDesSources([
    candidate("c1", [src(FRED, 1), src(PRESSE, 3)]),
    candidate("c2", [src(BINANCE, 1), src(COINGECKO, 2)]),
  ]);
  const de = (url: string) => nature.find((n) => n.url === url);

  it("classe tier 1-2 en primaire, sans remontee requise", () => {
    expect(de(FRED)).toMatchObject({ fiabilite: "primaire", remontee_requise: false });
    expect(de(COINGECKO)).toMatchObject({ fiabilite: "primaire", remontee_requise: false });
  });

  it("classe tier 3 en secondaire, remontee a la source primaire requise pour un fait", () => {
    expect(de(PRESSE)).toMatchObject({ fiabilite: "secondaire", remontee_requise: true });
  });

  it("porte le perimetre et la formule d'attribution d'une source de marche", () => {
    expect(de(BINANCE)).toMatchObject({ perimetre: "plateforme-unique", attribution: "sur Binance" });
    expect(de(COINGECKO)).toMatchObject({ perimetre: "agrege", attribution: "selon CoinGecko" });
  });

  it("rend chaque URL une seule fois", () => {
    const n = natureDesSources([
      candidate("c1", [src(FRED, 1)]),
      candidate("c2", [src(FRED, 1)]),
    ]);
    expect(n).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * Integration : le chemin reel du pipeline
 * ---------------------------------------------------------------------- */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marche-fc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Source simulee qui rend un signal Yahoo, comme le ferait le connecteur. */
const signalYahoo: SourceAdapter = {
  id: "yahoo:cac40",
  describes: "Signal Yahoo simule",
  fetch: async () => ({
    observations: [
      {
        source: "Yahoo Finance (signal)",
        url: YAHOO,
        date_observed: "2026-09-11T08:00:00.000Z",
        date_published: "2026-09-10T07:00:00.000Z",
        type: "signal-de-marche",
        resume: "SIGNAL — NE PAS CITER. CAC 40 : cloture 8116.76 points.",
      },
    ],
    raw: {},
    requestedUrl: YAHOO,
  }),
};

describe("pipeline — le signal est traite AVANT le jugement du modele", () => {
  it("ecarte la claim adossee au seul signal, retire le signal ailleurs, et publie le reste", async () => {
    const vusParLeFactChecker: string[] = [];
    const veilleur = MOCK_RESPONDERS["veilleur"] as MockResponder;
    const analyste = MOCK_RESPONDERS["analyste"] as MockResponder;
    const factChecker = MOCK_RESPONDERS["fact-checker"] as MockResponder;

    const responders: Record<string, MockResponder> = {
      ...MOCK_RESPONDERS,
      veilleur: (req) => {
        const r = veilleur(req) as { retained: Array<{ url: string; selection_reason: string }> };
        return {
          ...r,
          retained: [...r.retained, { url: YAHOO, selection_reason: "signal de contexte" }],
        };
      },
      analyste: (req) => {
        const r = analyste(req) as AnalysteOutput;
        const [c1, c2, c3] = r.candidates as [Candidate, Candidate, Candidate];
        return {
          ...r,
          candidates: [
            // Claim mixte : primaire + signal. Le signal doit sortir des citations.
            { ...c1, sources: [...c1.sources, src(YAHOO, 3)] },
            c2,
            c3,
            // Claim adossee au SEUL signal : rejetee d'office.
            candidate("claim-4", [src(YAHOO, 3)]),
          ],
        };
      },
      "fact-checker": (req) => {
        vusParLeFactChecker.push(req.user);
        return factChecker(req);
      },
    };

    const audit = new AuditLog({ dir: join(dir, "audit") });
    const pipeline = new EditorialPipeline({
      ctx: { llm: new MockLlmClient({ audit, responders }), audit },
      adapters: [...MOCK_ADAPTERS, signalYahoo],
      editeur: new Editeur(join(dir, "output"), new EditorialChangelog(join(dir, "c.md"))),
    });
    const result = await pipeline.run("test");

    if (result.status !== "published") {
      throw new Error(`attendu : publie — ${result.status} ${JSON.stringify(result)}`);
    }
    // Le modele n'a jamais vu la claim disqualifiee...
    expect(vusParLeFactChecker.join(" ")).not.toContain("claim-4");
    // ...mais il a recu la nature de chaque source qu'il juge.
    expect(vusParLeFactChecker[0]).toContain("nature_des_sources");

    const ids = result.article.claims.map((c) => c.id);
    expect(ids).not.toContain("claim-4");
    expect(result.article.editorial_notes.excluded_claims.join(" ")).toMatch(
      /claim-4 : rejetee .*Euronext/,
    );
    const claim1 = result.article.claims.find((c) => c.id === "claim-1");
    expect(claim1?.sources.map((s) => s.url)).not.toContain(YAHOO);
    expect(result.adjustments.join(" ")).toMatch(/claim-1 : Yahoo Finance retire des citations/);
  });
});
