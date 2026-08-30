/**
 * §7 — Schema JSON de l'article : le contrat d'echange entre agents.
 *
 * §9.2 : "Le format d'echange entre agents est TOUJOURS le JSON du §7, jamais
 * du texte libre non structure." Ce fichier rend cette phrase executable.
 *
 * Ce module decrit la FORME d'un document, pas sa PUBLIABILITE. Un document
 * peut etre conforme au schema et rester interdit de publication (niveau de
 * preuve insuffisant, claim promue en fait, etc.) : ces regles vivent dans
 * `rules.ts` et sont appliquees par le fact-checker.
 *
 * Les schemas sont `.strict()` : un agent qui inventerait un champ hors §7
 * echoue immediatement au lieu de faire passer une donnee non contractuelle
 * en aval.
 */

import { z } from "zod";
import {
  CLAIM_TYPES,
  CHANGELOG_TYPES,
  EVIDENCE_LEVELS,
  SOURCE_TIERS,
} from "./constants.js";
import { checkCitableUrl, explainUrlRejection } from "./url.js";

/** ISO-8601. La date fait partie de la preuve (§8), jamais un champ cosmetique. */
const isoDate = z.iso.datetime({ offset: true });

/**
 * URL de source. PAS `z.url()` : celui-ci accepte `javascript:`, `data:` et
 * `file:`, qui deviennent du XSS une fois rendus en lien markdown sur le site
 * (§5.4). Voir `url.ts` pour le detail.
 */
const citableUrl = z.string().superRefine((value, ctx) => {
  const check = checkCitableUrl(value);
  if (!check.ok) {
    ctx.addIssue({ code: "custom", message: explainUrlRejection(check) });
  }
});

export const SourceRefSchema = z
  .object({
    url: citableUrl,
    tier: z.literal(SOURCE_TIERS),
    date_observed: isoDate,
    date_published: isoDate.nullable(),
  })
  .strict();

export const ClaimSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    type: z.enum(CLAIM_TYPES),
    evidence_level: z.literal(EVIDENCE_LEVELS),
    sources: z.array(SourceRefSchema),
  })
  .strict();

export const EditorialNotesSchema = z
  .object({
    /** §EP-003 — l'incertitude doit etre explicite et portee jusqu'au rendu. */
    uncertainty_flags: z.array(z.string()),
    /** §3 — claims rejetees par le fact-checker, avec le motif du rejet. */
    excluded_claims: z.array(z.string()),
  })
  .strict();

export const ChangelogEntrySchema = z
  .object({
    date: isoDate,
    type: z.enum(CHANGELOG_TYPES),
    description: z.string().min(1),
  })
  .strict();

/**
 * L'article complet.
 *
 * Note de lecture : le tableau `claims` contient les claims STRUCTURANTES au
 * sens du §3 (celles que le corps reference par id et que le fact-checker
 * evalue). Le plafond de 3 s'y applique donc directement.
 */
export const ArticleSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    published_at: isoDate,
    revised_at: isoDate.nullable(),
    authors_agents: z.array(z.string().min(1)).min(1),
    claims: z.array(ClaimSchema),
    body: z.string(),
    editorial_notes: EditorialNotesSchema,
    changelog: z.array(ChangelogEntrySchema),
  })
  .strict()
  .superRefine((article, ctx) => {
    // Un id de claim duplique casse la relation body -> claim : le lecteur ne
    // peut plus savoir quelle preuve soutient quelle affirmation.
    const seen = new Set<string>();
    for (const [index, claim] of article.claims.entries()) {
      if (seen.has(claim.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["claims", index, "id"],
          message: `id de claim duplique : ${claim.id}`,
        });
      }
      seen.add(claim.id);
    }
  });

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type EditorialNotes = z.infer<typeof EditorialNotesSchema>;
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;
export type Article = z.infer<typeof ArticleSchema>;

/* -------------------------------------------------------------------------
 * Etapes amont : le format de sortie du Veilleur (§5.1)
 * ---------------------------------------------------------------------- */

/**
 * §5.1 — "Sort un evenement brut au format JSON :
 * {source, url, date_observed, type, resume}".
 */
export const RawEventSchema = z
  .object({
    source: z.string().min(1),
    url: citableUrl,
    date_observed: isoDate,
    date_published: isoDate.nullable(),
    tier: z.literal(SOURCE_TIERS),
    type: z.string().min(1),
    resume: z.string().min(1),
  })
  .strict();

export type RawEvent = z.infer<typeof RawEventSchema>;

/**
 * Sortie de l'Analyste (§5.2) : une claim candidate, avant passage au gate.
 * `evidence_level` y est une PROPOSITION, que le fact-checker recalcule et
 * peut abaisser (§5.2 : "Attribue un niveau de preuve a chaque affirmation
 * candidate").
 */
export const CandidateClaimSchema = ClaimSchema.extend({
  /** Justification de l'analyste : pourquoi ce niveau, sur quelle base. */
  rationale: z.string().min(1),
}).strict();

export type CandidateClaim = z.infer<typeof CandidateClaimSchema>;
