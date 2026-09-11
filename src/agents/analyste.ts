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

import {
  CLAIM_TYPES,
  EVIDENCE_LEVELS,
  SOURCE_TIERS,
  type ArticleMode,
} from "../protocol/constants.js";
import { FigureSchema, type RawEvent } from "../protocol/schema.js";
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
        /**
         * Chiffre comparable, quand la claim en porte un (§7 `figure`).
         *
         * ABSENT DE CE SCHEMA, il etait inatteignable : le format de reponse
         * envoye au modele ne le contenait pas, donc aucun modele ne pouvait
         * le produire — et le champ est reste vide en execution reelle alors
         * que tout le reste de la chaine etait pret.
         */
        figure: FigureSchema.optional(),
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
  /** `constat` s'en tient a l'etabli ; `prospectif` exige un scenario conditionne. */
  mode: ArticleMode;
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

CHIFFRE STRUCTURE (\`figure\`) — a renseigner des que la claim porte une mesure.

Quand une claim etablit une valeur chiffree comparable a d'autres, ajoute-lui
un champ \`figure\` :

  { "label": "PIB mondial", "value": 2.92, "unit": "%", "as_of": "2025" }

Le pipeline en construit un TABLEAU classe par ordre decroissant. Tu decides ce
qui est mesure ; tu ne decides pas du rang, qui est calcule.

Regles, et elles sont strictes :
- \`value\` est un NOMBRE, pas une chaine. Il est repris tel que la source le
  publie, sans arrondi de confort : arrondir inventerait ou detruirait de la
  precision (EP-005).
- \`unit\` est obligatoire. Un nombre sans unite ne se compare pas, et un modele
  confronte a un chiffre nu finit par ecrire "(unites)" — c'est arrive.
- \`as_of\` est la periode que couvre la valeur ("2025", "2026-09-02"), pas la
  date a laquelle tu la lis.
- MEME UNITE POUR TOUT L'ARTICLE. Ranger des pourcentages avec des millions de
  dollars n'est pas un classement mais une erreur de categorie, et le controle
  la refuse (EP-006). Si tes mesures ne partagent pas d'unite, ne renseigne
  \`figure\` que sur celles qui se comparent.
- N'invente jamais une valeur pour completer un tableau. Une claim sans mesure
  chiffree n'a pas de \`figure\`, et c'est un cas normal.

UNE CLAIM PORTE SUR LE MONDE, PAS SUR NOTRE APPROVISIONNEMENT.

"Le PIB mondial a cru de 2,92 % en 2025" est une claim. "La serie couvre 4
observations renseignees" et "le jeu de donnees a ete publie puis revise" n'en
sont pas : ce sont des faits sur le tuyau, pas sur l'economie. Leur place est
dans \`publication_caveats\`, jamais dans une claim structurante.

Exception : si la revision ou le retard de publication EST le sujet de
l'article, dis-le dans \`rationale\` — cette claim sera signalee au relecteur.

NE REMPLIS PAS JUSQU'A TROIS.

Le plafond de 3 (§3) est un MAXIMUM, jamais un objectif. Une claim solide vaut
mieux que trois dont deux sont du remplissage. Si le materiau n'en porte
qu'une, n'en produis qu'une : c'est le Redacteur qui fait la longueur de
l'article, pas toi. Fabriquer une deuxieme claim a partir de la meme source
pour atteindre le compte est la faute la plus courante ici.

MODE

Le champ \`mode\` vaut \`constat\` ou \`prospectif\`.

- \`constat\` : tu t'en tiens a ce qui est etabli. Aucun \`scénario\`.
- \`prospectif\` : tu produis AU MOINS UNE claim de type \`scénario\`, et les
  autres claims servent de premisses sourcees. Un scenario n'est publiable que
  s'il remplit les trois conditions suivantes :
    1. sa condition est ECRITE dans le texte de la claim ("si X se maintient au
       dela de...", "tant que Y reste sous..."). Sans condition, ce n'est pas
       un scenario, c'est une prevision — et le controle la refuse ;
    2. sa condition est OBSERVABLE : un lecteur doit pouvoir constater
       lui-meme, a une date future, si elle s'est verifiee ;
    3. ses premisses sont sourcees. Le niveau de preuve d'un scenario porte sur
       ce qui le fonde, pas sur son issue — qui, elle, n'est pas verifiable.
  Un scenario dont aucune observation ne pourrait montrer qu'il est faux n'a
  pas sa place : il n'est pas contestable, donc pas publiable (§0).

DONNEES DE MARCHE — la formule et l'unite font partie du fait.

Les observations de type \`donnee-de-marche\` disent leur perimetre, et le gate
REFUSE une claim qui ne le respecte pas :
- Binance est une plateforme unique. Le texte de la claim ecrit « sur Binance »
  (« le bitcoin a cloture a 76 568,72 USDT sur Binance »), jamais « le prix du
  bitcoin » tout court. Son unite est l'USDT, un stablecoin : ce n'est
  pas le dollar. \`figure.unit\` vaut "USDT", jamais "dollars" ni "$".
- CoinGecko publie un agregat, en dollars, calcule selon sa methodologie. Le
  texte de la claim ecrit « selon CoinGecko ». C'est la source d'un chiffre du
  marche global.
- Ces releves datent tous de minuit UTC : un chiffre Binance et un chiffre
  CoinGecko du meme releve se comparent ; un chiffre d'une autre date, non
  (EP-006).
- Un \`signal-de-marche\` (Yahoo Finance) ne figure JAMAIS dans \`sources\`. Il
  indique ou verifier ; la claim cite l'emetteur d'origine s'il a ete collecte,
  et n'existe pas sinon. Le pipeline rejette d'office une claim adossee au
  seul signal.
- Aucun de ces chiffres ne se lit comme une invitation a acheter, vendre ou
  conserver (EP-007) : « a recule de 2 % sur Binance » est un constat, « un
  point d'entree » est un conseil.

Contraintes :
- Au plus 3 claims (§3). Si le materiau en porte davantage, garde les 3 plus
  structurantes et ignore le reste.
- Les \`sources\` de chaque claim doivent reprendre exactement des urls et des
  tiers fournis en entree. N'invente rien, ne modifie aucun tier.
- Redige les claims EN FRANCAIS, meme quand la source est en anglais. Recopier
  la langue de la source n'est pas de l'analyse.
- Ne formule aucune recommandation politique ou d'investissement (EP-007). Un
  scenario dit ce qui pourrait advenir, jamais ce qu'il faudrait faire.
`;

export class Analyste extends Agent<AnalysteInput, AnalysteOutput> {
  readonly role = "analyste" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = AnalysteOutputSchema;
  protected readonly schemaName = "AnalysteOutput";

  protected buildUserMessage(input: AnalysteInput): string {
    return asJson({
      sujet: input.topic,
      mode: input.mode,
      fenetre_de_fraicheur: input.freshnessAssessment,
      observations_retenues: input.events,
    });
  }
}
