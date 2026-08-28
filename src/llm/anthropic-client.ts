/**
 * Implementation reelle de `LlmClient` sur l'API Claude.
 *
 * Choix techniques :
 *
 *  - `messages.parse()` + `zodOutputFormat` (sorties structurees) plutot qu'un
 *    `JSON.parse` defensif sur du texte libre. §9.2 exige que le format
 *    d'echange soit le JSON du §7 : autant contraindre le modele a la source
 *    au lieu de le rattraper apres coup.
 *  - Mise en cache du prompt systeme. Le protocole fait plusieurs milliers de
 *    tokens et il est identique pour les six agents ; sans `cache_control` on
 *    le repaierait plein tarif a chaque etape du pipeline. Le prefixe est
 *    stable (le protocole ne varie pas en cours d'execution), donc le cache
 *    tient reellement.
 *  - Chaque appel est journalise (§9.4) : requete, modele, reponse brute.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { AuditLog } from "../audit/audit-log.js";
import { type LlmClient, LlmContractError, type LlmRequest } from "./types.js";

export interface AnthropicLlmClientOptions {
  audit: AuditLog;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

export class AnthropicLlmClient implements LlmClient {
  readonly modelId: string;
  private readonly client: Anthropic;
  private readonly audit: AuditLog;
  private readonly maxTokens: number;

  constructor(options: AnthropicLlmClientOptions) {
    this.modelId = options.model ?? "claude-opus-5";
    this.maxTokens = options.maxTokens ?? 16000;
    this.audit = options.audit;
    // Sans apiKey explicite, le SDK resout ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
    // ou un profil `ant auth login`. On ne code jamais une clef en dur.
    this.client = new Anthropic(
      options.apiKey === undefined ? {} : { apiKey: options.apiKey },
    );
  }

  async structured<T>(request: LlmRequest<T>): Promise<T> {
    const dateObserved = new Date().toISOString();

    try {
      const response = await this.client.messages.parse({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: [
          {
            type: "text",
            text: request.system,
            // Le protocole est le prefixe stable partage par tous les agents.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: request.user }],
        output_config: {
          format: zodOutputFormat(request.schema),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        },
      });

      await this.audit.record({
        kind: "llm",
        agent: request.agent,
        target: `${this.modelId}#${request.schemaName}`,
        dateObserved,
        raw: {
          system_sha_source: "protocole-editorial-v1.md",
          user: request.user,
          stop_reason: response.stop_reason,
          usage: response.usage,
          content: response.content,
        },
      });

      // §Fable/Opus : un refus renvoie un HTTP 200. Toujours verifier stop_reason
      // avant de lire le contenu, sinon on publie du vide sans le savoir.
      if (response.stop_reason === "refusal") {
        throw new LlmContractError(
          request.agent,
          request.schemaName,
          `refus du modele (${response.stop_details?.category ?? "non categorise"})`,
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new LlmContractError(
          request.agent,
          request.schemaName,
          "reponse tronquee (max_tokens atteint) : sortie partielle non publiable",
        );
      }
      if (response.parsed_output === null) {
        throw new LlmContractError(
          request.agent,
          request.schemaName,
          "le modele n'a pas produit de sortie conforme au format demande",
        );
      }

      return response.parsed_output;
    } catch (error) {
      if (error instanceof LlmContractError) throw error;

      // L'echec est archive lui aussi : une correction ulterieure (§6) doit
      // pouvoir remonter a ce qui s'est reellement passe.
      await this.audit.record({
        kind: "llm",
        agent: request.agent,
        target: `${this.modelId}#${request.schemaName}`,
        dateObserved,
        raw: { user: request.user },
        error: describeApiError(error),
      });
      throw error;
    }
  }
}

/** Classes d'erreur typees du SDK, de la plus specifique a la plus generale. */
function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "authentification refusee : verifier ANTHROPIC_API_KEY";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "rate limit atteint";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `requete invalide : ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `echec de connexion : ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `erreur API ${error.status} : ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
