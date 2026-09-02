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
  responses: Array<{
    ok?: boolean;
    status?: number;
    body: unknown | string;
    headers?: Record<string, string>;
  }>,
): { calls: () => unknown[][] } {
  let index = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: r?.ok ?? true,
      status: r?.status ?? 200,
      // Le client lit `retry-after` sur les refus pour quota : le bouchon doit
      // exposer une interface Headers, meme vide.
      headers: { get: (nom: string) => r?.headers?.[nom.toLowerCase()] ?? null },
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

describe("schema dans le prompt, ou non", () => {
  it("duplique le schema quand le fournisseur n'applique rien", async () => {
    // Constate sur Ollama Cloud : sans cette copie, le modele ne voit jamais
    // la forme attendue et improvise des noms de champs.
    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await client().structured(request);

    const body = JSON.parse(String((calls()[0]?.[1] as { body: string }).body));
    expect(body.messages[1].content).toMatch(/JSON Schema/);
  });

  it("omet la copie quand le fournisseur applique la contrainte", async () => {
    // Constate sur Groq : la copie y est inutile et double le poids de la
    // requete, ce qui fait franchir la limite de tokens par minute.
    const c = new OpenAiCompatibleLlmClient({
      providerName: "test",
      baseUrl: "https://api.test.local/v1",
      model: "m",
      apiKey: "k",
      audit: new AuditLog({ dir: workDir }),
      enforcesSchema: true,
    });
    const { calls } = stubResponses([
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await c.structured(request);

    const body = JSON.parse(String((calls()[0]?.[1] as { body: string }).body));
    expect(body.messages[1].content).toBe("entree");
    // Le schema reste transmis par le canal officiel.
    expect(body.response_format.json_schema.schema).toBeDefined();
  });
});

describe("quota et troncature", () => {
  it("attend puis reessaie apres un refus pour quota", async () => {
    const { calls } = stubResponses([
      {
        ok: false,
        status: 429,
        body: "rate limit exceeded, try again in 0.05s",
      },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    expect(await client().structured(request)).toEqual({
      verdict: "ok",
      note: "x",
    });
    expect(calls()).toHaveLength(2);
  });

  it("reessaie sur un 413 signalant un depassement de tokens par minute", async () => {
    // Groq emploie 413 pour un depassement TPM, la ou 429 serait attendu.
    const { calls } = stubResponses([
      {
        ok: false,
        status: 413,
        body: "Request too large ... on tokens per minute (TPM): Limit 8000, try again in 0.05s",
      },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await client().structured(request);
    expect(calls()).toHaveLength(2);
  });

  it("ne reessaie PAS quand la requete depasse le quota TOTAL", async () => {
    // Un quota temporairement epuise se recharge ; une requete plus grosse que
    // le quota entier ne passera jamais. Attendre trois fois pour un echec
    // certain coutait plusieurs minutes.
    const { calls } = stubResponses([
      {
        ok: false,
        status: 413,
        body: "on tokens per minute (TPM): Limit 8000, Requested 8834, please reduce your message size",
      },
    ]);
    const error = await client()
      .structured(request)
      .catch((e: unknown) => e);

    expect(calls()).toHaveLength(1);
    // Le message doit dire quoi faire, pas seulement que ca a echoue.
    expect(String(error)).toMatch(/depasse a elle seule le quota/);
    expect(String(error)).toMatch(/Attendre ne changera rien/);
  });

  it("reessaie quand le quota est temporairement epuise", async () => {
    // Meme code d'erreur, situation opposee : la demande tient dans la limite.
    const { calls } = stubResponses([
      {
        ok: false,
        status: 429,
        body: "TPM: Limit 8000, Requested 500. try again in 0.05s",
      },
      { body: completion(JSON.stringify({ verdict: "ok", note: "x" })) },
    ]);
    await client().structured(request);
    expect(calls()).toHaveLength(2);
  });

  it("ne reessaie PAS un 413 signifiant une charge utile trop grosse", async () => {
    // Rejouer a l'identique echouerait indefiniment.
    const { calls } = stubResponses([
      { ok: false, status: 413, body: "Payload too large" },
    ]);
    await expect(client().structured(request)).rejects.toThrow(/HTTP 413/);
    expect(calls()).toHaveLength(1);
  });

  it("signale une reponse tronquee au lieu de tenter de la reparer", async () => {
    // Une troncature produit du JSON invalide : sans ce controle, le client
    // partait en reparation avec un message trompeur. Le remede est
    // d'augmenter max_tokens, pas de reformuler.
    const { calls } = stubResponses([
      {
        body: {
          choices: [
            { message: { content: '{"verdict":"o' }, finish_reason: "length" },
          ],
        },
      },
    ]);
    await expect(client().structured(request)).rejects.toThrow(/tronquee/);
    expect(calls()).toHaveLength(1);
  });

  it("signale un contenu vide du a un raisonnement non expose", async () => {
    stubResponses([
      { body: { choices: [{ message: { content: "", reasoning: "je reflechis" } }] } },
    ]);
    await expect(client(0).structured(request)).rejects.toThrow(
      /raisonnement non expose/,
    );
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
