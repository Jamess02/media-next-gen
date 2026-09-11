/**
 * Socle commun aux agents LLM du pipeline.
 *
 * §9.1 impose que chaque agent recoive le protocole comme prompt systeme. Le
 * faire ici, dans la classe de base, garantit qu'aucun agent ne peut etre ecrit
 * sans : il n'y a pas de chemin de code qui appelle le modele en sautant
 * `buildSystemPrompt`.
 *
 * Les schemas de sortie des agents sont des objets zod SIMPLES (sans
 * `superRefine`), parce qu'ils sont convertis en JSON Schema pour contraindre
 * le modele. Les invariants relationnels (§2, §3, §8) ne sont donc pas confies
 * au modele : ils sont appliques apres coup par `rules.ts`, de facon
 * deterministe.
 */

import type { z } from "zod";

import type { AuditLog } from "../audit/audit-log.js";
import { redactText } from "../audit/redaction.js";
import type { LlmClient } from "../llm/types.js";
import type { AgentRole } from "../protocol/constants.js";
import { buildSystemPrompt } from "../protocol/system-prompt.js";

export interface AgentContext {
  llm: LlmClient;
  audit: AuditLog;
}

export abstract class Agent<Input, Output> {
  abstract readonly role: AgentRole;
  /** Instructions de role, appliquees PAR-DESSUS le protocole integral. */
  protected abstract readonly instructions: string;
  protected abstract readonly outputSchema: z.ZodType<Output>;
  protected abstract readonly schemaName: string;
  /** Profondeur de raisonnement. Surcharge par les agents a fort enjeu. */
  protected readonly effort: "low" | "medium" | "high" | "xhigh" | "max" =
    "high";

  constructor(protected readonly ctx: AgentContext) {}

  /** Serialise l'entree en message utilisateur. Toujours du JSON (§9.2). */
  protected abstract buildUserMessage(input: Input): string;

  async run(input: Input): Promise<Output> {
    // Les trois formes du prompt systeme sont fournies au client, a lui de
    // choisir : Anthropic exploite la separation pour placer le point de cache
    // sur le protocole, les APIs compatibles OpenAI prennent la concatenation.
    const prompt = buildSystemPrompt({
      role: this.role,
      roleInstructions: this.instructions,
    });

    // CAVIARDAGE DU PROMPT, ICI ET NULLE PART AILLEURS.
    //
    // Cinq archives du 2026-09-09 contiennent l'ancienne clef FRED dans le
    // CORPS de la requete envoyee au modele : elle a ete transmise en clair a
    // un tiers, le fournisseur du modele. Elle arrivait par une URL de source
    // porteuse de `api_key=`, recopiee dans le texte donne a l'agent.
    //
    // FRED n'offre aucune authentification par en-tete : la clef voyage
    // forcement dans l'URL, et le caviardage est la seule barriere. Ce point
    // est le seul par lequel passe TOUT prompt de TOUT agent, quel que soit le
    // fournisseur — c'est donc ici qu'il doit s'appliquer, et pas dans chaque
    // adaptateur, ou il suffirait d'un oubli pour rouvrir la fuite.
    const user = redactText(this.buildUserMessage(input)).redacted;

    return this.ctx.llm.structured({
      agent: this.role,
      protocol: prompt.protocol,
      roleInstructions: prompt.roleInstructions,
      system: prompt.system,
      user,
      schema: this.outputSchema,
      schemaName: this.schemaName,
      effort: this.effort,
    });
  }
}

/** Serialisation lisible et stable des entrees d'agent. */
export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
