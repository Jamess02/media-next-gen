/**
 * Fournisseurs LLM disponibles.
 *
 * Dependances : `openai-compatible-client.ts`, `anthropic-client.ts`,
 * `mock-client.ts` et `types.ts`. C'est le seul module de `llm/` qui lit
 * `process.env` — meme principe que `sources/catalogue.ts` : les clients
 * recoivent leur clef en parametre, l'environnement n'est lu qu'a un endroit.
 *
 * Les quatre fournisseurs gratuits ci-dessous partagent la meme API compatible
 * OpenAI, donc le meme client. Ce qui les distingue tient en trois champs.
 *
 * AVERTISSEMENT DE QUALITE
 *
 * Un modele gratuit valide la MECANIQUE du pipeline (prompts, schemas, gate,
 * journalisation), pas sa qualite editoriale. Il ne teste pas non plus
 * `anthropic-client.ts`, qui reste le seul fichier du projet jamais execute
 * contre son API reelle. Le README le dit aussi, pour que personne ne prenne un
 * article produit par un 8B local pour une validation du pipeline complet.
 */

import type { AuditLog } from "../audit/audit-log.js";
import { AnthropicLlmClient } from "./anthropic-client.js";
import { MockLlmClient, type MockResponder } from "./mock-client.js";
import { OpenAiCompatibleLlmClient } from "./openai-compatible-client.js";
import type { LlmClient } from "./types.js";

export interface ProviderSpec {
  /** Racine de l'API compatible OpenAI. */
  baseUrl: string;
  /** Modele par defaut, surchargeable par MEDIA_MODEL. */
  defaultModel: string;
  /** Variable d'environnement portant la clef. `null` = aucune clef requise. */
  envKey: string | null;
  /** Ou obtenir une clef gratuite. Affiche quand elle manque. */
  signup: string;
  notes: string;
}

export const FREE_PROVIDERS: Record<string, ProviderSpec> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
    signup: "https://console.groq.com/keys",
    notes: "Palier gratuit genereux, inference tres rapide, modeles 70B.",
  },
  gemini: {
    // Google expose un endpoint compatible OpenAI en plus de son API native.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    envKey: "GEMINI_API_KEY",
    signup: "https://aistudio.google.com/apikey",
    notes: "Palier gratuit sans carte bancaire, bon suivi de schema JSON.",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    envKey: "MISTRAL_API_KEY",
    signup: "https://console.mistral.ai/api-keys",
    notes: "Modeles francophones — pertinent pour un protocole redige en francais.",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    envKey: "OPENROUTER_API_KEY",
    signup: "https://openrouter.ai/keys",
    notes: "Agrege plusieurs modeles gratuits derriere une seule clef.",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    envKey: null,
    signup: "https://ollama.com/download",
    notes:
      "Local, aucune clef, aucune limite. Demande l'installation d'Ollama et " +
      "le telechargement d'un modele (plusieurs Go).",
  },
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "local-model",
    envKey: null,
    signup: "https://lmstudio.ai",
    notes: "Local, serveur compatible OpenAI expose par LM Studio.",
  },
};

export type ProviderName = keyof typeof FREE_PROVIDERS | "anthropic" | "mock";

export interface ResolveProviderInput {
  provider: ProviderName;
  audit: AuditLog;
  responders: Record<string, MockResponder>;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedProvider {
  client: LlmClient;
  /** Avertissements a afficher : qualite attendue, clef manquante, etc. */
  notices: string[];
}

export class ProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

export function resolveProvider(input: ResolveProviderInput): ResolvedProvider {
  const env = input.env ?? process.env;
  const notices: string[] = [];

  if (input.provider === "mock") {
    return {
      client: new MockLlmClient({ audit: input.audit, responders: input.responders }),
      notices,
    };
  }

  if (input.provider === "anthropic") {
    if (!env["ANTHROPIC_API_KEY"]) {
      throw new ProviderUnavailable(
        "ANTHROPIC_API_KEY absente. La renseigner dans .env, ou choisir un " +
          "fournisseur gratuit : --provider=groq | gemini | mistral | openrouter | ollama.",
      );
    }
    return {
      client: new AnthropicLlmClient({
        audit: input.audit,
        ...(env["MEDIA_MODEL"] === undefined ? {} : { model: env["MEDIA_MODEL"] }),
      }),
      notices,
    };
  }

  const spec = FREE_PROVIDERS[input.provider];
  if (spec === undefined) {
    throw new ProviderUnavailable(
      `Fournisseur inconnu : ${input.provider}. Disponibles : ` +
        `${Object.keys(FREE_PROVIDERS).join(", ")}, anthropic, mock.`,
    );
  }

  let apiKey: string | undefined;
  if (spec.envKey !== null) {
    const value = env[spec.envKey];
    if (value === undefined || value.trim().length === 0) {
      throw new ProviderUnavailable(
        `${spec.envKey} absente pour le fournisseur "${input.provider}".\n` +
          `  Clef gratuite : ${spec.signup}\n` +
          `  A placer dans .env (jamais commite).`,
      );
    }
    apiKey = value;
  }

  notices.push(
    "Fournisseur gratuit : la mecanique du pipeline est testee (prompts, schemas, " +
      "gate, journalisation), pas la qualite editoriale.",
    "anthropic-client.ts n'est PAS exerce par ce mode : il reste le seul fichier " +
      "jamais execute contre son API reelle.",
  );

  return {
    client: new OpenAiCompatibleLlmClient({
      providerName: input.provider,
      baseUrl: spec.baseUrl,
      model: env["MEDIA_MODEL"] ?? spec.defaultModel,
      audit: input.audit,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    notices,
  };
}

/** Liste lisible des fournisseurs, pour l'aide en ligne de commande. */
export function describeProviders(env: NodeJS.ProcessEnv = process.env): string {
  const lines = Object.entries(FREE_PROVIDERS).map(([name, spec]) => {
    const ready =
      spec.envKey === null
        ? "serveur local"
        : env[spec.envKey]
          ? "clef presente"
          : `${spec.envKey} absente — ${spec.signup}`;
    return `  ${name.padEnd(11)} ${spec.defaultModel.padEnd(38)} ${ready}`;
  });
  return [
    "Fournisseurs gratuits (--provider=<nom>) :",
    ...lines,
    "",
    "  anthropic   payant, seul mode exercant anthropic-client.ts",
    "  mock        defaut, hors ligne, aucun appel",
  ].join("\n");
}
