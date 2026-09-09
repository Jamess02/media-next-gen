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
    /**
     * Affirmations du CORPS que les claims ne soutiennent pas.
     *
     * SIGNALEMENT, PAS VETO — et ce choix a ete corrige apres mesure.
     *
     * Ce champ a d'abord impose le verdict "renvoyer", comme
     * `implicit_recommendations`. Resultat sur seize executions reelles : zero
     * article publie. En relisant les motifs, une bonne moitie visait des
     * enonces d'ABSENCE ("aucun detail n'est fourni sur la composition",
     * "une ventilation serait necessaire") — c'est-a-dire exactement ce que le
     * brief de redaction EXIGE, et exactement ce que ces instructions disent de
     * ne pas signaler.
     *
     * Le modele ne tient pas la distinction. C'est une limite de jugement, pas
     * un defaut de formulation : une consigne "signale X mais pas Y" se degrade
     * en "signale tout" quand la frontiere demande de l'appreciation.
     *
     * EP-007 reste un veto parce que c'est une ligne rouge du protocole et que
     * le faux positif y est le sens du refus. "Affirmation non soutenue" est
     * une question de degre : lui donner force de loi revenait a confier un
     * veto a un signal bruyant. Ces passages remontent donc au relecteur
     * humain, qui tranche — c'est precisement ce que la relecture existe pour
     * faire.
     *
     * Nee d'une execution reelle. En exigeant un article plus long, on a obtenu
     * un corps de 298 mots — un vrai progres sur les 107 precedents — dans
     * lequel le modele avait comble l'espace neuf avec un « niveau le plus
     * eleve depuis la crise de 2008 », un « rapport mensuel » (la serie est
     * hebdomadaire) et une date de trimestre fausse. Aucune de ces
     * affirmations ne figurait dans une claim, donc aucune n'etait sourcee.
     *
     * Demander plus de redaction sans fermer cette porte revient a demander
     * plus d'inventions, et un texte long et faux est pire qu'un texte court.
     */
    unsupported_assertions: z.array(z.string()),
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

1. RECOMMANDATION IMPLICITE (EP-007). C'est ton controle principal, et il a un
   PERIMETRE PRECIS : l'investissement, le vote, et l'action publique. Cherche
   les phrases qui, sans employer le vocabulaire du conseil, orientent une
   decision dans l'un de ces trois domaines :
   - un jugement de solidite ou de fragilite non adosse a une claim
     ("les fondamentaux restent solides", "le risque parait maitrise") ;
   - une asymetrie de traitement qui rend une issue desirable ou redoutable ;
   - une conclusion qui deborde ce que les claims soutiennent et qui suggere
     comment se positionner.

   NE SIGNALE PAS ce qui releve de la METHODE et non de l'action :
   - "cette donnee merite d'etre suivie", "il faudra une serie plus longue pour
     conclure", "une ventilation detaillee serait necessaire a l'analyse". Ces
     phrases disent les limites du travail, elles ne conseillent personne ;
   - la mention d'une prochaine publication attendue, tant qu'elle ne dit pas
     quoi faire en l'attendant.
   Un article qui documente ses propres insuffisances fait son travail. EP-007
   interdit de conseiller une ACTION, pas d'annoncer une incertitude.
   Liste chaque passage litteralement dans \`implicit_recommendations\`.

2. AFFIRMATIONS NON SOUTENUES. Le corps n'apporte AUCUN fait NOUVEAU que les
   claims ne portent pas.

   Ne signale QUE les enonces presentes comme des faits verifiables sur le
   monde, et dont aucune claim ni aucun drapeau d'incertitude de cet article ne
   fournit la matiere. Typiquement :
   - les superlatifs et les records ("le plus eleve depuis...", "niveau record",
     "sans precedent") : ils supposent une comparaison de serie que les claims
     ne contiennent presque jamais ;
   - les precisions de METHODE inventees — frequence reelle de publication,
     composition d'un agregat, date annoncee de la prochaine parution ;
   - les faits chiffres, dates, periodes ou perimetres absents des claims ;
   - une consequence presentee comme observee alors qu'elle est deduite.

   NE SIGNALE PAS — ce sont des exigences de redaction, pas des affirmations :
   - les enonces sur l'ABSENCE d'information ("la donnee ne dit rien de la
     composition", "aucune source ne documente les passifs", "ce point n'est pas
     couvert"). Dire ce qu'on ne sait pas est le contraire d'affirmer sans
     preuve, et l'article est TENU de le faire ;
   - la section "ce qui reste ouvert" quand elle enonce des questions ou des
     incertitudes, et non un calendrier ou un chiffre precis ;
   - les reserves de methode qui figurent deja dans les drapeaux d'incertitude
     de l'article (revisions possibles, retards de publication, perimetre
     partiel) : elles y sont, donc elles sont soutenues ;
   - les phrases de definition, de rappel de contexte general ou de prudence,
     qui n'avancent aucun fait nouveau.

   Le test est simple : cette phrase pretend-elle apprendre au lecteur quelque
   chose de VRAI sur le monde, que rien dans l'article n'etablit ? Si oui,
   signale-la. Si elle dit une limite, une incertitude ou une question, non.
   Liste chaque passage litteralement dans \`unsupported_assertions\`.

3. COHERENCE DE L'ANGLE. Le titre promet-il ce que le corps demontre ? Un titre
   affirmatif au-dessus d'un corps fait de scenarios est une survente : signale-le.

4. DECOUPAGE (§3). Si l'article traite manifestement plusieurs sujets distincts,
   verdict "decouper" et proposition de repartition.

Verdicts :
- "publier" : rien ne s'oppose a la publication.
- "decouper" : le materiau doit devenir plusieurs articles.
- "renvoyer" : correction necessaire avant publication.

\`implicit_recommendations\` non vide impose le verdict "renvoyer". Le pipeline
applique cette regle de son cote : ne te contredis pas.

\`unsupported_assertions\` n'impose rien : ces passages sont transmis au
relecteur humain, qui tranche. Renseigne-le honnetement — ni par exces, pour ne
pas noyer les vrais problemes, ni par complaisance.
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
  // `unsupported_assertions` n'est PAS un veto : voir le commentaire du champ.
  // Mesure a l'appui, ce modele y range aussi bien des methodes inventees que
  // des enonces d'absence legitimes. Les passages remontent au relecteur.
  return output.verdict;
}
