/**
 * Client Anthropic — exercer enfin le seul fichier jamais execute.
 *
 * Ecrits AVANT le code (TDD).
 *
 * LE POINT AVEUGLE LE PLUS ANCIEN DU PROJET. `anthropic-client.ts` est le seul
 * module a n'avoir jamais tourne contre une vraie API : le mode `live` exige
 * une clef facturee, donc chaque seance le contournait. Le CLI l'annonce a
 * chaque execution, ce qui est honnete mais ne le teste pas.
 *
 * CE QUE LA DOCUMENTATION D'OLLAMA APPORTE. Le service cloud expose un endpoint
 * COMPATIBLE ANTHROPIC sur `/v1/messages`. Le SDK Anthropic peut donc y etre
 * dirige : la requete reellement emise par le SDK est alors recue et traitee
 * par un vrai serveur, et sa reponse revient dans la vraie forme.
 *
 * MESURE AVANT CONSTRUCTION, et elle a tranche une ambiguite de la doc :
 *
 *   POST https://ollama.com/v1/messages
 *     x-api-key: <clef>            -> HTTP 401 authentication_error
 *     Authorization: Bearer <clef> -> HTTP 200
 *
 * Le SDK Anthropic envoie `x-api-key` par defaut. Le brancher naivement aurait
 * donc echoue, et la doc d'Ollama — qui montre `x-api-key: ollama` pour le
 * serveur LOCAL — aurait laisse croire a une erreur de notre cote.
 *
 * CE QUE CELA VALIDE, ET CE QUE CELA NE VALIDE PAS. La forme de la requete
 * emise par le SDK, l'authentification, le traitement d'une reponse reelle et
 * des erreurs. PAS que l'API d'Anthropic elle-meme accepte cette requete : un
 * service compatible reste un service tiers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { AnthropicLlmClient } from "../src/llm/anthropic-client.js";
import { FREE_PROVIDERS } from "../src/llm/providers.js";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CLEF = "cle-ollama-fictive-0123456789";

const Schema = z.object({ reponse: z.string() }).strict();

const requete = () => ({
  agent: "analyste",
  schemaName: "Test",
  schema: Schema,
  protocol: "Protocole Editorial v1.0 (extrait)",
  roleInstructions: "Consignes de role.",
  system: "protocole + consignes",
  user: "sujet",
  effort: "high" as const,
});

/** Capture la requete emise par le SDK, sans reseau. */
function capturer(reponse: unknown): { appels: Array<{ url: string; init: RequestInit }> } {
  const appels: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: unknown) => {
      appels.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify(reponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { appels };
}

const reponseAnthropic = (contenu: unknown) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "gpt-oss:120b",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(contenu) }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("authentification par jeton porteur", () => {
  it("envoie Authorization: Bearer quand le fournisseur l'exige", async () => {
    // Mesure du 2026-09-09 : `x-api-key` rend 401 sur ollama.com, `Bearer`
    // rend 200. Le SDK envoie `x-api-key` par defaut.
    const { appels } = capturer(reponseAnthropic({ reponse: "ok" }));
    const client = new AnthropicLlmClient({
      audit: new AuditLog({ persist: false }),
      model: "gpt-oss:120b",
      apiKey: CLEF,
      baseUrl: "https://ollama.com",
      bearerAuth: true,
    });

    await client.structured(requete());

    const entetes = new Headers(appels[0]?.init.headers as Record<string, string>);
    expect(entetes.get("authorization")).toBe(`Bearer ${CLEF}`);
  });

  it("n'envoie PAS la clef dans x-api-key en mode porteur", async () => {
    // Envoyer les deux laisserait le serveur choisir, et un 401 deviendrait
    // indechiffrable.
    const { appels } = capturer(reponseAnthropic({ reponse: "ok" }));
    await new AnthropicLlmClient({
      audit: new AuditLog({ persist: false }),
      model: "gpt-oss:120b",
      apiKey: CLEF,
      baseUrl: "https://ollama.com",
      bearerAuth: true,
    }).structured(requete());

    const entetes = new Headers(appels[0]?.init.headers as Record<string, string>);
    expect(entetes.get("x-api-key")).toBeNull();
  });

  it("conserve x-api-key par defaut, pour l'API d'Anthropic elle-meme", async () => {
    // Le mode porteur est une DEROGATION pour service compatible. L'API
    // d'Anthropic attend `x-api-key`, et c'est elle la cible normale.
    const { appels } = capturer(reponseAnthropic({ reponse: "ok" }));
    await new AnthropicLlmClient({
      audit: new AuditLog({ persist: false }),
      apiKey: CLEF,
    }).structured(requete());

    const entetes = new Headers(appels[0]?.init.headers as Record<string, string>);
    expect(entetes.get("x-api-key")).toBe(CLEF);
    expect(entetes.get("authorization")).toBeNull();
  });

  it("frappe bien /v1/messages sur la base fournie", async () => {
    const { appels } = capturer(reponseAnthropic({ reponse: "ok" }));
    await new AnthropicLlmClient({
      audit: new AuditLog({ persist: false }),
      apiKey: CLEF,
      baseUrl: "https://ollama.com",
      bearerAuth: true,
    }).structured(requete());

    expect(appels[0]?.url).toBe("https://ollama.com/v1/messages");
  });
});

describe("le fournisseur est declare au catalogue", () => {
  it("expose `ollama-anthropic`, dirige vers l'endpoint compatible", () => {
    const spec = FREE_PROVIDERS["ollama-anthropic"];
    expect(spec).toBeDefined();
    expect(spec?.baseUrl).toBe("https://ollama.com");
    expect(spec?.envKey).toBe("OLLAMA_API_KEY");
  });

  it("dit ce qu'il valide, et ce qu'il ne valide pas", () => {
    // Un fournisseur qui laisserait croire qu'il valide l'API d'Anthropic
    // serait pire qu'aucun test : il donnerait une confiance imméritée.
    const notes = FREE_PROVIDERS["ollama-anthropic"]?.notes ?? "";
    expect(notes).toMatch(/anthropic-client/i);
    expect(notes).toMatch(/ne valide pas|pas que l'API/i);
  });
});
