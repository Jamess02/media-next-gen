/**
 * §5.2 — Verification (volet analyse).
 *
 * L'Analyste transforme des observations en claims CANDIDATES : typees (§3) et
 * assorties d'un niveau de preuve PROPOSE (§2). "Propose" est le mot important :
 * le fact-checker recalculera ce niveau et pourra l'abaisser. Un agent qui
 * s'attribue son propre niveau de preuve final serait juge et partie.
 *
 * Le champ `rationale` est obligatoire — c'est EP-002 ("methode visible") au
 * niveau de la claim : on doit pouvoir remonter du niveau annonce au
 * raisonnement qui l'a produit.
 */

import { z } from "zod";

import { CLAIM_TYPES, EVIDENCE_LEVELS, SOURCE_TIERS } from "../protocol/constants.js";
import type { RawEvent } from "../protocol/schema.js";
import { Agent, asJson } from "./base.js";

/**
 * Miroir "plat" de CandidateClaimSchema, destine a contraindre le modele.
 * Les schemas du §7 portent des raffinements (`.superRefine`, formats ISO
 * stricts) qui ne se traduisent pas en JSON Schema ; on valide donc en deux
 * temps : forme ici, conformite §7 ensuite via `schema.ts`.
 */
export const AnalysteOutputSchema = z
  .object({
    candidates: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        type: z.enum(CLAIM_TYPES),
        proposed_evidence_level: z.literal(EVIDENCE_LEVELS),
        rationale: z.string(),
        sources: z.array(
          z.object({
            url: z.string(),
            tier: z.literal(SOURCE_TIERS),
            date_observed: z.string(),
            date_published: z.string().nullable(),
          }),
        ),
      }),
    ),
    /** §5.2 — comparaison du narratif mediatique aux donnees observables. */
    narrative_vs_data: z.string(),
    /** §5.2 — revisions, delais de publication, ruptures de serie. */
    publication_caveats: z.array(z.string()),
  })
  .strict();

export type AnalysteOutput = z.infer<typeof AnalysteOutputSchema>;

export interface AnalysteInput {
  topic: string;
  events: readonly RawEvent[];
  freshnessAssessment: string;
}

const INSTRUCTIONS = `
Tu produis des claims CANDIDATES a partir des observations retenues.

Typage (§3), applique strictement :
- \`fait\` : uniquement si une source de tier 1 ou 2 soutient PRECISEMENT
  l'affirmation. Une donnee partielle ou estimee n'est pas un fait.
- \`estimation\` : chiffre calcule ou approche sur donnees incompletes. La
  methode doit apparaitre dans le texte de la claim, pas seulement dans
  \`rationale\`.
- \`inférence\` : conclusion tiree de plusieurs faits, non confirmee directement.
  Le texte doit rendre ce statut lisible ("suggere", "indique que", jamais "est").
- \`scénario\` : projection conditionnelle. Le texte DOIT porter sa condition
  ("si X est maintenu, alors...").

Niveau de preuve propose (§2) : 0 mention non probante, 1 reference citee,
2 source liee par URL verifiable, 3 la source soutient precisement
l'affirmation, 4 le calcul est reproductible par le lecteur (formule + acces
aux donnees brutes). Ne surcote jamais : si tu hesites entre 2 et 3, mets 2.

\`publication_caveats\` : signale les retards de publication, les series
partielles et les revisions. Une donnee partielle presentee sans son caractere
partiel est une faute editoriale, pas un detail.

\`narrative_vs_data\` : ecart entre ce que raconte la presse et ce que montrent
les donnees observables. Si la presse chiffre ce que les donnees ne chiffrent
pas, dis-le.

Contraintes :
- Au plus 3 claims (§3). Si le materiau en porte davantage, garde les 3 plus
  structurantes et ignore le reste.
- Les \`sources\` de chaque claim doivent reprendre exactement des urls et des
  tiers fournis en entree. N'invente rien, ne modifie aucun tier.
- Ne formule aucune recommandation politique ou d'investissement (EP-007).
`;

export class Analyste extends Agent<AnalysteInput, AnalysteOutput> {
  readonly role = "analyste" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = AnalysteOutputSchema;
  protected readonly schemaName = "AnalysteOutput";

  protected buildUserMessage(input: AnalysteInput): string {
    return asJson({
      sujet: input.topic,
      fenetre_de_fraicheur: input.freshnessAssessment,
      observations_retenues: input.events,
    });
  }
}
