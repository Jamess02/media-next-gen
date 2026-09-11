/**
 * Donnees de marche — ce que chaque agent RECOIT comme consigne.
 *
 * Ecrits AVANT le code (TDD).
 *
 * L'editeur a demande deux choses : des metadonnees qui forcent la formulation
 * (« le prix du bitcoin sur Binance ») ET des consignes d'agents qui
 * l'imposent. Les regles du gate bloquent ; ces consignes evitent d'arriver
 * au blocage. Une consigne seule serait une suggestion — c'est pourquoi le
 * dernier test verifie, de bout en bout, que le gate refuse quand meme un
 * texte qui les ignore.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalysteOutput } from "../src/agents/analyste.js";
import { Analyste } from "../src/agents/analyste.js";
import { Editeur } from "../src/agents/editeur.js";
import { Redacteur } from "../src/agents/redacteur.js";
import { Veilleur } from "../src/agents/veilleur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { MOCK_RESPONDERS } from "../src/fixtures/mock-scenario.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import type { LlmRequest } from "../src/llm/types.js";
import { EditorialPipeline } from "../src/pipeline.js";
import { attributionsExigees } from "../src/protocol/sources-de-marche.js";
import { MOCK_ADAPTERS } from "../src/sources/mock-sources.js";
import type { SourceAdapter } from "../src/sources/types.js";
import { claim } from "./helpers.js";

const BINANCE =
  "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=1788998400000&endTime=1789084799999";
const COINGECKO =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=1789084200&to=1789085400";
const YAHOO =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EFCHI?period1=1788220800&period2=1789084800&interval=1d";

const ref = (url: string, tier: 1 | 2 | 3) => ({
  url,
  tier,
  date_observed: "2026-09-11T08:00:00Z",
  date_published: "2026-09-10T23:59:59.999Z",
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marche-prompts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Execute un agent et rend ce que le modele a recu. */
async function requeteDe(
  role: string,
  reponse: unknown,
  lancer: (ctx: { llm: MockLlmClient; audit: AuditLog }) => Promise<unknown>,
): Promise<LlmRequest<unknown>> {
  const vues: LlmRequest<unknown>[] = [];
  const audit = new AuditLog({ dir: join(dir, "audit") });
  const llm = new MockLlmClient({
    audit,
    responders: {
      [role]: (req) => {
        vues.push(req);
        return reponse;
      },
    },
  });
  await lancer({ llm, audit });
  const vue = vues[0];
  if (vue === undefined) throw new Error("aucun appel au modele");
  return vue;
}

const consignes = (req: LlmRequest<unknown>): string => `${req.system}\n${req.roleInstructions}`;

/* -------------------------------------------------------------------------
 * Attributions : calculees par le code, depuis le registre
 * ---------------------------------------------------------------------- */

describe("attributionsExigees — la formule vient du registre, pas d'un prompt", () => {
  it("exige « sur Binance » pour une claim adossee a Binance", () => {
    const a = attributionsExigees([claim({ id: "c1", sources: [ref(BINANCE, 1)] })]);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("« sur Binance »");
    expect(a[0]).toContain("[[c1]]");
  });

  it("exige « selon CoinGecko » pour un agregat CoinGecko", () => {
    const a = attributionsExigees([claim({ id: "c2", sources: [ref(COINGECKO, 2)] })]);
    expect(a[0]).toContain("« selon CoinGecko »");
  });

  it("n'exige rien pour une source hors marche, ni pour un signal (qui ne se cite pas)", () => {
    expect(attributionsExigees([claim()])).toEqual([]);
    expect(attributionsExigees([claim({ sources: [ref(YAHOO, 3)] })])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Consignes des agents
 * ---------------------------------------------------------------------- */

describe("consignes — le Veilleur sait ce qu'est une donnee de marche", () => {
  it("distingue plateforme unique, agregat et signal", async () => {
    const req = await requeteDe(
      "veilleur",
      { retained: [], set_aside: [], freshness_assessment: "x", primary_source_available: false },
      (ctx) =>
        new Veilleur(ctx).run({
          topic: "bitcoin",
          collection: { events: [], shadowedSecondaries: [], unregisteredUrls: [], failures: [] },
        }),
    );
    const c = consignes(req);
    expect(c).toMatch(/DONNEES DE MARCHE/);
    expect(c).toContain("« sur Binance »");
    expect(c).toMatch(/signal-de-marche/);
  });
});

describe("consignes — l'Analyste ecrit la formule, l'unite, et ne conseille pas", () => {
  it("impose « sur Binance », « selon CoinGecko », l'USDT et l'interdit EP-007", async () => {
    const reponse: AnalysteOutput = { candidates: [], narrative_vs_data: "x", publication_caveats: [] };
    const req = await requeteDe("analyste", reponse, (ctx) =>
      new Analyste(ctx).run({ topic: "bitcoin", events: [], freshnessAssessment: "x", mode: "constat" }),
    );
    const c = consignes(req);
    expect(c).toContain("« sur Binance »");
    expect(c).toContain("« selon CoinGecko »");
    expect(c).toMatch(/USDT.*pas le dollar/s);
    expect(c).toMatch(/signal/);
    expect(c).toMatch(/EP-007/);
  });
});

describe("consignes — le Redacteur recoit les attributions a ecrire", () => {
  it("transmet les attributions obligatoires, et la consigne qui les explique", async () => {
    const attribution = attributionsExigees([claim({ id: "c1", sources: [ref(BINANCE, 1)] })]);
    const req = await requeteDe("redacteur", { title: "t", body: "b", uncertainty_flags: [] }, (ctx) =>
      new Redacteur(ctx).run({
        topic: "bitcoin",
        claims: [],
        narrativeVsData: "",
        publicationCaveats: [],
        requiredDisclaimer: null,
        requiredDisclosures: [],
        requiredAttributions: attribution,
        mode: "constat",
        sourceMaterial: [],
      }),
    );
    expect(req.user).toContain("attributions_obligatoires");
    expect(req.user).toContain("sur Binance");
    expect(consignes(req)).toMatch(/ATTRIBUTIONS/);
  });
});

/* -------------------------------------------------------------------------
 * Bout en bout : une consigne ignoree ne passe pas le gate
 * ---------------------------------------------------------------------- */

const binanceSimule: SourceAdapter = {
  id: "binance:bitcoin",
  describes: "Binance simule",
  fetch: async () => ({
    observations: [
      {
        source: "Binance",
        url: BINANCE,
        date_observed: "2026-09-11T08:00:00.000Z",
        date_published: "2026-09-10T23:59:59.999Z",
        type: "donnee-de-marche",
        resume: "Binance — bitcoin (BTC/USDT). Cloture : 76568.72 USDT.",
      },
    ],
    raw: {},
    requestedUrl: BINANCE,
  }),
};

describe("bout en bout — le pipeline transmet l'attribution, et le gate la verifie", () => {
  it("refuse de publier un corps qui ne nomme pas Binance, meme instruit de le faire", async () => {
    const vuParLeRedacteur: string[] = [];
    const veilleur = MOCK_RESPONDERS["veilleur"] as MockResponder;
    const analyste = MOCK_RESPONDERS["analyste"] as MockResponder;
    const redacteur = MOCK_RESPONDERS["redacteur"] as MockResponder;

    const responders: Record<string, MockResponder> = {
      ...MOCK_RESPONDERS,
      veilleur: (req) => {
        const r = veilleur(req) as { retained: Array<{ url: string; selection_reason: string }> };
        return { ...r, retained: [...r.retained, { url: BINANCE, selection_reason: "cotation" }] };
      },
      analyste: (req) => {
        const r = analyste(req) as AnalysteOutput;
        const [c1, ...reste] = r.candidates;
        return {
          ...r,
          candidates: [
            {
              ...c1!,
              text: "[SIMULATION] Sur Binance, le bitcoin a cloture a 76 568,72 USDT le 10 septembre 2026.",
              sources: [ref(BINANCE, 1)],
            },
            ...reste,
          ],
        };
      },
      // Le Redacteur simule ne tient AUCUN compte de la consigne : c'est le
      // cas que le gate existe pour arreter.
      redacteur: (req) => {
        vuParLeRedacteur.push(req.user);
        return redacteur(req);
      },
    };

    const audit = new AuditLog({ dir: join(dir, "audit") });
    const pipeline = new EditorialPipeline({
      ctx: { llm: new MockLlmClient({ audit, responders }), audit },
      adapters: [...MOCK_ADAPTERS, binanceSimule],
      editeur: new Editeur(join(dir, "output"), new EditorialChangelog(join(dir, "c.md"))),
    });
    const result = await pipeline.run("test");

    expect(vuParLeRedacteur.join(" ")).toContain("« sur Binance »");
    expect(result.status).toBe("halted");
    if (result.status !== "halted") return;
    expect(result.stage).toBe("publication");
    expect(result.details.join(" ")).toMatch(/PLATEFORME_NON_NOMMEE/);
  });
});
