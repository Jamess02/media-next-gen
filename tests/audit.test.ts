/**
 * §9.4 — journalisation des connexions externes.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "audit-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const newLog = () => new AuditLog({ dir: workDir });

describe("journal d'audit", () => {
  it("enregistre url, date d'observation et empreinte de la reponse", async () => {
    const log = newLog();
    const record = await log.record({
      kind: "source",
      agent: "veilleur",
      target: "https://fred.stlouisfed.org/api?id=X",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: { value: 4.5 },
    });

    expect(record.target).toBe("https://fred.stlouisfed.org/api?id=X");
    expect(record.date_observed).toBe("2026-08-27T09:00:00Z");
    expect(record.raw_sha256).toHaveLength(64);
  });

  it("stocke un chemin RELATIF, reutilisable sur une autre machine", async () => {
    const record = await newLog().record({
      kind: "source",
      agent: "veilleur",
      target: "https://example.org",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: { a: 1 },
    });

    expect(record.raw_path).toMatch(/^raw\/[0-9a-f]{64}\.json$/);
    expect(record.raw_path).not.toMatch(/^[A-Za-z]:/);
  });

  it("relit la reponse brute archivee (§6 : correction verifiable)", async () => {
    const log = newLog();
    const payload = { series: "X", observations: [1, 2, 3] };
    const record = await log.record({
      kind: "source",
      agent: "analyste",
      target: "https://example.org",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: payload,
    });

    expect(await log.readRaw(record)).toEqual(payload);
  });

  it("produit la meme empreinte quel que soit l'ordre des clefs", async () => {
    const log = newLog();
    const a = await log.record({
      kind: "source",
      agent: "x",
      target: "https://example.org",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: { alpha: 1, beta: 2 },
    });
    const b = await log.record({
      kind: "source",
      agent: "x",
      target: "https://example.org",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: { beta: 2, alpha: 1 },
    });

    expect(a.raw_sha256).toBe(b.raw_sha256);
  });

  it("caviarde la clef d'API avant ecriture sur disque (§9.4)", async () => {
    const log = newLog();
    await log.record({
      kind: "source",
      agent: "veilleur",
      target:
        "https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=CLEF_SECRETE_REELLE",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: { ok: true },
    });

    // Le fichier ecrit est ce qui part sur le depot public : c'est lui qu'on
    // inspecte, pas seulement l'objet retourne.
    const journal = await readFile(join(workDir, "journal.jsonl"), "utf8");
    expect(journal).not.toMatch(/CLEF_SECRETE_REELLE/);
    expect(journal).toMatch(/series_id=GDP/);

    const record = JSON.parse(journal.trim()) as {
      target: string;
      redacted_params: string[];
    };
    expect(record.redacted_params).toEqual(["apikey"]);
  });

  it("caviarde aussi les URLs presentes dans un message d'erreur", async () => {
    const log = newLog();
    await log.record({
      kind: "source",
      agent: "veilleur",
      target: "https://api.example.org/v1",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: {},
      error:
        "HTTP 503 sur https://api.example.org/v1?api_key=FUITE_PAR_LERREUR",
    });

    const journal = await readFile(join(workDir, "journal.jsonl"), "utf8");
    expect(journal).not.toMatch(/FUITE_PAR_LERREUR/);
    expect(journal).toMatch(/HTTP 503/);
  });

  it("n'annonce aucun caviardage quand l'URL n'a pas de secret", async () => {
    const record = await newLog().record({
      kind: "source",
      agent: "veilleur",
      target: "https://api.worldbank.org/v2/country/EMU?format=json",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: {},
    });

    expect(record.redacted_params).toBeUndefined();
    expect(record.target).toBe(
      "https://api.worldbank.org/v2/country/EMU?format=json",
    );
  });

  it("journalise aussi les echecs", async () => {
    const record = await newLog().record({
      kind: "source",
      agent: "veilleur",
      target: "reliefweb:humanitarian",
      dateObserved: "2026-08-27T09:00:00Z",
      raw: {},
      error: "HTTP 503",
    });

    expect(record.error).toBe("HTTP 503");
  });

  it("ecrit une ligne JSONL par appel, sans entrelacement", async () => {
    const log = newLog();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.record({
          kind: "llm",
          agent: `agent-${i}`,
          target: "mock",
          dateObserved: "2026-08-27T09:00:00Z",
          raw: { i },
        }),
      ),
    );

    const lines = (await readFile(join(workDir, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(20);
    // Chaque ligne doit etre du JSON valide : preuve que la file d'ecriture
    // a bien serialise les appels concurrents.
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });
});
