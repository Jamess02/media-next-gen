/**
 * §5.1 — Collecte.
 *
 * Le Veilleur ne va PAS chercher les donnees lui-meme : la passerelle
 * (`sources/gateway.ts`) l'a deja fait, avec journalisation et classification
 * en tiers. Son travail est l'arbitrage editorial que le §5.1 decrit et qu'une
 * fonction ne peut pas rendre : identifier la source primaire disponible, la
 * preferer a l'article qui la cite, juger la fenetre de fraicheur utile.
 *
 * Cette separation compte : si le Veilleur pouvait interroger le reseau
 * directement, il pourrait contourner la journalisation du §9.4.
 */

import { z } from "zod";

import type { RawEvent } from "../protocol/schema.js";
import type { CollectionResult } from "../sources/gateway.js";
import { Agent, asJson } from "./base.js";

export const VeilleurOutputSchema = z
  .object({
    /** Evenements retenus, source primaire d'abord (EP-001). */
    retained: z.array(
      z.object({
        url: z.string(),
        /** Pourquoi cette source plutot qu'une autre du meme lot. */
        selection_reason: z.string(),
      }),
    ),
    /** §5.1 — agregateurs et commentaires isoles explicitement. */
    set_aside: z.array(
      z.object({
        url: z.string(),
        reason: z.string(),
      }),
    ),
    /** §5.1 — fenetre de fraicheur utile pour ce sujet. */
    freshness_assessment: z.string(),
    /** Signale si aucune source primaire n'est disponible (§4). */
    primary_source_available: z.boolean(),
  })
  .strict();

export type VeilleurOutput = z.infer<typeof VeilleurOutputSchema>;

export interface VeilleurInput {
  topic: string;
  collection: CollectionResult;
}

const INSTRUCTIONS = `
Tu arbitres la collecte. Les evenements bruts te sont fournis deja classes en
tiers par le registre de sources : ne conteste pas un tier, il est derive du
domaine et fait autorite.

Ta tache :
1. Pour chaque information, identifie la source la plus primaire disponible.
   Si une donnee est disponible a la fois chez son emetteur (tier 1/2) et dans
   une reprise de presse (tier 3), retiens l'emetteur et mets la reprise en
   \`set_aside\` avec le motif — c'est EP-001, sans exception.
2. Une source de presse n'est retenue que si elle apporte un element ABSENT des
   sources primaires (une declaration, un contexte), jamais pour confirmer un
   chiffre deja publie a la source.
3. Evalue la fenetre de fraicheur : jusqu'a quand cette observation reste utile,
   et signale les retards de publication connus.
4. \`primary_source_available\` est faux si aucun evenement retenu n'est de
   tier 1 ou 2. C'est une information editoriale, pas un echec.

Le champ \`url\` de tes sorties doit reprendre EXACTEMENT une url fournie en
entree. N'en invente aucune, n'en reformule aucune.
`;

export class Veilleur extends Agent<VeilleurInput, VeilleurOutput> {
  readonly role = "veilleur" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = VeilleurOutputSchema;
  protected readonly schemaName = "VeilleurOutput";

  protected buildUserMessage(input: VeilleurInput): string {
    return asJson({
      sujet: input.topic,
      evenements: input.collection.events,
      indices_pipeline: {
        secondaires_eclipsees_par_une_primaire:
          input.collection.shadowedSecondaries,
        domaines_hors_registre_classes_tier_3_par_defaut:
          input.collection.unregisteredUrls,
        sources_muettes: input.collection.failures,
      },
    });
  }
}

/**
 * Applique la selection du Veilleur au lot d'evenements collectes.
 *
 * L'ORDRE DU VEILLEUR EST CONSERVE, et ce n'est pas un detail de forme.
 *
 * §5.1 charge le Veilleur d'"identifier la source primaire disponible en
 * priorite" : sa hierarchie est une production editoriale, pas du bruit. Or
 * l'etape suivante plafonne a 3 claims structurantes (§3). Rendre les
 * evenements dans leur ordre de collecte — c'est-a-dire l'ordre arbitraire du
 * catalogue de sources — reviendrait a laisser ce plafond trancher au hasard,
 * en ecrasant l'arbitrage qu'on vient justement de demander.
 *
 * Effet de bord voulu : une URL retenue qui n'existe pas dans le lot collecte
 * est ignoree. Un agent ne peut donc pas faire entrer une source en
 * l'inventant, et les doublons sont ecartes.
 */
export function applySelection(
  events: readonly RawEvent[],
  output: VeilleurOutput,
): readonly RawEvent[] {
  const byUrl = new Map(events.map((e) => [e.url, e]));
  const ordered: RawEvent[] = [];
  const seen = new Set<string>();

  for (const { url } of output.retained) {
    const event = byUrl.get(url);
    if (event === undefined || seen.has(url)) continue;
    seen.add(url);
    ordered.push(event);
  }
  return ordered;
}
