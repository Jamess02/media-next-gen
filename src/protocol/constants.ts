/**
 * Valeurs normatives du Protocole Editorial v1.0.
 *
 * Ce fichier est la traduction litterale des sections 2, 3 et 4 du protocole.
 * Il ne contient AUCUNE logique : uniquement les seuils et typologies imposes
 * par le document. Toute regle de gate (fact-checker, redacteur en chef) doit
 * lire ses seuils ici, jamais les redefinir en dur dans son module.
 *
 * Reference : protocole-editorial-v1.md
 */

export const PROTOCOL_VERSION = "1.0.0";

/* -------------------------------------------------------------------------
 * §2 — Niveaux de preuve
 * ---------------------------------------------------------------------- */

export const EVIDENCE_LEVELS = [0, 1, 2, 3, 4] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const EVIDENCE_LEVEL_LABELS: Record<EvidenceLevel, string> = {
  0: "Mention non probante",
  1: "Reference",
  2: "Source liee",
  3: "Preuve directe",
  4: "Reproduction",
};

/**
 * §2 — "un article ne peut etre publie que si CHAQUE claim structurante
 * atteint au minimum le niveau 2 (Source liee)".
 */
export const MIN_PUBLISHABLE_EVIDENCE_LEVEL = 2 satisfies EvidenceLevel;

/* -------------------------------------------------------------------------
 * §3 — Typologie des claims
 * ---------------------------------------------------------------------- */

export const CLAIM_TYPES = [
  "fait",
  "estimation",
  "inférence",
  "scénario",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * §3 / §8 — "un agent ne doit jamais faire remonter une `inference` ou un
 * `scenario` au rang de `fait`". Ces deux types sont donc non promouvables :
 * le fact-checker rejette toute reclassification vers `fait`.
 */
export const NON_PROMOTABLE_TO_FACT: readonly ClaimType[] = [
  "inférence",
  "scénario",
];

/** §3 — "Maximum recommande : 3 claims structurantes par article". */
export const MAX_STRUCTURAL_CLAIMS = 3;

/* -------------------------------------------------------------------------
 * §4 — Typologie des sources (tiers)
 * ---------------------------------------------------------------------- */

export const SOURCE_TIERS = [1, 2, 3, 4, 5] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const SOURCE_TIER_LABELS: Record<SourceTier, string> = {
  1: "Source primaire",
  2: "Donnee publique agregee et sourcee",
  3: "Source secondaire",
  4: "Hypothese / scenario",
  5: "Contexte interne",
};

/**
 * §4 — "Un article dont la ou les claims structurantes reposent uniquement sur
 * du tier 3 ou 4 doit le dire explicitement en tete d'article".
 */
export const WEAK_TIERS: readonly SourceTier[] = [3, 4];

export const WEAK_TIER_DISCLAIMER =
  "Analyse basee sur des sources secondaires, a confirmer.";

/* -------------------------------------------------------------------------
 * §5 — Agents de la chaine de publication
 * ---------------------------------------------------------------------- */

export const AGENT_ROLES = [
  "veilleur",
  // Format long (§5.3). Distinct du Redacteur : il ne traite pas les memes
  // sujets, ne suit pas la meme structure et ne publie pas au meme rythme.
  "investigateur",
  "analyste",
  "redacteur",
  "fact-checker",
  "redacteur-en-chef",
  "editeur",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/* -------------------------------------------------------------------------
 * §6 — Politique de correction
 * ---------------------------------------------------------------------- */

export const CHANGELOG_TYPES = [
  "factuelle",
  "méthodologique",
  "éditoriale",
] as const;
export type ChangelogType = (typeof CHANGELOG_TYPES)[number];

/* -------------------------------------------------------------------------
 * §5.3 — Exigences de redaction
 *
 * Ajoutees apres une execution reelle : le modele rendait des corps de 107 a
 * 137 mots constitues du TEXTE DES CLAIMS colle tel quel. Aucune regle ne s'y
 * opposait, parce que les consignes du Redacteur ne portaient que sur la
 * FORME des references, jamais sur l'existence d'un travail de redaction.
 *
 * Les deux seuils ci-dessous rendent ce collage impossible plutot que
 * deconseille. Ils sont volontairement bas : ils definissent un plancher, pas
 * une cible. Un texte qui les franchit n'est pas bon pour autant.
 * ---------------------------------------------------------------------- */

/** Plancher de longueur du corps. En deca, il n'y a pas d'article. */
export const MIN_BODY_WORDS = 220;

/**
 * Part maximale du corps occupee par le texte des claims recopie mot pour mot.
 *
 * Une claim PEUT etre citee : c'est la preuve, et la citer est legitime. Mais
 * si l'article EST les claims, personne n'a redige. C'est exactement le defaut
 * constate, et c'est ce ratio qui le nomme.
 */
export const MAX_VERBATIM_CLAIM_SHARE = 0.55;

/* -------------------------------------------------------------------------
 * Modes d'article
 * ---------------------------------------------------------------------- */

/**
 * `constat` documente ce qui est etabli. `prospectif` explore ce qui suivrait
 * SI des conditions nommees se verifiaient.
 *
 * Le §3 prevoit deja le type `scénario` ; le mode prospectif ne cree donc
 * aucune permission nouvelle, il rend explicite une intention editoriale et
 * declenche les garde-fous qui vont avec : condition obligatoire dans le
 * texte, declaration en tete d'article, et l'interdit EP-007 inchange — un
 * scenario decrit ce qui pourrait advenir, jamais ce qu'il faudrait faire.
 */
export const ARTICLE_MODES = ["constat", "prospectif", "enquete"] as const;

/**
 * §5.3 — roles des chapitres d une enquete.
 *
 * Vivent dans le PROTOCOLE et non dans l agent : le contrat §7 les porte, et
 * le schema ne doit pas dependre d un agent. Le role est une donnee ; le
 * titre reste libre, pour qu un bon titre ne soit jamais penalise.
 */
export const ROLES_CHAPITRE = [
  "etabli",
  "tension",
  "mecanisme",
  "contradictoire",
  "echeances",
] as const;
export type RoleChapitre = (typeof ROLES_CHAPITRE)[number];
export type ArticleMode = (typeof ARTICLE_MODES)[number];

/**
 * Methode d'obtention d'une composante d'ecart (infographie).
 *
 * `publiee` : contribution officielle, telle que l'organisme la publie.
 * `estimee` : calcul interne, dont la methode est decrite dans la source.
 * `incertaine` : attribution plausible, que les donnees n'etablissent pas.
 *
 * VIVENT ICI, et non dans `infographie/ecart.ts`, pour la raison deja donnee
 * aux roles de chapitre : le contrat §7 les porte, et le schema ne doit pas
 * dependre d'un module de rendu. Les declarer des deux cotes ferait diverger
 * deux listes dont une seule serait verifiee.
 */
export const METHODES_COMPOSANTE = ["publiee", "estimee", "incertaine"] as const;
export type MethodeComposante = (typeof METHODES_COMPOSANTE)[number];

export const PROSPECTIVE_DISCLAIMER =
  "Article prospectif : les scenarios ci-dessous sont des hypotheses " +
  "conditionnelles, pas des previsions. Leurs premisses sont sourcees ; leurs " +
  "consequences ne le sont pas et ne peuvent pas l'etre.";
