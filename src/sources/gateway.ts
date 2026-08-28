/**
 * Passerelle unique vers les sources externes.
 *
 * Tout acces a une source passe par ici, ce qui permet d'imposer, sans compter
 * sur la discipline des adaptateurs :
 *
 *  - §9.4 : journalisation de l'URL exacte, de la date d'observation et de la
 *    reponse brute archivee — y compris en cas d'echec.
 *  - §4 : le tier est (re)calcule depuis le registre de domaines. Ce que
 *    l'adaptateur aurait pu pretendre est ecrase.
 *  - EP-001 : les secondaires eclipsees par une primaire du meme lot sont
 *    signalees, pas supprimees — c'est au Veilleur d'arbitrer, pas a la couche
 *    transport (§5.1 : "Isole explicitement les agregateurs et commentaires
 *    comme sources secondaires").
 */

import type { AuditLog } from "../audit/audit-log.js";
import { RawEventSchema, type RawEvent } from "../protocol/schema.js";
import { classifySource, secondariesShadowedByPrimary } from "./registry.js";
import type { SourceAdapter, SourceQuery } from "./types.js";

export interface CollectionResult {
  events: readonly RawEvent[];
  /** URLs secondaires doublonnees par une primaire disponible (EP-001). */
  shadowedSecondaries: readonly string[];
  /** Sources hors registre : leur tier 3 est un defaut prudent, a signaler. */
  unregisteredUrls: readonly string[];
  /** Adaptateurs en echec. Une source muette n'est pas une source vide. */
  failures: ReadonlyArray<{ adapterId: string; error: string }>;
}

export class SourceGateway {
  constructor(
    private readonly adapters: readonly SourceAdapter[],
    private readonly audit: AuditLog,
  ) {}

  async collect(
    query: SourceQuery,
    agent: string,
  ): Promise<CollectionResult> {
    const events: RawEvent[] = [];
    const unregisteredUrls: string[] = [];
    const failures: Array<{ adapterId: string; error: string }> = [];

    // Les adaptateurs sont independants : un fournisseur lent ne doit pas
    // retarder les autres. `allSettled` garantit qu'un echec isole ne fait pas
    // tomber la collecte entiere — une source manquante se documente (§EP-003).
    const outcomes = await Promise.allSettled(
      this.adapters.map(async (adapter) => ({
        adapter,
        outcome: await adapter.fetch(query),
      })),
    );

    for (const [index, settled] of outcomes.entries()) {
      const adapter = this.adapters[index];
      if (adapter === undefined) continue;

      if (settled.status === "rejected") {
        const error =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        failures.push({ adapterId: adapter.id, error });
        await this.audit.record({
          kind: "source",
          agent,
          target: adapter.id,
          dateObserved: new Date().toISOString(),
          raw: { query },
          error,
        });
        continue;
      }

      const { outcome } = settled.value;

      await this.audit.record({
        kind: "source",
        agent,
        target: outcome.requestedUrl,
        dateObserved: new Date().toISOString(),
        raw: outcome.raw,
      });

      for (const observation of outcome.observations) {
        const classification = classifySource(observation.url);
        if (!classification.registered) {
          unregisteredUrls.push(observation.url);
        }

        // Le tier vient du registre, jamais de l'adaptateur (§4).
        const candidate = { ...observation, tier: classification.tier };
        const parsed = RawEventSchema.safeParse(candidate);
        if (!parsed.success) {
          failures.push({
            adapterId: adapter.id,
            error: `observation non conforme au §5.1 : ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(" ; ")}`,
          });
          continue;
        }
        events.push(parsed.data);
      }
    }

    return {
      events,
      shadowedSecondaries: secondariesShadowedByPrimary(
        events.map((e) => e.url),
      ),
      unregisteredUrls,
      failures,
    };
  }
}
