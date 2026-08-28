/**
 * Implementation simulee de `LlmClient`. Aucun reseau, aucun cout, deterministe.
 *
 * Point important : le mock valide ses propres reponses avec le MEME schema zod
 * que le client reel. Un scenario de test ne peut donc pas produire une sortie
 * qu'un vrai modele n'aurait pas eu le droit de produire. Sans cette
 * validation, les tests du gate testeraient une fiction.
 *
 * Il journalise aussi ses appels (§9.4) : une execution simulee doit laisser un
 * journal inspectable, sinon on n'a pas verifie la clause, on l'a contournee.
 */

import type { AuditLog } from "../audit/audit-log.js";
import { type LlmClient, LlmContractError, type LlmRequest } from "./types.js";

/** Une reponse scriptee. Recoit la requete, rend la sortie brute a valider. */
export type MockResponder = (request: LlmRequest<unknown>) => unknown;

export interface MockLlmClientOptions {
  audit: AuditLog;
  /** Clef : `${agent}#${schemaName}`, ou `${agent}` en repli. */
  responders: Record<string, MockResponder>;
}

export class MockLlmClient implements LlmClient {
  readonly modelId = "mock-llm";
  private readonly audit: AuditLog;
  private readonly responders: Record<string, MockResponder>;
  /** Nombre d'appels par clef : permet de scripter un 2e passage different. */
  private readonly callCounts = new Map<string, number>();

  constructor(options: MockLlmClientOptions) {
    this.audit = options.audit;
    this.responders = options.responders;
  }

  callCount(key: string): number {
    return this.callCounts.get(key) ?? 0;
  }

  async structured<T>(request: LlmRequest<T>): Promise<T> {
    const specificKey = `${request.agent}#${request.schemaName}`;
    const responder =
      this.responders[specificKey] ?? this.responders[request.agent];

    if (responder === undefined) {
      throw new LlmContractError(
        request.agent,
        request.schemaName,
        `aucune reponse simulee pour "${specificKey}"`,
      );
    }

    this.callCounts.set(specificKey, this.callCount(specificKey) + 1);

    const raw = responder(request as LlmRequest<unknown>);

    await this.audit.record({
      kind: "llm",
      agent: request.agent,
      target: `${this.modelId}#${request.schemaName}`,
      dateObserved: new Date().toISOString(),
      raw: { user: request.user, response: raw },
    });

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmContractError(
        request.agent,
        request.schemaName,
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "<racine>"}: ${i.message}`)
          .join(" ; "),
      );
    }
    return parsed.data;
  }
}
