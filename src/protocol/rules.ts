/**
 * Regles editoriales opposables (§2, §3, §4, §6, §8).
 *
 * Toutes les fonctions de ce module sont PURES : pas de reseau, pas de LLM,
 * pas de fichier. C'est deliberé. Une regle appliquee par un LLM est une
 * suggestion ; une regle appliquee par une fonction deterministe et testee est
 * une contrainte. Le §9.3 exige un gate bloquant, donc le gate ne doit pas
 * dependre du bon vouloir d'un modele.
 *
 * Le fact-checker LLM (src/agents/fact-checker.ts) ajoute par-dessus un
 * jugement semantique que ces regles ne peuvent pas rendre : il ne les
 * remplace pas, il les complete.
 */

import {
  MAX_STRUCTURAL_CLAIMS,
  MIN_PUBLISHABLE_EVIDENCE_LEVEL,
  NON_PROMOTABLE_TO_FACT,
  WEAK_TIERS,
  WEAK_TIER_DISCLAIMER,
  type ClaimType,
} from "./constants.js";
import type { Article, Claim } from "./schema.js";

export type Severity = "blocking" | "warning";

export interface Violation {
  /** Identifiant stable de la regle, pour tracer un rejet jusqu'au protocole. */
  rule: string;
  /** Section du protocole qui fonde la regle. */
  clause: string;
  severity: Severity;
  message: string;
  /** Chemin dans le document (ex : "claims[1].evidence_level"). */
  path?: string;
}

export interface GateResult {
  passed: boolean;
  violations: Violation[];
}

/**
 * Syntaxe de reference des claims dans le corps de l'article.
 * §7 : "body : string (markdown, reference les claims par id)".
 */
export const CLAIM_REFERENCE_PATTERN = /\[\[([^\]]+)\]\]/g;

export function referencedClaimIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const match of body.matchAll(CLAIM_REFERENCE_PATTERN)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/* -------------------------------------------------------------------------
 * Regles unitaires
 * ---------------------------------------------------------------------- */

/** §2 — chaque claim structurante doit atteindre le niveau 2 (Source liee). */
function ruleEvidenceFloor(article: Article): Violation[] {
  return article.claims.flatMap((claim, i) =>
    claim.evidence_level < MIN_PUBLISHABLE_EVIDENCE_LEVEL
      ? [
          {
            rule: "EVIDENCE_FLOOR",
            clause: "§2",
            severity: "blocking" as const,
            message:
              `La claim "${claim.id}" est au niveau de preuve ${claim.evidence_level}, ` +
              `sous le plancher de publication (${MIN_PUBLISHABLE_EVIDENCE_LEVEL}). ` +
              `Trouver une meilleure source, reformuler en hypothese explicite, ou retirer.`,
            path: `claims[${i}].evidence_level`,
          },
        ]
      : [],
  );
}

/**
 * §2 — le niveau 2 signifie "accessible par une URL verifiable". Une claim
 * annoncee au niveau >= 2 sans aucune source est une declaration de niveau
 * mensongere, pas une simple omission.
 */
function ruleEvidenceLevelIsBacked(article: Article): Violation[] {
  return article.claims.flatMap((claim, i) =>
    claim.evidence_level >= MIN_PUBLISHABLE_EVIDENCE_LEVEL &&
    claim.sources.length === 0
      ? [
          {
            rule: "EVIDENCE_LEVEL_UNBACKED",
            clause: "§2",
            severity: "blocking" as const,
            message:
              `La claim "${claim.id}" se declare au niveau ${claim.evidence_level} ` +
              `mais ne porte aucune source liee. Le niveau annonce n'est pas soutenu.`,
            path: `claims[${i}].sources`,
          },
        ]
      : [],
  );
}

/** §3 — plafond de 3 claims structurantes, au-dela il faut decouper. */
function ruleClaimCeiling(article: Article): Violation[] {
  if (article.claims.length <= MAX_STRUCTURAL_CLAIMS) return [];
  return [
    {
      rule: "CLAIM_CEILING",
      clause: "§3",
      severity: "blocking",
      message:
        `${article.claims.length} claims structurantes pour un plafond de ` +
        `${MAX_STRUCTURAL_CLAIMS}. Le redacteur en chef doit decouper en plusieurs articles.`,
      path: "claims",
    },
  ];
}

/**
 * §3 / EP-001 — un `fait` est "confirme par une source primaire ou une donnee
 * publique", soit un tier 1 ou 2. Un `fait` adosse uniquement a de la presse
 * (tier 3) n'est pas un fait au sens du protocole.
 */
function ruleFactNeedsPrimarySource(article: Article): Violation[] {
  return article.claims.flatMap((claim, i) => {
    if (claim.type !== "fait") return [];
    const hasPrimary = claim.sources.some((s) => s.tier === 1 || s.tier === 2);
    if (hasPrimary) return [];
    return [
      {
        rule: "FACT_NEEDS_PRIMARY_SOURCE",
        clause: "§3 / EP-001",
        severity: "blocking" as const,
        message:
          `La claim "${claim.id}" est typee "fait" sans aucune source de tier 1 ou 2. ` +
          `La requalifier en "estimation" ou "inference", ou remonter a la source primaire.`,
        path: `claims[${i}].type`,
      },
    ];
  });
}

/**
 * §3 — un `fait` dont le TEXTE admet son incompletude se contredit lui-meme.
 *
 * Regle ajoutee apres une execution reelle du pipeline : un modele avait type
 * `fait` au niveau 3 une claim dont le texte disait "le solde observe sur le
 * sous-ensemble de trois partenaires declarants". Le fact-checker LLM ne l'a
 * pas vu, et `FACT_NEEDS_PRIMARY_SOURCE` a laisse passer parce que la source
 * (UN Comtrade) est bien de tier 1.
 *
 * Or le §3 est clair : un chiffre "calcule ou approche a partir de donnees
 * incompletes" est une `estimation`. Le tier de la source ne change rien a la
 * nature de la donnee.
 *
 * La verification est deterministe : on n'a pas besoin de comprendre le texte,
 * seulement de constater qu'il declare lui-meme sa propre incompletude.
 */
const INCOMPLETENESS_MARKERS: readonly RegExp[] = [
  /\bpartiel(?:le|les|s)?\b/i,
  /\bsous[-‑\s]ensemble\b/i,
  /\bincomplet(?:e|es|s)?\b/i,
  /\bestim[ée](?:e|es|s)?\b/i,
  /\bestimation\b/i,
  /\bprojection\b/i,
  /\bprovisoire\b/i,
  /\bpr[ée]liminaire\b/i,
  /\bprovenant d'un [ée]chantillon\b/i,
  // "3 partenaires sur 11", "3/11 declarants" : un denombrement partiel.
  /\b\d+\s*(?:\/|sur)\s*\d+\s+(?:partenaires?|d[ée]clarants?|pays|[ée]tats)\b/i,
];

function ruleFactContradictedByOwnText(article: Article): Violation[] {
  return article.claims.flatMap((claim, i) => {
    if (claim.type !== "fait") return [];
    const marker = INCOMPLETENESS_MARKERS.find((re) => re.test(claim.text));
    if (marker === undefined) return [];

    return [
      {
        rule: "FACT_ADMITS_INCOMPLETENESS",
        clause: "§3",
        severity: "blocking" as const,
        message:
          `La claim "${claim.id}" est typee "fait" alors que son propre texte declare ` +
          `une donnee incomplete ou approchee (${marker.source}). Le §3 en fait une ` +
          `"estimation" : le tier de la source ne change pas la nature de la donnee.`,
        path: `claims[${i}].type`,
      },
    ];
  });
}

/**
 * §4 — si TOUTES les claims structurantes reposent uniquement sur du tier 3/4,
 * l'article doit le declarer explicitement en tete.
 */
function ruleWeakTierDisclosure(article: Article): Violation[] {
  if (article.claims.length === 0) return [];

  const everyClaimIsWeak = article.claims.every(
    (claim) =>
      claim.sources.length > 0 &&
      claim.sources.every((s) => WEAK_TIERS.includes(s.tier)),
  );
  if (!everyClaimIsWeak) return [];

  const declared = article.editorial_notes.uncertainty_flags.some((flag) =>
    flag.toLowerCase().includes("sources secondaires"),
  );
  if (declared) return [];

  return [
    {
      rule: "WEAK_TIER_UNDISCLOSED",
      clause: "§4",
      severity: "blocking",
      message:
        `Toutes les claims reposent sur du tier 3/4. L'article doit porter la mention : ` +
        `"${WEAK_TIER_DISCLAIMER}"`,
      path: "editorial_notes.uncertainty_flags",
    },
  ];
}

/** §7 — le corps doit referencer chaque claim, et ne referencer que des claims reelles. */
function ruleBodyReferences(article: Article): Violation[] {
  const declared = new Set(article.claims.map((c) => c.id));
  const referenced = referencedClaimIds(article.body);
  const violations: Violation[] = [];

  for (const id of declared) {
    if (!referenced.has(id)) {
      violations.push({
        rule: "CLAIM_NOT_REFERENCED",
        clause: "§7",
        severity: "warning",
        message: `La claim "${id}" est declaree mais jamais referencee dans le corps ([[${id}]]).`,
        path: "body",
      });
    }
  }
  for (const id of referenced) {
    if (!declared.has(id)) {
      violations.push({
        rule: "DANGLING_CLAIM_REFERENCE",
        clause: "§7",
        severity: "blocking",
        message: `Le corps reference "[[${id}]]" qui ne correspond a aucune claim declaree.`,
        path: "body",
      });
    }
  }
  return violations;
}

/**
 * §6 — "l'article garde sa date de publication d'origine + une date de
 * revision visible". Une revision anterieure a la publication signale une date
 * ecrasee, ce que le §8 interdit.
 */
function ruleRevisionDate(article: Article): Violation[] {
  if (article.revised_at === null) return [];
  if (Date.parse(article.revised_at) >= Date.parse(article.published_at))
    return [];
  return [
    {
      rule: "REVISION_BEFORE_PUBLICATION",
      clause: "§6 / §8",
      severity: "blocking",
      message:
        `revised_at (${article.revised_at}) precede published_at (${article.published_at}). ` +
        `Une correction ne reecrit jamais la date d'origine.`,
      path: "revised_at",
    },
  ];
}

/**
 * §6 — toute revision doit etre consignee. Un `revised_at` sans entree de
 * changelog est exactement l'ecrasement silencieux que EP-004 interdit.
 */
function ruleRevisionIsLogged(article: Article): Violation[] {
  if (article.revised_at === null || article.changelog.length > 0) return [];
  return [
    {
      rule: "SILENT_REVISION",
      clause: "EP-004 / §6",
      severity: "blocking",
      message:
        "L'article porte une date de revision mais un changelog vide. " +
        "Toute correction est consignee, jamais silencieusement ecrasee.",
      path: "changelog",
    },
  ];
}

/**
 * EP-007 — filtre lexical de recommandation.
 *
 * AVERTISSEMENT DE PORTEE : ce filtre attrape les formulations explicites, pas
 * les recommandations implicites. Il est un garde-fou de derniere ligne, PAS
 * une preuve de conformite a EP-007. Le jugement semantique appartient au
 * redacteur en chef (§5.4). Un texte qui passe ce filtre n'est pas certifie
 * neutre : il est seulement exempt des tournures les plus flagrantes.
 */
const RECOMMENDATION_MARKERS: readonly RegExp[] = [
  /\bnous recommandons\b/i,
  /\bil (?:faut|faudrait) (?:acheter|vendre|investir|voter)\b/i,
  /\b(?:acheter|vendre|shorter)\s+(?:cette|ce|les|des)\b/i,
  /\bopportunit[ée] d'investissement\b/i,
  /\bconseil(?:l[ée])?s? (?:d'investissement|de vote)\b/i,
  /\bles investisseurs devraient\b/i,
  /\bil faut voter\b/i,
  /\bposition (?:longue|courte)\s+recommand/i,
];

function ruleNoRecommendation(article: Article): Violation[] {
  const surfaces: Array<{ text: string; path: string }> = [
    { text: article.title, path: "title" },
    { text: article.body, path: "body" },
    ...article.claims.map((c, i) => ({ text: c.text, path: `claims[${i}].text` })),
  ];

  return surfaces.flatMap(({ text, path }) =>
    RECOMMENDATION_MARKERS.filter((re) => re.test(text)).map((re) => ({
      rule: "RECOMMENDATION_DETECTED",
      clause: "EP-007",
      severity: "blocking" as const,
      message:
        `Formulation de recommandation detectee (${re.source}). Le pipeline documente ` +
        `un etat de lecture date, jamais un conseil d'action.`,
      path,
    })),
  );
}

/* -------------------------------------------------------------------------
 * Gate complet
 * ---------------------------------------------------------------------- */

const DOCUMENT_RULES = [
  ruleEvidenceFloor,
  ruleEvidenceLevelIsBacked,
  ruleClaimCeiling,
  ruleFactNeedsPrimarySource,
  ruleFactContradictedByOwnText,
  ruleWeakTierDisclosure,
  ruleBodyReferences,
  ruleRevisionDate,
  ruleRevisionIsLogged,
  ruleNoRecommendation,
] as const;

/**
 * Applique toutes les regles deterministes. `passed` est faux des qu'une seule
 * violation bloquante existe : les warnings n'empechent pas la publication mais
 * doivent etre remontes a l'humain.
 */
export function runEditorialGate(article: Article): GateResult {
  const violations = DOCUMENT_RULES.flatMap((rule) => rule(article));
  return {
    passed: !violations.some((v) => v.severity === "blocking"),
    violations,
  };
}

/* -------------------------------------------------------------------------
 * §3 / §8 — interdiction de promotion
 * ---------------------------------------------------------------------- */

/**
 * "Un agent ne doit jamais faire remonter une `inference` ou un `scenario` au
 * rang de `fait` dans la redaction finale."
 *
 * Cette regle est relationnelle : elle ne s'evalue pas sur un document isole,
 * mais entre deux etats successifs de la meme claim. C'est pourquoi le pipeline
 * conserve les claims candidates de l'analyste et les compare a la sortie du
 * redacteur, au lieu de faire confiance a l'etat final.
 */
export function detectIllegalPromotions(
  before: ReadonlyArray<{ id: string; type: ClaimType }>,
  after: ReadonlyArray<Claim>,
): Violation[] {
  const previousType = new Map(before.map((c) => [c.id, c.type]));

  return after.flatMap((claim) => {
    const wasType = previousType.get(claim.id);
    if (wasType === undefined) return [];
    if (claim.type !== "fait") return [];
    if (!NON_PROMOTABLE_TO_FACT.includes(wasType)) return [];

    return [
      {
        rule: "ILLEGAL_PROMOTION",
        clause: "§3 / §8",
        severity: "blocking" as const,
        message:
          `La claim "${claim.id}" etait typee "${wasType}" et ressort typee "fait". ` +
          `Une ${wasType} ne peut jamais etre promue au rang de fait.`,
        path: `claims.${claim.id}.type`,
      },
    ];
  });
}
