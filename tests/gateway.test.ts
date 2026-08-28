/**
 * Passerelle de sources : §9.4 (journalisation) et §4 (tiers derives).
 *
 * Le test central de ce fichier est celui du caviardage : c'est par la
 * passerelle que passe l'URL d'un adaptateur, donc c'est le chemin de fuite
 * reel d'une clef d'API vers le journal versionne.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { SourceGateway } from "../src/sources/gateway.js";
import type { FetchOutcome, SourceAdapter } from "../src/sources/types.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "gateway-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const QUERY = { topic: "test", since: "2026-01-01T00:00:00Z" };

function adapter(
  id: string,
  outcome: Partial<FetchOutcome>,
  fail?: string,
): SourceAdapter {
  return {
    id,
    describes: id,
    async fetch(): Promise<FetchOutcome> {
      if (fail !== undefined) throw new Error(fail);
      return {
        requestedUrl: "https://api.worldbank.org/v2/x",
        raw: {},
        observations: [],
        ...outcome,
      };
    },
  };
}

const observation = (url: string) => ({
  source: "Test",
  url,
  date_observed: "2026-08-27T09:00:00Z",
  date_published: null,
  type: "donnee-macro",
  resume: "Observation de test.",
});

async function collect(adapters: SourceAdapter[]) {
  const audit = new AuditLog({ dir: workDir });
  const gateway = new SourceGateway(adapters, audit);
  const result = await gateway.collect(QUERY, "veilleur");
  const journal = await readFile(join(workDir, "journal.jsonl"), "utf8");
  return { result, journal };
}

describe("§9.4 — caviardage sur le chemin reel", () => {
  it("ne laisse pas fuir une clef d'API portee par l'URL d'un adaptateur", async () => {
    const { journal } = await collect([
      adapter("fred:test", {
        requestedUrl:
          "https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=CLEF_QUI_NE_DOIT_PAS_FUIR",
        observations: [observation("https://fred.stlouisfed.org/series/GDP")],
      }),
    ]);

    expect(journal).not.toMatch(/CLEF_QUI_NE_DOIT_PAS_FUIR/);
    expect(journal).toMatch(/series_id=GDP/);
    expect(journal).toMatch(/"redacted_params":\["apikey"\]/);
  });

  it("ne laisse pas fuir une clef via le message d'erreur d'un adaptateur", async () => {
    const { result, journal } = await collect([
      adapter(
        "fred:test",
        {},
        "HTTP 503 sur https://api.stlouisfed.org/fred/series?api_key=CLEF_DANS_LERREUR",
      ),
    ]);

    expect(journal).not.toMatch(/CLEF_DANS_LERREUR/);
    expect(result.failures).toHaveLength(1);
  });
});

describe("§4 — le tier vient du registre, pas de l'adaptateur", () => {
  it("classe une observation selon son domaine", async () => {
    const { result } = await collect([
      adapter("x", {
        observations: [
          observation("https://fred.stlouisfed.org/series/GDP"),
          observation("https://gnews.io/articles/x"),
        ],
      }),
    ]);

    expect(result.events.find((e) => e.url.includes("fred"))?.tier).toBe(1);
    expect(result.events.find((e) => e.url.includes("gnews"))?.tier).toBe(3);
  });

  it("signale un domaine hors registre, classe tier 3 par defaut", async () => {
    const { result } = await collect([
      adapter("x", {
        observations: [observation("https://blog-inconnu.example/post")],
      }),
    ]);

    expect(result.unregisteredUrls).toEqual(["https://blog-inconnu.example/post"]);
    expect(result.events[0]?.tier).toBe(3);
  });

  it("signale les secondaires eclipsees par une primaire (EP-001)", async () => {
    const { result } = await collect([
      adapter("x", {
        observations: [
          observation("https://fred.stlouisfed.org/series/GDP"),
          observation("https://gnews.io/articles/x"),
        ],
      }),
    ]);

    expect(result.shadowedSecondaries).toEqual(["https://gnews.io/articles/x"]);
  });
});

describe("robustesse de la collecte", () => {
  it("un adaptateur en echec n'empeche pas les autres de repondre", async () => {
    const { result } = await collect([
      adapter("mort", {}, "HTTP 503"),
      adapter("vivant", {
        observations: [observation("https://reliefweb.int/report/x")],
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.adapterId).toBe("mort");
  });

  it("rejette une observation non conforme au §5.1 sans tout faire tomber", async () => {
    const { result } = await collect([
      adapter("x", {
        observations: [
          { ...observation("pas-une-url") },
          observation("https://reliefweb.int/report/x"),
        ],
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.failures[0]?.error).toMatch(/non conforme au §5.1/);
  });
});
