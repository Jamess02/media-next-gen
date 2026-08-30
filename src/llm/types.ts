/**
 * Frontiere d'abstraction du modele.
 *
 * Les agents dependent de cette interface, jamais du SDK Anthropic directement.
 * Trois consequences voulues :
 *
 *  1. Le pipeline tourne hors ligne (mode `mock`) sans qu'aucun agent ne change.
 *  2. Les regles editoriales se testent sans cle API ni cout.
 *  3. §9.4 : la journalisation d'audit est imposee ICI, au point de passage
 *     unique, plutot que dependre de la discipline de chaque agent.
 */

import type { z } from "zod";

export interface LlmRequest<T> {
  /** Agent appelant. Reporte tel quel dans le journal d'audit (EP-002). */
  agent: string;
  /**
   * Protocole integral (§9.1). Fourni SEPAREMENT des instructions de role
   * parce que c'est le prefixe stable partage par les six agents : c'est lui,
   * et lui seul, qui doit porter le point de cache. Voir anthropic-client.ts.
   */
  protocol: string;
  /** Instructions propres au role — la partie qui varie d'un agent a l'autre. */
  roleInstructions: string;
  /**
   * Concatenation des deux, pour les fournisseurs n'acceptant qu'un seul
   * message systeme (API compatibles OpenAI).
   */
  system: string;
  user: string;
  /** Schema de la reponse attendue. Contraint le modele, puis le valide. */
  schema: z.ZodType<T>;
  schemaName: string;
  /** Profondeur de raisonnement. Le gate du fact-checker merite plus que le reste. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LlmClient {
  /** Identifiant du modele, pour `authors_agents` et le journal d'audit. */
  readonly modelId: string;
  structured<T>(request: LlmRequest<T>): Promise<T>;
}

/** Levee quand la reponse du modele ne satisfait pas le schema demande. */
export class LlmContractError extends Error {
  constructor(
    readonly agent: string,
    readonly schemaName: string,
    readonly detail: string,
  ) {
    super(
      `[${agent}] reponse non conforme au schema "${schemaName}" : ${detail}`,
    );
    this.name = "LlmContractError";
  }
}
