/**
 * Client LLM pour toute API compatible OpenAI.
 *
 * Un seul fichier couvre Groq, Google Gemini (endpoint compatible), Mistral,
 * OpenRouter, Ollama et LM Studio : ces fournisseurs exposent tous le meme
 * `POST /chat/completions`. Seuls changent l'URL de base, le modele et la clef.
 *
 * DEPENDANCES
 *
 *  - npm : aucune. Pas de paquet `openai` — l'API est un POST JSON, embarquer
 *    un SDK pour envoyer un corps de requete serait gratuit.
 *  - internes : `types.ts` (le contrat `LlmClient`) et `audit/audit-log.ts`.
 *    Volontairement PAS `sources/http.ts` : `llm/` et `sources/` sont deux
 *    couches distinctes, et les coupler pour economiser vingt lignes creerait
 *    une dependance transverse durable.
 *
 * DIFFERENCE ESSENTIELLE AVEC LE CLIENT ANTHROPIC
 *
 * `messages.parse()` garantit cote serveur une sortie conforme au schema. Ici,
 * rien de tel : les modeles gratuits respectent inegalement `response_format`.
 * Ce client ajoute donc deux filets qui n'existent pas cote Anthropic :
 *
 *  1. une REPARATION bornee — la sortie invalide et les erreurs zod sont
 *     renvoyees au modele pour une seule nouvelle tentative ;
 *  2. un REPLI de format — si le fournisseur refuse `json_schema`, on retente
 *     en `json_object`, en s'appuyant sur zod pour la validation.
 *
 * Ces filets rattrapent la forme, jamais le fond. Un modele faible produira des
 * sorties conformes au schema mais editorialement mediocres : c'est le gate
 * deterministe (§9.3) qui les arrete, pas ce fichier.
 */

import type { AuditLog } from "../audit/audit-log.js";
import { type LlmClient, LlmContractError, type LlmRequest } from "./types.js";
import { z } from "zod";

export interface OpenAiCompatibleConfig {
  /** Nom lisible du fournisseur, pour le journal et les messages d'erreur. */
  providerName: string;
  /** Racine de l'API, sans `/chat/completions` (ex : "https://api.groq.com/openai/v1"). */
  baseUrl: string;
  model: string;
  /** Omise pour un serveur local (Ollama, LM Studio). */
  apiKey?: string;
  audit: AuditLog;
  timeoutMs?: number;
  maxTokens?: number;
  /** Tentatives de reparation apres un echec de validation. 1 par defaut. */
  repairAttempts?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly modelId: string;
  private readonly config: Required<
    Omit<OpenAiCompatibleConfig, "apiKey" | "audit">
  > & { apiKey?: string; audit: AuditLog };

  constructor(config: OpenAiCompatibleConfig) {
    this.modelId = `${config.providerName}/${config.model}`;
    this.config = {
      providerName: config.providerName,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      model: config.model,
      audit: config.audit,
      timeoutMs: config.timeoutMs ?? 120_000,
      maxTokens: config.maxTokens ?? 8192,
      repairAttempts: config.repairAttempts ?? 1,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    };
  }

  async structured<T>(request: LlmRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(request.schema);
    const messages: ChatMessage[] = [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ];

    // `strict` n'est pas supporte partout : on commence par le format le plus
    // contraignant et on retombe sur le plus permissif si le serveur refuse.
    let useJsonSchema = true;
    let lastError = "";

    for (let attempt = 0; attempt <= this.config.repairAttempts; attempt += 1) {
      const body = {
        model: this.config.model,
        messages,
        max_tokens: this.config.maxTokens,
        // Temperature basse : on veut de la conformite, pas de la creativite.
        temperature: 0.2,
        response_format: useJsonSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: jsonSchema,
              },
            }
          : { type: "json_object" },
      };

      let payload: unknown;
      try {
        payload = await this.post(body, request);
      } catch (error) {
        // Un refus du format `json_schema` se manifeste par un 400 : on
        // retente une fois en `json_object` plutot que d'abandonner.
        if (
          useJsonSchema &&
          error instanceof ProviderHttpError &&
          error.status === 400
        ) {
          useJsonSchema = false;
          attempt -= 1; // le repli ne consomme pas une tentative de reparation
          continue;
        }
        throw error;
      }

      const content = extractContent(payload);
      if (content === undefined) {
        lastError = "reponse sans contenu textuel exploitable";
        continue;
      }

      const parsedJson = tryParseJson(content);
      if (parsedJson === undefined) {
        lastError = "la reponse n'est pas du JSON valide";
        messages.push(
          { role: "assistant", content },
          {
            role: "user",
            content:
              "Ta reponse n'etait pas du JSON valide. Renvoie UNIQUEMENT un objet " +
              "JSON conforme au schema demande, sans texte autour ni bloc de code.",
          },
        );
        continue;
      }

      const validated = request.schema.safeParse(parsedJson);
      if (validated.success) return validated.data;

      lastError = validated.error.issues
        .map((i) => `${i.path.join(".") || "<racine>"}: ${i.message}`)
        .join(" ; ");

      // Reparation : on montre au modele sa sortie ET ce qui cloche. Sans les
      // deux, il reproduit la meme erreur.
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content:
            `Ta reponse ne respecte pas le schema. Erreurs de validation :\n${lastError}\n\n` +
            `Corrige-les et renvoie UNIQUEMENT l'objet JSON complet et conforme.`,
        },
      );
    }

    throw new LlmContractError(request.agent, request.schemaName, lastError);
  }

  private async post<T>(body: unknown, request: LlmRequest<T>): Promise<unknown> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const dateObserved = new Date().toISOString();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // Pas d'en-tete Authorization pour un serveur local sans clef.
          ...(this.config.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const detail =
        cause.name === "TimeoutError" || cause.name === "AbortError"
          ? `pas de reponse en ${this.config.timeoutMs} ms`
          : `echec reseau — ${cause.message}`;
      await this.record(request, dateObserved, { body }, detail);
      throw new ProviderHttpError(this.config.providerName, url, detail);
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = `HTTP ${response.status} — ${text.slice(0, 300)}`;
      await this.record(request, dateObserved, { body, response: text }, detail);
      throw new ProviderHttpError(
        this.config.providerName,
        url,
        detail,
        response.status,
      );
    }

    const payload = tryParseJson(text);
    if (payload === undefined) {
      const detail = `reponse non-JSON du fournisseur (${text.slice(0, 150)})`;
      await this.record(request, dateObserved, { body, response: text }, detail);
      throw new ProviderHttpError(this.config.providerName, url, detail);
    }

    // §9.4 — chaque appel est journalise, comme pour toute source externe.
    await this.record(request, dateObserved, { body, response: payload });
    return payload;
  }

  private async record<T>(
    request: LlmRequest<T>,
    dateObserved: string,
    raw: unknown,
    error?: string,
  ): Promise<void> {
    await this.config.audit.record({
      kind: "llm",
      agent: request.agent,
      target: `${this.modelId}#${request.schemaName}`,
      dateObserved,
      raw,
      ...(error === undefined ? {} : { error }),
    });
  }
}

export class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly url: string,
    detail: string,
    readonly status?: number,
  ) {
    super(`${provider} : ${detail}`);
    this.name = "ProviderHttpError";
  }
}

/** `choices[0].message.content` dans la forme OpenAI. */
function extractContent(payload: unknown): string | undefined {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = (choices[0] as { message?: { content?: unknown } }).message
    ?.content;
  return typeof content === "string" && content.trim().length > 0
    ? content
    : undefined;
}

/**
 * Parse du JSON en tolerant les cloture de bloc markdown : plusieurs modeles
 * encadrent leur sortie de ```json malgre une consigne explicite.
 */
function tryParseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
