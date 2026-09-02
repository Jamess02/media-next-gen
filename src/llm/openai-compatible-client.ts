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
  /**
   * Le fournisseur APPLIQUE-t-il reellement `response_format` ?
   *
   * Quand il ne l'applique pas (constate sur Ollama Cloud), le modele ne voit
   * jamais la forme attendue : il faut lui montrer le schema dans le prompt.
   * Quand il l'applique (constate sur Groq), cette copie est inutile — et elle
   * double le poids de la requete, ce qui fait franchir la limite de tokens
   * par minute des paliers gratuits.
   *
   * Faux par defaut : l'hypothese prudente est qu'un fournisseur inconnu
   * n'applique rien. Une requete un peu grosse coute moins cher qu'un pipeline
   * qui echoue au premier agent.
   */
  enforcesSchema?: boolean;
  /** Nouvelles tentatives apres un refus pour quota. 3 par defaut. */
  rateLimitRetries?: number;
  audit: AuditLog;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * Tentatives de reparation apres un echec de validation.
   *
   * 2 par defaut, et pas 1 : mesure sur les modeles du palier gratuit d'Ollama
   * Cloud, une seule reprise ne suffit pas. Ils convergent, mais par etapes —
   * une premiere correction rapproche la forme sans l'atteindre.
   *
   * Le plafond reste bas a dessein : un modele qui n'y arrive pas en trois
   * essais n'y arrivera pas en dix, et chaque tentative renvoie tout
   * l'historique, donc coute de plus en plus cher.
   */
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
      repairAttempts: config.repairAttempts ?? 2,
      enforcesSchema: config.enforcesSchema ?? false,
      rateLimitRetries: config.rateLimitRetries ?? 3,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    };
  }

  async structured<T>(request: LlmRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(request.schema);

    // Le schema est place DANS le prompt, en plus de `response_format`.
    //
    // Ce n'est pas une redondance : plusieurs fournisseurs gratuits acceptent
    // `response_format` sans l'appliquer. Le modele ne voit alors jamais la
    // forme attendue et improvise des noms de champs plausibles — constate sur
    // Ollama Cloud, ou aucun modele du palier gratuit ne respecte le schema
    // transmis par le seul `response_format`.
    //
    // Quand le fournisseur applique reellement la contrainte, cette copie est
    // inoffensive : elle dit la meme chose.
    const messages: ChatMessage[] = [
      { role: "system", content: request.system },
      {
        role: "user",
        content: this.config.enforcesSchema
          ? request.user
          : [
              request.user,
              "",
              "## Forme exacte de ta reponse",
              "",
              "Reponds par un unique objet JSON conforme a ce JSON Schema :",
              "",
              JSON.stringify(jsonSchema),
              "",
              "Regles imperatives :",
              "- Tous les champs marques `required` doivent etre presents, meme vides.",
              "- N'ajoute AUCUNE clef absente du schema : elles seront rejetees.",
              "- Respecte exactement les valeurs des champs `enum`.",
              "- Aucun texte avant ou apres le JSON, aucun bloc de code markdown.",
            ].join("\n"),
      },
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

      // Une reponse tronquee produit du JSON invalide, donc partait en boucle
      // de reparation avec un message trompeur. Le dire explicitement : le
      // remede est d'augmenter max_tokens, pas de reformuler la demande.
      const finish = finishReason(payload);
      if (finish === "length") {
        throw new LlmContractError(
          request.agent,
          request.schemaName,
          `reponse tronquee a ${this.config.maxTokens} tokens de sortie ` +
            `(finish_reason=length) : sortie partielle non publiable`,
        );
      }

      const content = extractContent(payload);
      if (content === undefined) {
        // Cas observe sur les modeles de raisonnement : tout le budget part
        // dans un champ `reasoning` et `content` revient vide.
        lastError =
          "reponse sans contenu textuel exploitable" +
          (hasReasoning(payload) ? " (raisonnement non expose par le fournisseur)" : "");
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
    let response: Response | undefined;
    let text = "";

    // Les paliers gratuits imposent des quotas serres — Groq plafonne a 8000
    // tokens PAR MINUTE, et le pipeline emet cinq appels portant chacun le
    // protocole. Attendre est la reponse correcte : le quota se recharge.
    for (let essai = 0; ; essai += 1) {
      const dateObserved = new Date().toISOString();

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

      text = await response.text();
      if (response.ok) break;

      const attente = retryDelayMs(response, text, essai);
      if (attente === undefined || essai >= this.config.rateLimitRetries) {
        const detail = `HTTP ${response.status} — ${text.slice(0, 300)}`;
        await this.record(request, dateObserved, { body, response: text }, detail);
        throw new ProviderHttpError(
          this.config.providerName,
          url,
          detail,
          response.status,
        );
      }

      // L'attente est journalisee : un pipeline qui ralentit sans explication
      // ressemble a un pipeline en panne.
      await this.record(
        request,
        dateObserved,
        { body, response: text },
        `quota atteint (HTTP ${response.status}) — nouvelle tentative dans ${Math.round(attente / 1000)} s`,
      );
      await new Promise((resolve) => setTimeout(resolve, attente));
    }

    const dateObserved = new Date().toISOString();

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

/**
 * Delai avant nouvelle tentative, ou `undefined` si l'echec n'est pas un
 * probleme de quota.
 *
 * 429 est la reponse standard. Groq emploie aussi 413 pour un depassement de
 * tokens par minute — d'ou la lecture du corps : un 413 signifiant reellement
 * "charge utile trop grosse" ne doit PAS etre rejoue, il echouerait a
 * l'identique indefiniment.
 */
function retryDelayMs(
  response: Response,
  body: string,
  essai: number,
): number | undefined {
  const quota =
    response.status === 429 ||
    ((response.status === 413 || response.status === 503) &&
      /rate.?limit|tokens per minute|TPM|quota|too many requests/i.test(body));
  if (!quota) return undefined;

  // Le fournisseur sait mieux que nous quand reessayer.
  const entete = response.headers.get("retry-after");
  if (entete !== null) {
    const secondes = Number(entete);
    if (Number.isFinite(secondes) && secondes >= 0) {
      return Math.min(secondes * 1000, 70_000);
    }
    const date = Date.parse(entete);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 70_000);
    }
  }

  // Certains fournisseurs indiquent le delai dans le corps ("try again in 6.5s").
  const indique = /in\s+([\d.]+)\s*s/i.exec(body);
  if (indique?.[1] !== undefined) {
    return Math.min(Number(indique[1]) * 1000 + 500, 70_000);
  }

  // Repli : progression jusqu'a un peu plus d'une minute, car les quotas les
  // plus courants se rechargent a la minute.
  return [5_000, 20_000, 65_000][essai] ?? 65_000;
}

function finishReason(payload: unknown): string | undefined {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : undefined;
}

function hasReasoning(payload: unknown): boolean {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const reasoning = (choices[0] as { message?: { reasoning?: unknown } }).message
    ?.reasoning;
  return typeof reasoning === "string" && reasoning.length > 0;
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
