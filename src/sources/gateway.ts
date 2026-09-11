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
import { redactText } from "../audit/redaction.js";
import { RawEventSchema, type RawEvent } from "../protocol/schema.js";
import { detecterInjection } from "../securite/injection.js";
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

/**
 * Avis de pertinence d'un adaptateur, en ECHEC OUVERT.
 *
 * Un filtre qui leve est un filtre bogue ; s'il ecartait la source, elle
 * disparaitrait sans trace — l'echec muet que cette passerelle existe pour
 * empecher. On prefere une requete de trop, dont l'issue sera journalisee.
 */
export function estPertinent(adapter: SourceAdapter, query: SourceQuery): boolean {
  if (adapter.pertinent === undefined) return true;
  try {
    return adapter.pertinent(query);
  } catch {
    return true;
  }
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

    // Une source hors sujet n'est ni appelee ni journalisee : elle n'a pas ete
    // consultee, et le §9.4 trace les acces, pas les abstentions. Ce n'est pas
    // une source muette au sens d'EP-003 — elle n'avait rien a dire ici.
    const actifs = this.adapters.filter((adapter) => estPertinent(adapter, query));

    // Les adaptateurs sont independants : un fournisseur lent ne doit pas
    // retarder les autres. `allSettled` garantit qu'un echec isole ne fait pas
    // tomber la collecte entiere — une source manquante se documente (§EP-003).
    const outcomes = await Promise.allSettled(
      actifs.map(async (adapter) => ({
        adapter,
        outcome: await adapter.fetch(query),
      })),
    );

    for (const [index, settled] of outcomes.entries()) {
      const adapter = actifs[index];
      if (adapter === undefined) continue;

      if (settled.status === "rejected") {
        // Caviardage EN PLUS de celui de `SourceFetchError`. Un adaptateur peut
        // lever une erreur d'un autre type — `JSON.parse`, une bibliotheque, un
        // `TypeError` — dont le message reprendrait l'URL avec sa clef. Ce champ
        // part dans les incertitudes declarees de l'article, donc sur le site
        // public et dans le depot : c'est le dernier point ou l'on peut encore
        // l'arreter.
        const error = redactText(
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason),
        ).redacted;
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

        // INJECTION INDIRECTE. Le texte d'une source est ecrit par un tiers et
        // sera LU par un agent. Une instruction adressee a un modele — « ignore
        // les instructions precedentes » — n'a rien a faire dans un article
        // sourcé : l'observation est ecartee avant d'atteindre le moindre prompt.
        // Les agregateurs ramenant du texte de n'importe quel site, c'est ici,
        // a la seule entree de toutes les sources, que le controle doit vivre.
        //
        // Le motif, et lui seul, est trace : recopier la charge dans le journal
        // la reinjecterait par le canal meme qui sert a la signaler.
        const injection = detecterInjection(`${parsed.data.source} ${parsed.data.resume}`);
        if (injection !== null) {
          failures.push({
            adapterId: adapter.id,
            error:
              `observation ecartee — tentative d'instruction adressee a un modele ` +
              `detectee dans le texte de la source (motif : ${injection}). Injection ` +
              `indirecte presumee : cette source ne peut pas fonder un article.`,
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
