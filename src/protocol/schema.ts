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
  ARTICLE_MODES,
  CLAIM_TYPES,
  ROLES_CHAPITRE,
  CHANGELOG_TYPES,
  EVIDENCE_LEVELS,
  METHODES_COMPOSANTE,
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

/**
 * §7 — forme d'un identifiant de claim.
 *
 * `z.string().min(1)` acceptait n'importe quoi, et cet identifiant est utilise
 * a quatre endroits ou sa forme compte :
 *
 *  - la syntaxe de reference du corps, `[[id]]` : un id contenant `]]` rend le
 *    decoupage ambigu et permet de fabriquer une reference qui n'est pas celle
 *    qu'on croit lire ;
 *  - l'ancre de la page publiee ;
 *  - le rendu markdown de la fiche de preuve ;
 *  - les messages du gate, qui citent l'id litteralement.
 *
 * Liste blanche, comme pour les schemas d'URL : on n'enumere pas les caracteres
 * dangereux, on decrit la forme que le pipeline produit reellement
 * (`claim-1`, `c1`, `claim_2`). Tout le reste est refuse.
 */
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const claimId = z
  .string()
  .regex(
    CLAIM_ID,
    "identifiant de claim invalide : lettres, chiffres, tiret et souligne uniquement (64 max)",
  );

/**
 * Chiffre STRUCTURE porte par une claim, quand elle en porte un.
 *
 * POURQUOI UN CHAMP ET NON UNE EXTRACTION DU TEXTE. Le pipeline sait deja
 * extraire des nombres d'une phrase (`detectUngroundedFigures`), et cette
 * extraction est explicitement une heuristique : elle sert a SIGNALER, jamais a
 * publier. Fonder un tableau dessus reviendrait a publier le resultat d'une
 * devinette, mise en forme comme une donnee.
 *
 * POURQUOI PAS UN TABLEAU ECRIT PAR LE REDACTEUR. Meme raison que pour tout le
 * reste : ce modele a produit un « niveau le plus eleve depuis 2008 » que rien
 * n'etablissait. Lui demander d'aligner des chiffres ajouterait deux facons de
 * se tromper — la valeur et le rang — a une sortie qui a l'apparence de la
 * rigueur. Le champ est rempli par l'Analyste, qui LIT la source ; le tri est
 * fait par du code.
 *
 * `unit` est OBLIGATOIRE. La lecon est deja apprise ailleurs : l'adaptateur
 * FRED publiait des valeurs nues, et un modele a redige « 6 737 204 (unites) »
 * pour combler le trou.
 */
export const FigureSchema = z
  .object({
    /** Libelle de la ligne dans le tableau ("PIB mondial"). */
    label: z.string().min(1),
    value: z.number().finite(),
    /** "%", "millions de dollars"... Sans unite, un nombre ne se compare pas. */
    unit: z.string().min(1),
    /** Periode couverte, telle que la source la designe ("2025", "2026-09-02"). */
    as_of: z.string().min(1),
  })
  .strict();

export type Figure = z.infer<typeof FigureSchema>;

export const ClaimSchema = z
  .object({
    id: claimId,
    text: z.string().min(1),
    type: z.enum(CLAIM_TYPES),
    evidence_level: z.literal(EVIDENCE_LEVELS),
    sources: z.array(SourceRefSchema),
    /**
     * Chiffre comparable porte par la claim, quand elle en porte un.
     * Optionnel : la plupart des claims sont qualitatives.
     */
    figure: FigureSchema.optional(),
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
 * Jour calendaire, ex. « 2026-06-12 ».
 *
 * PAS `isoDate` : une anticipation est figee un JOUR, pas a une milliseconde
 * pres. Exiger un horodatage complet obligerait a inventer une heure, donc une
 * precision que la source n'a pas (EP-005).
 */
const jourCalendaire = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "date attendue au format AAAA-MM-JJ",
});

/** Valeur datee et sourcee. Sans ces deux champs, aucun ecart n'est calculable. */
const ValeurDateeSchema = z
  .object({
    value: z.number().finite(),
    source: z.string().trim().min(1),
    /** `frozen_at` pour une anticipation, `published_at` pour un realise. */
    date: jourCalendaire,
    /** Presente uniquement si elle differe de l'unite de l'indicateur (EP-006). */
    unite: z.string().min(1).optional(),
  })
  .strict();

/**
 * INFOGRAPHIE — l'ENTREE du calcul d'ecart, jamais son resultat.
 *
 * Ni `ecart` ni `residu` ne figurent ici, et c'est deliberé. Ils sont calcules
 * par `infographie/ecart.ts` a partir de ces champs. Si un agent pouvait les
 * DECLARER, il pourrait annoncer un ecart sans rapport avec les chiffres qui
 * l'accompagnent — et le graphique, qui a l'autorite d'un schema, afficherait
 * autre chose que les donnees. C'est le principe deja applique au tableau des
 * chiffres : l'agent decide ce qui est mesure, pas le rang, qui est calcule.
 *
 * Le plafond de trois composantes vient du brief editorial : au-dela, une
 * decomposition cesse d'expliquer et commence a repartir.
 */
export const InfographieSchema = z
  .object({
    /** Identifiant stable, repris d'une edition a l'autre dans le suivi. */
    indicateur: z.string().trim().min(1),
    /** Libelle lisible, affiche au lecteur. */
    libelle: z.string().trim().min(1),
    unite: z.string().trim().min(1),
    anticipe: ValeurDateeSchema,
    realise: ValeurDateeSchema,
    composantes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            value: z.number().finite(),
            method: z.enum(METHODES_COMPOSANTE),
            /** Une contribution non tracable ne peut pas figurer au graphique. */
            source: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(3),
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
    /**
     * Format de l'article. OPTIONNEL, et il doit le rester.
     *
     * Les articles produits avant l'introduction de ce champ n'en portent pas,
     * et le schema est `.strict()` : le rendre obligatoire invaliderait d'un
     * coup tous les brouillons existants, ainsi que les attestations de
     * relecture dont l'empreinte couvre l'article entier.
     *
     * Absent vaut `constat` — le format par defaut du pipeline. Seul
     * `enquete` declenche les regles de structure du format long, ce qui evite
     * de les appliquer retroactivement a des textes qui ne les promettaient
     * pas.
     */
    mode: z.enum(ARTICLE_MODES).optional(),
    /**
     * Chapitres d une enquete, avec leur ROLE. Optionnel, pour la meme raison
     * que `mode` : les articles anterieurs n en portent pas.
     *
     * Le role etait produit par le plan, puis JETE au rendu ; le gate tentait
     * ensuite de le re-deviner depuis les mots du titre, et un bon titre ne
     * contient pas les mots-cles d une regle. Constate le 2026-09-11 : une
     * enquete complete, chapitre contradictoire compris, bloquee pour
     * « chapitre contradictoire absent ». Le role est donc porte par le
     * CONTRAT — c est le principe deja applique a `mode`.
     */
    chapitres: z
      .array(
        z
          .object({ role: z.enum(ROLES_CHAPITRE), titre: z.string().min(1) })
          .strict(),
      )
      .optional(),
    /**
     * Donnees du graphique d'ecart. OPTIONNEL, et il doit le rester — meme
     * raison que `mode` et `chapitres` : le schema est `.strict()`, et les
     * articles anterieurs n'en portent pas. Le rendre obligatoire invaliderait
     * d'un coup les brouillons existants et les attestations de relecture,
     * dont l'empreinte couvre l'article entier.
     *
     * Absent est le cas NORMAL : la plupart des articles n'ont pas
     * d'anticipation datee a confronter, et le brief l'ecrit — sans
     * anticipation sourcee, pas d'ecart.
     */
    infographie: InfographieSchema.optional(),
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
export type Infographie = z.infer<typeof InfographieSchema>;
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
