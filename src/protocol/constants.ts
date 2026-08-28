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
