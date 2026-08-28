/**
 * Contrat d'un adaptateur de source externe.
 *
 * Un adaptateur ne connait ni le journal d'audit ni le registre de tiers : il
 * sait seulement interroger son fournisseur et rendre des observations. C'est
 * la passerelle (`gateway.ts`) qui impose la journalisation (§9.4) et la
 * classification en tier (§4). Un adaptateur ne peut donc pas oublier de
 * journaliser, ni s'auto-attribuer un tier avantageux.
 */

import type { RawEvent } from "../protocol/schema.js";

export interface SourceQuery {
  /** Sujet de veille, en langage naturel. */
  topic: string;
  /** §5.1 — fenetre de fraicheur utile. Borne basse, ISO-8601. */
  since: string;
}

/** Ce qu'un adaptateur rend : tout sauf le tier, qui ne lui appartient pas. */
export type Observation = Omit<RawEvent, "tier">;

export interface FetchOutcome {
  observations: readonly Observation[];
  /** Reponse brute du fournisseur, archivee telle quelle (§9.4). */
  raw: unknown;
  /** URL exacte interrogee (§9.4), distincte des URLs des observations. */
  requestedUrl: string;
}

export interface SourceAdapter {
  /** Identifiant stable, repris dans le journal d'audit. */
  readonly id: string;
  /** Ce que la source couvre reellement. Sert aux notes methodologiques. */
  readonly describes: string;
  fetch(query: SourceQuery): Promise<FetchOutcome>;
}
