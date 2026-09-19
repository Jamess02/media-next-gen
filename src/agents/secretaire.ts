/**
 * SECRETAIRE DE REDACTION — depouille les relectures, repartit les consignes.
 *
 * Dependances : `zod`, deja utilise par tous les contrats. Internes : la classe
 * `Agent` et les roles du protocole.
 *
 * CE QU'IL REPARE. Les notes laissees par les relecteurs partaient toutes au
 * Redacteur. Or « chercher des informations supplementaires sur l'Afghanistan »
 * ne s'adresse pas a lui : il ecrit a partir de la matiere qu'on lui donne, il
 * ne va pas en chercher. Cette consigne tombait dans le vide, et l'editeur
 * pouvait croire sa remarque prise en compte.
 *
 * POURQUOI UN AGENT, ET NON UNE TABLE DE MOTS-CLES. Decider qu'une remarque
 * vise la collecte plutot que l'ecriture est un jugement editorial. Une table
 * se tromperait sur « il faudrait plus de sources sur le ton employe », et une
 * consigne mal aiguillee est pire qu'une consigne perdue : elle arrive chez
 * quelqu'un qui ne peut rien en faire, et prend la place d'une vraie.
 *
 * LE GARDE-FOU EST DU CODE. Chaque consigne doit citer la note DONT ELLE VIENT,
 * et `filtrerConsignes` rejette celles dont l'origine ne se retrouve dans
 * aucune note transmise. Sans ce filtre, le secretaire pourrait fabriquer une
 * demande que personne n'a ecrite et la presenter comme une consigne de
 * l'editeur — la faute la plus grave que cet agent puisse commettre, parce
 * qu'elle est invisible en aval.
 *
 * CE QU'IL NE FAIT PAS. Il n'ecrit pas, ne collecte pas, ne juge aucune claim.
 * Il lit des remarques humaines et dit a qui elles s'adressent.
 */

import { z } from "zod";

import { Agent, asJson } from "./base.js";

/**
 * Qui peut recevoir une consigne.
 *
 * Enumeration FERMEE : sans elle, le secretaire inventerait des destinataires
 * et la consigne n'arriverait nulle part.
 *
 * ELLE NE LISTE QUE LES AGENTS REELLEMENT CABLES, et un test l'exige. Declarer
 * un destinataire que personne ne sert recreerait le probleme meme que cet
 * agent corrige : une consigne produite, aiguillee, puis perdue — avec en plus
 * l'apparence d'avoir ete traitee.
 *
 * ABSENTS POUR CETTE RAISON : le fact-checker et le redacteur en chef, dont les
 * entrees ne portent pas encore de consignes ; l'Investigateur, dont le travail
 * se repartit entre deux agents distincts — le plan et les chapitres — et dont
 * le cablage demande d'etre traite pour lui-meme ; le secretaire, qui ne se
 * donne pas d'ordres ; et l'Editeur, qui n'ecrit rien et applique le controle
 * final.
 */
export const DESTINATAIRES_DE_CONSIGNE = [
  "veilleur",
  "analyste",
  "redacteur",
  "investigateur",
] as const;

export type DestinataireDeConsigne = (typeof DESTINATAIRES_DE_CONSIGNE)[number];

export const ConsigneRepartieSchema = z
  .object({
    destinataire: z.enum(DESTINATAIRES_DE_CONSIGNE),
    /** La demande, reformulee pour celui qui la recevra. */
    consigne: z.string().trim().min(1),
    /** La note dont elle vient, citee. Verifiee par `filtrerConsignes`. */
    origine: z.string().trim().min(1),
  })
  .strict();

export const SecretaireOutputSchema = z
  .object({ consignes: z.array(ConsigneRepartieSchema) })
  .strict();

export type ConsigneRepartie = z.infer<typeof ConsigneRepartieSchema>;
export type SecretaireOutput = z.infer<typeof SecretaireOutputSchema>;

export interface SecretaireInput {
  /** Les notes de relecture, la plus recente d'abord. */
  notes: readonly string[];
}

/**
 * Longueur minimale d'une citation d'origine.
 *
 * « sur » se retrouve dans n'importe quelle note : une origine de trois lettres
 * ne rattache la consigne a rien, et laisserait passer une invention deguisee
 * en citation.
 */
const ORIGINE_MIN = 12;

const normaliser = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Ne garde que les consignes RATTACHEES a une note reellement transmise.
 *
 * Une citation PARTIELLE suffit : recopier une note entiere n'a rien d'evident
 * pour un modele, et exiger l'egalite stricte ferait tomber des consignes
 * legitimes. Ce qui compte est que l'extrait vienne d'une note.
 */
export function filtrerConsignes(
  notes: readonly string[],
  brut: SecretaireOutput,
): ConsigneRepartie[] {
  const foin = notes.map(normaliser);

  return brut.consignes.filter((c) => {
    const origine = normaliser(c.origine);
    if (origine.length < ORIGINE_MIN) return false;
    return foin.some((note) => note.includes(origine));
  });
}

export const INSTRUCTIONS_SECRETAIRE = `
Tu depouilles les observations laissees par des relecteurs HUMAINS en validant
des articles, et tu dis a QUEL AGENT chacune s'adresse.

Tu n'ecris aucun article, tu ne collectes rien, tu ne juges aucune affirmation.
Tu lis des remarques et tu les aiguilles.

LES DESTINATAIRES, et ce dont chacun s'occupe :

- veilleur : la COLLECTE et la selection des sources. « chercher des sources
  sur tel pays », « remonter a l'emetteur plutot qu'a la presse », « couvrir
  telle zone geographique ». Il choisit ce qui entre dans le materiau.
- analyste : les AFFIRMATIONS et les chiffres. « ce niveau de preuve est
  genereux », « il manque la periode couverte », « ce chiffre demande une
  unite ». Il decide ce qui est mesure et comment c'est type.
- redacteur : l'ECRITURE. « trop court », « developper les consequences »,
  « expliquer comment la donnee est mesuree ». Il met en forme ce qui existe
  deja dans le materiau, il ne va rien chercher.
- investigateur : le format LONG. Meme regime de preuve que le redacteur, mais
  pour les enquetes : structure des chapitres, contradictoire, echeances a
  nommer. Une remarque sur la longueur ou sur ce qui manque a une enquete lui
  revient.

Une remarque qui ne vise aucun de ces quatre agents — sur la verification ou
sur l'angle, par exemple — ne se transmet pas : elle n'aurait nulle part ou
aller. Laisse-la de cote plutot que de la ranger de force.

REGLES, et elles sont strictes :

1. CHAQUE consigne cite son ORIGINE : un extrait de la note dont elle vient,
   recopie tel quel. Une consigne dont l'origine ne se retrouve pas dans les
   notes fournies est REJETEE par le pipeline, avant d'atteindre quiconque.
2. N'INVENTE JAMAIS UNE CONSIGNE. Tu ne rends que ce que les notes demandent.
   Ajouter une demande que personne n'a ecrite, et la presenter comme venant de
   l'editeur, est la faute la plus grave possible ici : elle est invisible en
   aval.
3. UNE NOTE PEUT NE CONCERNER PERSONNE. « bon article », « rien a signaler » :
   laisse-la de cote, ne rends aucune consigne pour elle. Une attribution
   forcee produit une consigne creuse qui prend la place d'une vraie.
4. UNE NOTE PEUT CONCERNER PLUSIEURS AGENTS. « trop court et il manque des
   sources sur l'Afghanistan » se repartit entre le redacteur et le veilleur :
   rends alors deux consignes, chacune citant la meme origine.
5. REFORMULE POUR CELUI QUI RECOIT. « pas assez alarmiste » devient, pour le
   redacteur, une demande d'exposer plus nettement les risques que les donnees
   documentent — jamais une invitation a dramatiser au-dela d'elles.
6. UNE CONSIGNE NE LEVE AUCUNE REGLE et n'autorise rien. Les controles de
   publication s'appliquent apres, a l'identique. Une remarque qui demanderait
   d'etre moins exigeant sur les preuves se reformule en demande d'ecriture, ou
   ne se transmet pas.
`;

export class SecretaireDeRedaction extends Agent<SecretaireInput, SecretaireOutput> {
  readonly role = "secretaire-de-redaction" as const;
  protected readonly instructions = INSTRUCTIONS_SECRETAIRE;
  protected readonly outputSchema = SecretaireOutputSchema;
  protected readonly schemaName = "SecretaireOutput";

  protected buildUserMessage(input: SecretaireInput): string {
    return asJson({ notes_de_relecture: input.notes });
  }
}
