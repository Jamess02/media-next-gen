/**
 * Resolution du fournisseur LLM.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import {
  FREE_PROVIDERS,
  ProviderUnavailable,
  describeProviders,
  resolveProvider,
} from "../src/llm/providers.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "providers-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const resolve = (provider: string, env: NodeJS.ProcessEnv) =>
  resolveProvider({
    provider: provider as never,
    audit: new AuditLog({ dir: workDir }),
    responders: {},
    env,
  });

describe("resolution", () => {
  it("rend le client simule par defaut, sans aucune clef", () => {
    const { client } = resolve("mock", {});
    expect(client.modelId).toBe("mock-llm");
  });

  it("construit un client pour un fournisseur gratuit avec sa clef", () => {
    const { client } = resolve("groq", { GROQ_API_KEY: "k" });
    expect(client.modelId).toBe("groq/llama-3.3-70b-versatile");
  });

  it("respecte MEDIA_MODEL", () => {
    const { client } = resolve("groq", {
      GROQ_API_KEY: "k",
      MEDIA_MODEL: "autre-modele",
    });
    expect(client.modelId).toBe("groq/autre-modele");
  });

  it("n'exige aucune clef pour un serveur local", () => {
    const { client } = resolve("ollama", {});
    expect(client.modelId).toMatch(/^ollama\//);
  });

  it("refuse un fournisseur dont la clef manque, en indiquant ou l'obtenir", () => {
    try {
      resolve("gemini", {});
      expect.unreachable("aurait du lever");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderUnavailable);
      expect((error as Error).message).toMatch(/GEMINI_API_KEY absente/);
      expect((error as Error).message).toMatch(/aistudio\.google\.com/);
    }
  });

  it("traite une clef vide comme absente", () => {
    expect(() => resolve("groq", { GROQ_API_KEY: "  " })).toThrow(
      ProviderUnavailable,
    );
  });

  it("refuse un nom de fournisseur inconnu en listant les valides", () => {
    expect(() => resolve("chatgpt", {})).toThrow(/Fournisseur inconnu/);
  });

  it("refuse anthropic sans clef, en orientant vers les gratuits", () => {
    expect(() => resolve("anthropic", {})).toThrow(/fournisseur gratuit/);
  });
});

describe("avertissements de portee", () => {
  it("previent qu'un fournisseur gratuit ne teste pas anthropic-client.ts", () => {
    const { notices } = resolve("groq", { GROQ_API_KEY: "k" });
    expect(notices.join(" ")).toMatch(/anthropic-client\.ts n'est PAS exerce/);
    expect(notices.join(" ")).toMatch(/pas la qualite editoriale/);
  });

  it("n'avertit de rien en mode simule", () => {
    expect(resolve("mock", {}).notices).toHaveLength(0);
  });
});

describe("catalogue", () => {
  it("expose des URLs de base coherentes", () => {
    for (const [name, spec] of Object.entries(FREE_PROVIDERS)) {
      expect(spec.baseUrl, name).toMatch(/^https?:\/\//);
      // Le client ajoute /chat/completions : la base ne doit pas le contenir.
      expect(spec.baseUrl, name).not.toMatch(/chat\/completions/);
      expect(spec.defaultModel.length, name).toBeGreaterThan(0);
    }
  });

  it("indique quelles clefs manquent dans la liste affichee", () => {
    const listing = describeProviders({ GROQ_API_KEY: "k" });
    expect(listing).toMatch(/groq.*clef presente/);
    expect(listing).toMatch(/GEMINI_API_KEY absente/);
    expect(listing).toMatch(/ollama.*serveur local/);
  });
});
