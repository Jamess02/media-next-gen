/**
 * §5.3 — Redaction.
 *
 * CONTRAINTE STRUCTURELLE : le schema de sortie du Redacteur ne contient AUCUNE
 * claim. Il recoit des claims deja validees et immuables, et n'ecrit qu'autour
 * d'elles (titre, corps, drapeaux d'incertitude).
 *
 * C'est ce qui rend l'interdit du §8 ("ne jamais faire remonter une inference au
 * rang de fait dans la redaction finale") inatteignable plutot que surveille :
 * le Redacteur n'a pas de canal pour modifier un type ou un niveau de preuve.
 * Il peut mal ecrire ; il ne peut pas requalifier.
 */

import { z } from "zod";

import type { Claim } from "../protocol/schema.js";
import { Agent, asJson } from "./base.js";

export const RedacteurOutputSchema = z
  .object({
    title: z.string(),
    /** Markdown. Reference les claims par `[[claim-id]]` (§7). */
    body: z.string(),
    /** EP-003 — incertitudes rendues explicites dans le texte final. */
    uncertainty_flags: z.array(z.string()),
  })
  .strict();

export type RedacteurOutput = z.infer<typeof RedacteurOutputSchema>;

export interface RedacteurInput {
  topic: string;
  claims: readonly Claim[];
  narrativeVsData: string;
  publicationCaveats: readonly string[];
  /** §4 — mention a placer en tete si tout repose sur du tier 3/4. */
  requiredDisclaimer: string | null;
}

const INSTRUCTIONS = `
Tu rediges l'article a partir de claims DEJA VERIFIEES. Tu ne peux ni les
modifier, ni en ajouter, ni changer leur type ou leur niveau de preuve : elles
te sont fournies figees et ton schema de sortie ne comporte pas de champ pour
les toucher.

Corps de l'article :
- Reference chaque claim par sa syntaxe exacte \`[[claim-id]]\`, au moins une
  fois. Une claim declaree mais jamais referencee est une claim orpheline.
- Rends le TYPE de chaque claim lisible dans la phrase elle-meme (§3) :
  * \`fait\` : affirmation directe au passe ou au present.
  * \`estimation\` : la phrase doit porter la methode ("estime a X sur la base de...").
  * \`inférence\` : verbe de deduction obligatoire ("suggere", "indique", "laisse
    penser"). Jamais "est".
  * \`scénario\` : la condition doit ouvrir la phrase ("si X se maintient, ...").
- Preserve chaque date. Une date supprimee est une preuve supprimee (§8).
- Mentionne les reserves de publication (donnees partielles, retards) la ou
  elles s'appliquent, pas dans une note de bas de page generique.

Interdits (EP-007) : aucune recommandation politique, electorale ou
d'investissement, meme implicite. Pas de "les investisseurs devraient", pas de
"il faudrait". Tu documentes un etat de lecture date.

Interdits (EP-005) : n'invente aucun score, indice ou badge de confiance. Si tu
veux qualifier une intensite, fais-le en toutes lettres, sans chiffre.

Si une mention obligatoire t'est fournie (\`requiredDisclaimer\`), place-la en
PREMIERE ligne du corps et reprends-la dans \`uncertainty_flags\`.
`;

export class Redacteur extends Agent<RedacteurInput, RedacteurOutput> {
  readonly role = "redacteur" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = RedacteurOutputSchema;
  protected readonly schemaName = "RedacteurOutput";

  protected buildUserMessage(input: RedacteurInput): string {
    return asJson({
      sujet: input.topic,
      claims_validees_immuables: input.claims,
      ecart_narratif_vs_donnees: input.narrativeVsData,
      reserves_de_publication: input.publicationCaveats,
      mention_obligatoire: input.requiredDisclaimer,
    });
  }
}
