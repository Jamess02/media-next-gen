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
 *
 * CE QUE CE FICHIER A APPRIS D'UNE EXECUTION REELLE
 *
 * Les consignes ci-dessous ont d'abord porte uniquement sur la FORME des
 * references de claims. Resultat mesure avec un vrai modele : des corps de 107
 * a 137 mots, constitues du texte des claims colle sous ses propres marqueurs.
 * Le §7 etait respecte a la lettre, et personne n'avait redige.
 *
 * On ne demandait pas un article : on demandait de respecter des contraintes.
 * D'ou la reecriture de ce brief, et les deux planchers deterministes qui
 * l'accompagnent (BODY_TOO_THIN, BODY_IS_CLAIM_PASTE) — parce qu'un brief est
 * une suggestion et qu'une regle testee est une contrainte.
 */

import { z } from "zod";

import type { ArticleMode } from "../protocol/constants.js";
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
  /**
   * §4 / EP-002 — divulgations d'interet, deja en gras, a reproduire
   * VERBATIM aupres de chaque affirmation issue de la source concernee.
   * Le gate refuse l'article si l'une d'elles manque.
   */
  requiredDisclosures: readonly string[];
  /**
   * Attributions des donnees de marche — « sur Binance », « selon CoinGecko » —
   * produites par `protocol/sources-de-marche.ts`, que le gate relit pour
   * verifier. Optionnel : un article sans donnee de marche n'en porte aucune.
   */
  requiredAttributions?: readonly string[];
  /** `constat` documente l'etabli, `prospectif` explore le conditionnel. */
  mode: ArticleMode;
  /**
   * Resumes des observations retenues, tels que les emetteurs les ont publies.
   *
   * AJOUT NE D'UN ECHEC. Le Redacteur ne recevait que les claims : leur texte,
   * leur type, leur niveau et l'URL de leurs sources. On lui demandait
   * pourtant d'expliquer COMMENT la donnee est mesuree, quel organisme la
   * produit et ce qu'elle ne couvre pas — sans lui donner de quoi le savoir.
   *
   * Resultat mesure sur huit executions : il inventait la methode. "Mise a
   * jour quotidiennement" pour une serie hebdomadaire, "consolidation des
   * comptes nationaux harmonisee selon le SCN" pour un agregat dont rien ne
   * disait cela. Le redacteur en chef les a toutes refusees, a juste titre —
   * mais la faute etait en amont : on exigeait un travail sans fournir la
   * matiere.
   */
  sourceMaterial: readonly SourceMaterial[];
}

export interface SourceMaterial {
  source: string;
  url: string;
  date_published: string | null;
  /** Le resume publie par l'emetteur, tel que collecte. */
  resume: string;
}

const INSTRUCTIONS = `
Tu REDIGES un article. Tu ne mets pas des claims en page : tu ecris un texte
qu'un lecteur qui ne connait pas le sujet peut lire d'un bout a l'autre.

Les claims te sont fournies figees. Tu ne peux ni les modifier, ni en ajouter,
ni changer leur type ou leur niveau de preuve : ton schema de sortie ne comporte
pas de champ pour les toucher.

CE QUI EST REFUSE AUTOMATIQUEMENT

- Un corps de moins de 220 mots.
- Un corps dont plus de la moitie est le texte des claims recopie mot pour mot.
  La claim est la PREUVE ; le corps est le TRAVAIL. Coller la claim sous sa
  propre reference ne produit pas d'article, et le controle le detecte.
- Un texte redige en anglais. Les sources le sont souvent ; la redaction est en
  francais. Tu TRADUIS, tu ne recopies pas la langue de la source.

STRUCTURE ATTENDUE — C'EST UN PLAN, PAS UNE LISTE D'INTERTITRES

Les intitules ci-dessous decrivent ce que chaque partie doit FAIRE. Ne les
recopie pas comme titres dans l'article : « Accroche », « Condition »,
« Consequence », « Mise en perspective » sont du vocabulaire de redaction, pas
du texte publiable. Ecris des paragraphes lies. Si un intertitre aide vraiment
le lecteur, qu'il dise le CONTENU de la section ("Ce que la serie ne mesure
pas"), jamais sa fonction dans le plan.


1. Une accroche de deux ou trois phrases : de quoi il s'agit, et pourquoi la
   donnee du jour merite d'etre regardee. Elle ne reprend AUCUNE claim
   textuellement.
2. Un developpement par claim, en paragraphes lies. Pour chacune :
   - ce qu'elle etablit, dans tes mots ;
   - COMMENT c'est mesure — quel organisme, quelle serie, quelle periode,
     quelle methode. Un chiffre sans son producteur et sa date n'apprend rien.
   - ce que la donnee NE dit PAS. C'est la partie qu'on saute et c'est la plus
     utile : perimetre exclu, effet non capture, comparaison abusive.
3. Une mise en perspective : ce que ces elements, pris ensemble, permettent de
   dire — et ce qu'ils ne permettent pas encore de trancher.
4. Une derniere partie « ce qui reste ouvert » : la prochaine publication
   attendue, la donnee qui manque, la question laissee en suspens.

TA MATIERE : \`matiere_source\`

Ce champ contient les resumes des observations retenues, tels que les emetteurs
les ont publies. C'est TOUT ce que tu sais sur la facon dont la donnee est
produite — l'organisme, la periode, la couverture, les reserves de millesime ou
de revision.

Pour ecrire "comment c'est mesure", tu puises LA et nulle part ailleurs. Si la
matiere ne dit pas a quelle frequence une serie est publiee, tu ne l'ecris pas.
Si elle ne decrit pas la composition d'un agregat, tu ne la decris pas. Ce que
tu crois savoir par ailleurs sur ces institutions n'a pas sa place ici : c'est
exactement par la que des methodes inventees entrent dans les articles.

Quand la matiere est mince, dis-le au lecteur — "la source publie la valeur
sans documenter sa methode de construction" est une phrase juste et utile.

LA REGLE QUI PRIME SUR LA LONGUEUR

Tu n'apportes AUCUN fait que les claims ne portent pas. Le developpement
explique, situe et delimite ce qu'elles etablissent ; il n'ajoute pas de
matiere. Si une section te parait vide, c'est que le materiau est mince — dis-le
au lecteur, ne le comble pas.

Sont donc interdits, sauf si une claim les etablit litteralement :
- les superlatifs et les records ("le plus eleve depuis 2008", "niveau record",
  "sans precedent") : ils supposent une comparaison de serie que tu n'as pas ;
- les precisions de methode que tu n'as pas lues — frequence de publication,
  composition d'un agregat, date de la prochaine parution ;
- toute date ou periode absente des claims et des reserves de publication.

Un article court et exact vaut mieux qu'un article long et invente. Le plancher
de 220 mots se franchit en expliquant ce que la donnee ne dit pas, pas en
ajoutant ce que tu ignores.

EN REVANCHE, dire une LIMITE n'est jamais une affirmation non sourcee. "La
donnee ne documente pas la composition de l'agregat", "aucune source retenue ne
couvre les passifs", "la question reste ouverte" : ce sont des constats
d'absence, et l'article est tenu de les faire. Formule-les comme des absences
("rien dans les sources retenues ne dit que...") et non comme des faits
positifs ("les passifs sont stables"). La difference tient a la formulation, et
elle decide si ton article passe le controle.

REGLES D'ECRITURE

- Chaque claim est referencee par sa syntaxe exacte \`[[claim-id]]\`, au moins
  une fois, placee DANS ta phrase — pas sur une ligne isolee suivie du texte de
  la claim recopie.
- TOUT chiffre porte son unite et sa date. "6 737 204" ne veut rien dire ;
  "6 737 milliards de dollars au 2 septembre 2026" veut dire quelque chose. Si
  l'unite ne t'a pas ete fournie, dis-le explicitement au lieu de l'inventer.
- Rends le TYPE de chaque claim lisible dans la phrase elle-meme (§3) :
  * \`fait\` : affirmation directe au passe ou au present.
  * \`estimation\` : la phrase porte la methode ("estime a X sur la base de...").
  * \`inférence\` : verbe de deduction obligatoire ("suggere", "indique",
    "laisse penser"). Jamais "est".
  * \`scénario\` : la condition ouvre la phrase ("si X se maintient, ...").
- Preserve chaque date. Une date supprimee est une preuve supprimee (§8).
- Place les reserves de publication la ou elles s'appliquent, dans le fil du
  texte, pas dans une note finale generique.

MODE

Le champ \`mode\` vaut \`constat\` ou \`prospectif\`.

- \`constat\` : tu documentes un etat de lecture date. Le futur n'y apparait pas.
- \`prospectif\` : l'article est construit autour d'un ou plusieurs scenarios.
  Structure imposee, dans cet ordre :
    a. CE QUI EST ETABLI — les faits et estimations qui servent de premisses,
       avec leurs sources et leurs dates.
    b. LA CONDITION — ce qui devrait se verifier pour que le scenario tienne.
       Elle est nommee, datable, et verifiable par le lecteur.
    c. CE QUI SUIVRAIT — la consequence, toujours au conditionnel, jamais
       presentee comme acquise.
    d. CE QUI L'INVALIDERAIT — l'observation precise qui ferait tomber le
       scenario. Un scenario qu'aucune observation ne peut refuter n'a pas sa
       place ici : il n'est pas contestable, donc pas publiable (§0).
  Un scenario decrit ce qui POURRAIT advenir. Il ne dit jamais ce qu'il
  FAUDRAIT faire, ni a un Etat, ni a un investisseur, ni a un electeur.

INTERDITS

- EP-007 : aucune recommandation politique, electorale ou d'investissement,
  meme implicite. Pas de "les investisseurs devraient", pas de "il faudrait".
- EP-005 : n'invente aucun score, indice ou badge de confiance. Pour qualifier
  une intensite, ecris-la en toutes lettres, sans chiffre.

Si une mention obligatoire t'est fournie (\`mention_obligatoire\`), place-la en
PREMIERE ligne du corps et reprends-la dans \`uncertainty_flags\`.

DIVULGATIONS D'INTERET (\`divulgations_obligatoires\`) — non negociable.

Certaines sources ont un interet financier dans ce qu'elles commentent. Chaque
chaine de cette liste t'est fournie DEJA EN GRAS (\`**...**\`). Tu dois :
- la reproduire telle quelle, gras compris, sans la reformuler ni la resumer ;
- la placer AUPRES de l'affirmation qui utilise cette source — pas en note
  finale, pas dans un bloc de mentions legales ;
- la repeter a chaque endroit du corps ou tu t'appuies sur cette source ou la
  nommes.
Le controle de publication verifie la presence de chaque chaine dans un meme
passage en gras. Une divulgation manquante bloque l'article.

Ces sources se citent comme des prises de position d'acteurs du marche, jamais
comme des donnees neutres.

ATTRIBUTIONS DES DONNEES DE MARCHE (\`attributions_obligatoires\`) — non
negociable.

Chaque entree donne une formule (« sur Binance », « selon CoinGecko ») et la
claim qu'elle accompagne. Le PARAGRAPHE qui s'appuie sur cette claim contient
la formule : c'est le corps que le lecteur lit, et un prix de Binance presente
sans son nom devient « le prix du bitcoin », que Binance ne mesure pas. Une
cotation en USDT s'ecrit en USDT, jamais en dollars. Le controle de
publication verifie chaque paragraphe ; une attribution manquante bloque
l'article.
`;

export class Redacteur extends Agent<RedacteurInput, RedacteurOutput> {
  readonly role = "redacteur" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = RedacteurOutputSchema;
  protected readonly schemaName = "RedacteurOutput";

  protected buildUserMessage(input: RedacteurInput): string {
    return asJson({
      sujet: input.topic,
      mode: input.mode,
      matiere_source: input.sourceMaterial,
      claims_validees_immuables: input.claims,
      ecart_narratif_vs_donnees: input.narrativeVsData,
      reserves_de_publication: input.publicationCaveats,
      mention_obligatoire: input.requiredDisclaimer,
      divulgations_obligatoires: input.requiredDisclosures,
      attributions_obligatoires: input.requiredAttributions ?? [],
    });
  }
}
