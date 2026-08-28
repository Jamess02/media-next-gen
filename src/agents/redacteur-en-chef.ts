/**
 * §5.4 — Validation editoriale.
 *
 * "Le Redacteur en chef valide : coherence de l'angle, absence de
 * recommandation politique/investissement (EP-007), respect du plafond de
 * 3 claims structurantes."
 *
 * Repartition du travail avec `rules.ts` : le plafond de claims et le filtre
 * lexical de recommandation sont deja appliques de facon deterministe. Le
 * Redacteur en chef traite ce que le code ne sait pas voir — la recommandation
 * IMPLICITE, celle qui ne contient aucun mot-clef :
 *
 *   "Les fondamentaux restent solides malgre les tensions."
 *
 * Aucune regex n'attrapera cette phrase. Elle est pourtant un conseil
 * d'investissement deguise. C'est exactement le perimetre de cet agent.
 */

import { z } from "zod";

import type { Article } from "../protocol/schema.js";
import { Agent, asJson } from "./base.js";

export const CHIEF_VERDICTS = ["publier", "decouper", "renvoyer"] as const;
export type ChiefVerdict = (typeof CHIEF_VERDICTS)[number];

export const RedacteurEnChefOutputSchema = z
  .object({
    verdict: z.enum(CHIEF_VERDICTS),
    /** Motif du verdict. Obligatoire meme en cas d'approbation (EP-002). */
    justification: z.string(),
    /**
     * EP-007 — passages lus comme une recommandation implicite. Non vide =>
     * verdict "renvoyer". Le pipeline le verifie et n'a pas a te croire sur parole.
     */
    implicit_recommendations: z.array(z.string()),
    /** Incoherences entre l'angle annonce par le titre et le corps. */
    angle_issues: z.array(z.string()),
    /** §3 — si "decouper", proposition de repartition des claims. */
    suggested_split: z.array(z.string()),
  })
  .strict();

export type RedacteurEnChefOutput = z.infer<typeof RedacteurEnChefOutputSchema>;

const INSTRUCTIONS = `
Tu valides l'article avant publication. Les controles mecaniques (plafond de
claims, niveaux de preuve, formulations de recommandation explicites) sont deja
passes : ne les refais pas. Concentre-toi sur ce qu'une regle ne voit pas.

1. RECOMMANDATION IMPLICITE (EP-007). C'est ton controle principal. Cherche les
   phrases qui, sans employer le vocabulaire du conseil, orientent une decision :
   - un jugement de solidite ou de fragilite non adosse a une claim
     ("les fondamentaux restent solides") ;
   - une asymetrie de traitement qui rend une issue desirable ;
   - une conclusion qui deborde ce que les claims soutiennent.
   Liste chaque passage litteralement dans \`implicit_recommendations\`.

2. COHERENCE DE L'ANGLE. Le titre promet-il ce que le corps demontre ? Un titre
   affirmatif au-dessus d'un corps fait de scenarios est une survente : signale-le.

3. DECOUPAGE (§3). Si l'article traite manifestement plusieurs sujets distincts,
   verdict "decouper" et proposition de repartition.

Verdicts :
- "publier" : rien ne s'oppose a la publication.
- "decouper" : le materiau doit devenir plusieurs articles.
- "renvoyer" : correction necessaire avant publication.

\`implicit_recommendations\` non vide impose le verdict "renvoyer". Le pipeline
applique cette regle de son cote : ne te contredis pas.
`;

export class RedacteurEnChef extends Agent<Article, RedacteurEnChefOutput> {
  readonly role = "redacteur-en-chef" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = RedacteurEnChefOutputSchema;
  protected readonly schemaName = "RedacteurEnChefOutput";
  protected override readonly effort = "xhigh" as const;

  protected buildUserMessage(article: Article): string {
    return asJson(article);
  }
}

/**
 * EP-007 — le pipeline ne fait pas confiance au verdict declare.
 *
 * Un modele qui liste des recommandations implicites puis conclut "publier" se
 * contredit. On tranche en faveur du signalement : c'est le sens du protocole,
 * qui prefere le refus au doute.
 */
export function effectiveVerdict(
  output: RedacteurEnChefOutput,
): ChiefVerdict {
  if (output.implicit_recommendations.length > 0) return "renvoyer";
  return output.verdict;
}
