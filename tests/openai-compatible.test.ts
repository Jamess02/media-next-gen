/**
 * Client compatible OpenAI (fournisseurs gratuits).
 *
 * Ce client existe parce que les modeles gratuits respectent INEGALEMENT
 * `response_format`. Ces tests portent donc sur les filets qui n'existent pas
 * cote Anthropic : reparation bornee, repli de format, tolerance aux blocs
 * markdown. Sans eux, le pipeline echouerait sur la moitie des fournisseurs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AuditLog } from "../src/audit/audit-log.js";
import { OpenAiCompatibleLlmClient } from "../src/llm/openai-compatible-client.js";
import { LlmContractError } from "../src/llm/types.js";

const Schema = z.object({ verdict: z.enum(["ok", "ko"]), note: z.string() }).strict();

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "openai-compat-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(workDir, { recursive: true, force: true });
});

function client(repairAttempts = 1) {
  return new OpenAiCompatibleLlmClient({
    providerName: "test",
    baseUrl: "https://api.test.local/v1/",
    model: "modele-test",
    apiKey: "CLEF_DE_TEST",
    audit: new AuditLog({ dir: workDir }),
    repairAttempts,
  });
}

const request = {
  agent: "fact-checker",
  protocol: "PROTOCOLE",
  roleInstructions: "ROLE",
  system: "PROTOCOLE\n\nROLE",
  user: "entree",
  schema: Schema,
  schemaName: "TestOutput",
};

/** Enchaine des reponses HTTP successives. */
function stubResponses(
  responses: Array<{ ok?: boolean; status?: number; body: unknown | string }>,
): { calls: () => unknown[][] } {
  let index = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: r?.ok ?? true,
      status: r?.status ?? 200,
      text: async () =>
        typeof r?.body === "string" ? r.body : JSON.stringify(r?.body),
    };
  });
  vi.stubGlobal("fetch", fn);
  return { calls: () => fn.mock.calls as unknown[][] };
}

const completion = (content: string) => ({
  choices: [{ message: { content } }],
});

describe("sortie conforme du premier coup", () => {
  it("valide et rend la sortie", async () => {
    stubResponses([
      { body: completion(JSON.stringify({ verdict: "ok", note: "rien" })) },
    ]);
    expect(await client().structured(request)).toEqual({
      verdict: "ok",
      note: "rien",
    });
  });

  it("envoie le schema JSON en response_format", async () => {
    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await client().structured(request);

    const body = JSON.parse(String((calls()[0]?.[1] as { body: string }).body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.properties.verdict).toBeDefined();
    // Le protocole et le role sont concatenes : ces APIs n'ont qu'un systeme.
    expect(body.messages[0].content).toContain("PROTOCOLE");
    expect(body.messages[0].content).toContain("ROLE");
  });

  it("tolere une sortie encadree de ```json", async () => {
    // Plusieurs modeles le font malgre une consigne explicite.
    stubResponses([
      { body: completion('```json\n{"verdict":"ok","note":"x"}\n```') },
    ]);
    expect(await client().structured(request)).toEqual({
      verdict: "ok",
      note: "x",
    });
  });
});

describe("reparation bornee", () => {
  it("renvoie les erreurs de validation au modele et accepte la correction", async () => {
    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "peut-etre" })) },
      { body: completion(JSON.stringify({ verdict: "ko", note: "corrige" })) },
    ]);

    expect(await client().structured(request)).toEqual({
      verdict: "ko",
      note: "corrige",
    });

    // La seconde requete doit montrer au modele SA sortie et ce qui clochait :
    // sans les deux, il reproduit la meme erreur.
    const second = JSON.parse(String((calls()[1]?.[1] as { body: string }).body));
    expect(second.messages).toHaveLength(4);
    expect(second.messages[2].role).toBe("assistant");
    expect(second.messages[3].content).toContain("verdict");
  });

  it("repare une reponse qui n'est pas du JSON", async () => {
    stubResponses([
      { body: completion("Bien sur ! Voici ma reponse.") },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    expect(await client().structured(request)).toEqual({
      verdict: "ok",
      note: "x",
    });
  });

  it("abandonne apres le nombre de reparations autorise", async () => {
    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "invalide" })) },
    ]);
    await expect(client(1).structured(request)).rejects.toThrow(LlmContractError);
    // 1 tentative initiale + 1 reparation : pas de boucle infinie.
    expect(calls()).toHaveLength(2);
  });

  it("expose l'erreur de validation dans le message final", async () => {
    stubResponses([{ body: completion(JSON.stringify({ verdict: "nope" })) }]);
    await expect(client(0).structured(request)).rejects.toThrow(/verdict/);
  });
});

describe("repli de format", () => {
  it("retente en json_object quand le fournisseur refuse json_schema", async () => {
    // Cas reel : plusieurs paliers gratuits rejettent json_schema en 400.
    const { calls } = stubResponses([
      { ok: false, status: 400, body: "response_format json_schema unsupported" },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);

    expect(await client().structured(request)).toEqual({
      verdict: "ok",
      note: "x",
    });

    const first = JSON.parse(String((calls()[0]?.[1] as { body: string }).body));
    const second = JSON.parse(String((calls()[1]?.[1] as { body: string }).body));
    expect(first.response_format.type).toBe("json_schema");
    expect(second.response_format.type).toBe("json_object");
  });

  it("ne masque pas une erreur serveur reelle", async () => {
    stubResponses([{ ok: false, status: 500, body: "boom" }]);
    await expect(client().structured(request)).rejects.toThrow(/HTTP 500/);
  });
});

describe("journalisation (§9.4)", () => {
  it("enregistre chaque appel, y compris les tentatives de reparation", async () => {
    const audit = new AuditLog({ dir: workDir });
    const c = new OpenAiCompatibleLlmClient({
      providerName: "test",
      baseUrl: "https://api.test.local/v1",
      model: "modele-test",
      apiKey: "CLEF",
      audit,
    });

    stubResponses([
      { body: completion("pas du json") },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await c.structured(request);

    expect(audit.entries()).toHaveLength(2);
    expect(audit.entries().every((e) => e.kind === "llm")).toBe(true);
  });

  it("journalise aussi les echecs HTTP", async () => {
    const audit = new AuditLog({ dir: workDir });
    const c = new OpenAiCompatibleLlmClient({
      providerName: "test",
      baseUrl: "https://api.test.local/v1",
      model: "modele-test",
      audit,
    });

    stubResponses([{ ok: false, status: 503, body: "indisponible" }]);
    await expect(c.structured(request)).rejects.toThrow();
    expect(audit.entries()[0]?.error).toMatch(/HTTP 503/);
  });
});

describe("serveur local sans clef", () => {
  it("n'envoie pas d'en-tete Authorization", async () => {
    const audit = new AuditLog({ dir: workDir });
    const c = new OpenAiCompatibleLlmClient({
      providerName: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:14b",
      audit,
    });

    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await c.structured(request);

    const headers = (calls()[0]?.[1] as { headers: Record<string, string> })
      .headers;
    expect(headers["authorization"]).toBeUndefined();
  });
});
