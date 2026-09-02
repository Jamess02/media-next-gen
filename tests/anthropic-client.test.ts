/**
 * Client Anthropic.
 *
 * Ce fichier etait le seul du projet sans aucune couverture : il n'avait jamais
 * ete execute, ni contre l'API reelle, ni contre quoi que ce soit. Les branches
 * testees ici — refus, troncature, sortie non conforme — sont precisement
 * celles qui ne se declenchent qu'en cas de probleme, donc celles qu'on
 * decouvre au pire moment si elles sont fausses.
 *
 * Le SDK est dirige vers un serveur local par `baseUrl`. Ce que cela valide :
 * la forme de la requete REELLEMENT emise et le traitement des reponses. Ce que
 * cela ne valide pas : que l'API Anthropic accepte cette requete — un serveur
 * qu'on ecrit soi-meme accepte ce qu'on lui envoie.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AuditLog } from "../src/audit/audit-log.js";
import { AnthropicLlmClient } from "../src/llm/anthropic-client.js";
import { LlmContractError } from "../src/llm/types.js";

const Schema = z
  .object({ verdict: z.enum(["ok", "ko"]), note: z.string() })
  .strict();

const VALID = { verdict: "ok", note: "conforme" };

let workDir: string;
let server: Server;
let baseUrl: string;
let received: Array<Record<string, unknown>> = [];

/** Demarre un serveur qui rend la reponse fournie et enregistre les requetes. */
async function start(
  respond: () => Record<string, unknown>,
  status = 200,
): Promise<void> {
  received = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push(JSON.parse(raw));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(respond()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: JSON.stringify(VALID) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20 },
  ...overrides,
});

function client(): AnthropicLlmClient {
  return new AnthropicLlmClient({
    audit: new AuditLog({ dir: workDir }),
    apiKey: "sk-ant-test",
    baseUrl,
  });
}

const request = {
  agent: "fact-checker",
  protocol: "PROTOCOLE ".repeat(200),
  roleInstructions: "INSTRUCTIONS DE ROLE",
  system: "ignore",
  user: "entree",
  schema: Schema,
  schemaName: "TestOutput",
  effort: "max" as const,
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "anthropic-client-"));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

describe("forme de la requete emise", () => {
  it("envoie DEUX blocs systeme, cache uniquement sur le protocole", async () => {
    // C'est la correction de mise en cache : un bloc unique donnait a chaque
    // agent une clef de cache differente, donc zero lecture.
    await start(() => message());
    await client().structured(request);

    const sent = received[0] as { system: Array<Record<string, unknown>> };
    expect(sent.system).toHaveLength(2);
    expect(sent.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(sent.system[1]?.cache_control).toBeUndefined();
    expect(sent.system[0]?.text).toContain("PROTOCOLE");
    expect(sent.system[1]?.text).toBe("INSTRUCTIONS DE ROLE");
  });

  it("place le schema et l'effort dans output_config", async () => {
    await start(() => message());
    await client().structured(request);

    const sent = received[0] as {
      output_config: { format: { type: string; schema: unknown }; effort: string };
    };
    expect(sent.output_config.format.type).toBe("json_schema");
    expect(sent.output_config.effort).toBe("max");
    expect(sent.output_config.format.schema).toMatchObject({
      properties: { verdict: {}, note: {} },
    });
  });

  it("rend la sortie validee", async () => {
    await start(() => message());
    expect(await client().structured(request)).toEqual(VALID);
  });
});

describe("branches d'echec", () => {
  it("traite un refus, qui arrive en HTTP 200", async () => {
    // Un refus ne leve pas : il faut lire stop_reason avant le contenu, sinon
    // on publie du vide sans le savoir.
    await start(() =>
      message({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "non" },
      }),
    );
    await expect(client().structured(request)).rejects.toThrow(LlmContractError);
    await expect(client().structured(request)).rejects.toThrow(/cyber/);
  });

  it("refuse une reponse tronquee par max_tokens", async () => {
    // Une sortie partielle peut etre syntaxiquement valide et editorialement
    // fausse : elle n'est pas publiable.
    await start(() => message({ stop_reason: "max_tokens" }));
    await expect(client().structured(request)).rejects.toThrow(/tronquee/);
  });

  it("convertit une sortie non conforme en erreur de contrat", async () => {
    // Le SDK leve un AnthropicError (pas une APIError) quand la reponse ne
    // valide pas. Sans conversion, une trace brute remontait a l'utilisateur.
    await start(() =>
      message({ content: [{ type: "text", text: '{"verdict":"peut-etre"}' }] }),
    );
    const error = await client()
      .structured(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmContractError);
    expect(String(error)).toMatch(/non conforme au schema/);
  });

  it("propage une erreur HTTP typee", async () => {
    await start(() => ({ error: { type: "not_found_error", message: "absent" } }), 404);
    const error = await client()
      .structured(request)
      .catch((e: unknown) => e);
    // Une erreur de transport n'est PAS une erreur de contrat : la distinction
    // compte, elles ne se corrigent pas de la meme facon.
    expect(error).not.toBeInstanceOf(LlmContractError);
  });
});

describe("journalisation (§9.4)", () => {
  it("enregistre l'appel reussi", async () => {
    await start(() => message());
    const audit = new AuditLog({ dir: workDir });
    const c = new AnthropicLlmClient({ audit, apiKey: "sk-ant-test", baseUrl });
    await c.structured(request);

    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0]?.target).toMatch(/claude-opus-5#TestOutput/);
  });

  it("enregistre l'echec avec son motif", async () => {
    await start(() => ({ error: { type: "api_error", message: "boum" } }), 500);
    const audit = new AuditLog({ dir: workDir });
    const c = new AnthropicLlmClient({ audit, apiKey: "sk-ant-test", baseUrl });
    await c.structured(request).catch(() => undefined);

    const withError = audit.entries().filter((e) => e.error !== undefined);
    expect(withError.length).toBeGreaterThan(0);
    expect(withError.at(-1)?.error).toMatch(/500/);
  });
});
