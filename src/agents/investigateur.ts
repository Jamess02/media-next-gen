/**
 * §5.3 — L'Investigateur : enquete longue, ecrite CHAPITRE PAR CHAPITRE.
 *
 * Dependances : `base.ts` (socle commun des agents) et les types du protocole.
 * Aucune dependance npm au-dela de zod, deja present.
 *
 * CE QU'IL EST, ET CE QU'IL N'EST PAS
 *
 * Ce n'est pas un Redacteur qui ecrirait plus long. Quatre choses le
 * distinguent, et aucune ne tient au prompt :
 *
 *  - les SUJETS qui lui parviennent sont filtres en amont par
 *    `planification/investigation.ts`, sur des criteres observables ;
 *  - sa CADENCE est tenue par un quota, verifie avant toute collecte ;
 *  - sa STRUCTURE est opposable : `rules.ts` bloque une enquete sans chapitre
 *    contradictoire, sans glossaire ou sans bibliographie ;
 *  - son ECRITURE se fait en plusieurs passes, une par chapitre.
 *
 * POURQUOI PLUSIEURS PASSES — UNE MESURE, PAS UNE PREFERENCE
 *
 * Trois executions reelles sur le meme sujet, en UNE requete par enquete :
 *
 *   gemini-3.5-flash-lite      496 mots, aucun chapitre
 *   idem + rendu des sections  640 mots
 *   gemini-3.6-flash           990 mots, chapitres presents
 *
 * Aucun ne franchit le plancher de 1500 mots. Ce n'est ni un plafond de tokens
 * (8192, verifie) ni un defaut de code : produire 1500 a 3000 mots structures
 * en une seule reponse depasse ce que ces modeles font.
 *
 * Le cahier des charges demandait « un temps de recherche et de verification
 * plus long par article ». La lenteur avait ete implementee comme un QUOTA,
 * mais pas comme un TRAVAIL plus long : l'enquete se redigeait en un appel,
 * comme une breve. Un appel par chapitre corrige cela, et donne a chaque
 * partie toute l'attention du modele.
 *
 * LES CHAPITRES OBLIGATOIRES SONT GARANTIS PAR LE CODE
 *
 * Le plan rendu par le modele est COMPLETE s'il oublie un role obligatoire.
 * Demander au modele de ne pas oublier le chapitre contradictoire, c'est
 * esperer ; l'ajouter quand il manque, c'est l'obtenir.
 *
 * MEME CONTRAINTE STRUCTURELLE QUE LE REDACTEUR (§8)
 *
 * Aucun de ses schemas ne contient de claim. Il recoit des claims deja
 * validees et immuables, et n'ecrit qu'autour d'elles. Il peut mal ecrire ; il
 * ne peut pas requalifier une inference en fait, faute de canal pour le faire.
 */

import { z } from "zod";

import { ROLES_CHAPITRE, type RoleChapitre } from "../protocol/constants.js";
import type { Claim } from "../protocol/schema.js";
import type { CritereEnquete } from "../planification/investigation.js";
import { Agent, asJson } from "./base.js";

// Reexportes pour les appelants qui les importaient d ici.
export { ROLES_CHAPITRE, type RoleChapitre };

/* -------------------------------------------------------------------------
 * Chapitres
 * ---------------------------------------------------------------------- */

/**
 * Roles sans lesquels le gate refuse de publier.
 *
 * `contradictoire` est le plus facile a omettre, et celui sans lequel une
 * enquete devient une demonstration. `echeances` empeche la cloture
 * definitive, qui promettrait une certitude que les sources ne portent pas.
 */
export const ROLES_OBLIGATOIRES: readonly RoleChapitre[] = [
  "etabli",
  "contradictoire",
  "echeances",
];

/** Intitules de repli, utilises SEULEMENT quand le plan omet un role. */
const TITRES_PAR_DEFAUT: Record<RoleChapitre, { titre: string; angle: string }> = {
  etabli: {
    titre: "Ce que les donnees etablissent",
    angle: "exposer les faits sourcés, chaque chiffre relie a sa claim",
  },
  tension: {
    titre: "Ou se deplace le risque",
    angle: "montrer vers quoi la tension se deplace, sans la dramatiser",
  },
  mecanisme: {
    titre: "Le mecanisme",
    angle: "demonter l'enchainement, etape par etape",
  },
  contradictoire: {
    titre: "Le versant rassurant",
    angle:
      "exposer la lecture INVERSE comme si on la defendait, puis dire ce qui la limite",
  },
  echeances: {
    titre: "Prochaines echeances a surveiller",
    angle:
      "nommer ce qui trancherait : quelle publication, quelle decision, quelle date",
  },
};

export const ChapitrePrevuSchema = z
  .object({
    role: z.enum(ROLES_CHAPITRE),
    titre: z.string(),
    /** Ce que ce chapitre doit etablir. Sert de consigne a la passe d'ecriture. */
    angle: z.string(),
  })
  .strict();

export type ChapitrePrevu = z.infer<typeof ChapitrePrevuSchema>;

/**
 * Complete un plan des roles obligatoires qu'il aurait omis.
 *
 * Ne touche PAS aux chapitres proposes : un titre trouve par le modele vaut
 * mieux qu'un intitule generique. On n'ajoute que ce qui manque.
 *
 * Les echeances sont replacees EN DERNIER : c'est une conclusion, et un plan
 * qui les place au milieu produirait un texte qui conclut puis continue.
 */
export function completerChapitres(
  prevus: readonly ChapitrePrevu[],
): ChapitrePrevu[] {
  const vus = new Set<RoleChapitre>();
  const retenus: ChapitrePrevu[] = [];

  for (const c of prevus) {
    if (vus.has(c.role)) continue; // un role deux fois : le second est du remplissage
    vus.add(c.role);
    retenus.push(c);
  }

  for (const role of ROLES_OBLIGATOIRES) {
    if (vus.has(role)) continue;
    const d = TITRES_PAR_DEFAUT[role];
    retenus.push({ role, titre: d.titre, angle: d.angle });
  }

  const echeances = retenus.filter((c) => c.role === "echeances");
  const reste = retenus.filter((c) => c.role !== "echeances");
  return [...reste, ...echeances];
}

/* -------------------------------------------------------------------------
 * Schemas d'echange
 * ---------------------------------------------------------------------- */

const TermeSchema = z
  .object({ terme: z.string(), definition: z.string() })
  .strict();

/**
 * §4 — la bibliographie SEPARE les natures de sources.
 *
 * Trois listes distinctes plutot qu'une liste annotee : une annotation
 * s'oublie, une structure non. Les rubriques vides sont admises — une enquete
 * adossee uniquement a des sources primaires n'a legitimement rien a mettre
 * ailleurs, et exiger le contraire pousserait a inventer des references.
 */
const BibliographieSchema = z
  .object({
    primaires: z.array(z.string()),
    secondaires: z.array(z.string()),
    hypotheses: z.array(z.string()),
  })
  .strict();

/** Premiere passe : decider, cadrer, et planifier les chapitres. */
export const PlanEnqueteSchema = z
  .object({
    /** Faux quand la piste ne tient pas. Sortie NORMALE, pas une erreur. */
    publiable: z.boolean(),
    /** Obligatoire si `publiable` est faux : renoncer doit s'expliquer. */
    motif_de_refus: z.string().nullable(),
    title: z.string().nullable(),
    /** Le « en trois minutes » : le fait, sa portee, ce qui reste incertain. */
    resume_en_bref: z.string().nullable(),
    chapitres: z.array(ChapitrePrevuSchema),
    glossaire: z.array(TermeSchema),
    bibliographie: BibliographieSchema,
    uncertainty_flags: z.array(z.string()),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (!plan.publiable) {
      if (plan.motif_de_refus === null || plan.motif_de_refus.trim() === "") {
        ctx.addIssue({
          code: "custom",
          message:
            "refus sans motif : une piste abandonnee doit dire POURQUOI, " +
            "sans quoi l'abandon n'est pas relisable.",
          path: ["motif_de_refus"],
        });
      }
      return;
    }
    for (const champ of ["title", "resume_en_bref"] as const) {
      if (plan[champ] === null || String(plan[champ]).trim() === "") {
        ctx.addIssue({
          code: "custom",
          message: `enquete annoncee publiable mais ${champ} est vide.`,
          path: [champ],
        });
      }
    }
  });

export type PlanEnquete = z.infer<typeof PlanEnqueteSchema>;

/** Seconde passe : la prose d'UN chapitre. */
export const ChapitreEcritSchema = z
  .object({
    /** Markdown, SANS titre : il vient du plan et reste sous controle du code. */
    corps: z.string().min(1),
  })
  .strict();

export type ChapitreEcrit = z.infer<typeof ChapitreEcritSchema>;

/* -------------------------------------------------------------------------
 * Rendu
 * ---------------------------------------------------------------------- */

/**
 * Assemble le corps final : resume, chapitres, glossaire, bibliographie.
 *
 * NE D'UN ECHEC REEL. Dans une premiere version, le modele remplissait bien
 * `glossaire` et `bibliographie`, et le pipeline ne transmettait que la prose :
 * ces champs etaient jetés en silence, puis le gate les cherchait dans le
 * corps sans les trouver. L'information existait et se perdait entre deux
 * etapes — meme faute que le champ `figure`, jeté deux fois dans ce projet.
 *
 * Rendues depuis les champs structures, ces sections sont GARANTIES plutot que
 * demandees. Le rendu ne MAQUILLE rien pour autant : une rubrique vide n'est
 * pas inventee, et le gate bloquera si la matiere manque vraiment.
 */
export function rendreCorpsEnquete(sortie: {
  resume_en_bref: string;
  chapitres: ReadonlyArray<{ titre: string; corps: string }>;
  glossaire: ReadonlyArray<{ terme: string; definition: string }>;
  bibliographie: {
    primaires: readonly string[];
    secondaires: readonly string[];
    hypotheses: readonly string[];
  };
}): string {
  const morceaux: string[] = [];

  if (sortie.resume_en_bref.trim().length > 0) {
    morceaux.push("## L'essentiel en trois minutes", sortie.resume_en_bref.trim());
  }

  for (const c of sortie.chapitres) {
    if (c.corps.trim().length === 0) continue;
    morceaux.push(`## ${c.titre.trim()}`, c.corps.trim());
  }

  if (sortie.glossaire.length > 0) {
    morceaux.push(
      "## Glossaire",
      sortie.glossaire.map((t) => `**${t.terme}** : ${t.definition}`).join("\n\n"),
    );
  }

  const rubriques: Array<[string, readonly string[]]> = [
    ["Sources primaires", sortie.bibliographie.primaires],
    ["Sources secondaires", sortie.bibliographie.secondaires],
    ["Hypotheses et scenarios", sortie.bibliographie.hypotheses],
  ];
  const remplies = rubriques.filter(([, e]) => e.length > 0);

  if (remplies.length > 0) {
    morceaux.push("## Bibliographie");
    for (const [nom, entrees] of remplies) {
      morceaux.push(`### ${nom}`, entrees.map((e) => `- ${e}`).join("\n"));
    }
  }

  return morceaux.join("\n\n");
}

/* -------------------------------------------------------------------------
 * Agents
 * ---------------------------------------------------------------------- */

export interface InvestigateurInput {
  topic: string;
  /** Claims deja validees. Immuables : §8. */
  claims: readonly Claim[];
  /** Criteres qui ont fait router ce sujet ici. Cadrent l'angle. */
  criteres: readonly CritereEnquete[];
  /** Resumes des observations retenues, tels que publies par les emetteurs. */
  sourceMaterial: readonly string[];
  narrativeVsData: string;
  publicationCaveats: readonly string[];
  /** §4 — mention en tete si tout repose sur du tier 3/4. */
  requiredDisclaimer: string | null;
  /** §4 / EP-002 — divulgations d'interet a reproduire VERBATIM, en gras. */
  requiredDisclosures: readonly string[];
  /**
   * « sur Binance », « selon CoinGecko » : produites par
   * `protocol/sources-de-marche.ts`, que le gate relit pour verifier chaque
   * paragraphe. Optionnel : une enquete sans donnee de marche n'en porte aucune.
   */
  requiredAttributions?: readonly string[];
}

export interface ChapitreInput extends InvestigateurInput {
  chapitre: ChapitrePrevu;
  /** Titres deja ecrits, pour eviter les redites d'un chapitre a l'autre. */
  dejaEcrits: readonly string[];
  /** Plancher indicatif, pour que l'ensemble atteigne le format annonce. */
  motsVises: number;
}

const COMMUN = `
Tu es l'Investigateur. Tu produis des ENQUETES LONGUES, entre 1500 et 3000 mots
au total, ecrites chapitre par chapitre.

SOURCAGE. Chaque affirmation chiffree est reliee a une claim par [[claim-id]].
Un chiffre qui n'apparait dans aucune source retenue n'a rien a faire dans le
texte, meme en incise, meme « pour donner un ordre de grandeur ».

Distingue explicitement FAIT ETABLI, ANALYSE et SCENARIO. Le format long rend
cette distinction plus necessaire, pas moins : la longueur donne au lecteur
l'impression d'une demonstration, et c'est a toi de marquer ou elle s'arrete.

TON. Sobre, factuel, SANS SENSATIONNALISME. Pas de formule d'accroche, pas de
suspense, pas d'adjectif qui fasse le travail de la preuve.

Tu ne peux ni creer, ni modifier, ni requalifier une claim : tu recois des
affirmations deja validees et tu ecris AUTOUR d'elles.

ATTRIBUTIONS DES DONNEES DE MARCHE (\`attributions_obligatoires\`). Chaque
entree donne une formule (« sur Binance », « selon CoinGecko ») et la claim
qu'elle accompagne. Tout paragraphe qui s'appuie sur cette claim contient la
formule : un prix de Binance presente sans son nom devient « le prix du
bitcoin », que Binance ne mesure pas. Une cotation en USDT s'ecrit en USDT,
jamais en dollars. Le controle de publication verifie chaque paragraphe.
`;

export const INSTRUCTIONS_PLAN = `${COMMUN}

CETTE PASSE EST UN PLAN, PAS UNE REDACTION. N'ecris aucun paragraphe.

Tu rends :
  - publiable : vrai ou faux ;
  - title : le titre de l'enquete ;
  - resume_en_bref : « l'essentiel en trois minutes » — le fait, pourquoi il
    compte, et CE QUI RESTE INCERTAIN. L'incertitude en fait partie ; un resume
    qui n'en porte aucune annonce une certitude que les sources n'ont pas ;
  - chapitres : la liste des chapitres, chacun avec son role, son titre et son
    ANGLE — ce que le chapitre doit etablir. Roles disponibles : etabli,
    tension, mecanisme, contradictoire, echeances ;
  - glossaire : les notions techniques que l'enquete introduira ;
  - bibliographie : primaires (institutions, regulateurs, donnees officielles),
    secondaires (presse), hypotheses (ce qui n'est pas etabli). Une rubrique
    VIDE est acceptable : n'invente pas de references pour la remplir.

Le chapitre CONTRADICTOIRE est indispensable : il prend au serieux la lecture
inverse avant de la nuancer. Sans lui, une enquete devient une demonstration.
Le chapitre des ECHEANCES conclut sur ce qui trancherait, jamais sur un verdict.

TU PEUX RENONCER, ET TU DOIS LE FAIRE QUAND C'EST JUSTIFIE.

Si la matiere ne tient pas — sources trop rares, emetteur unique, mecanisme que
les documents ne permettent pas de demonter — rends publiable: false avec un
motif_de_refus precis. Une piste abandonnee ne coute rien ; une enquete de 2000
mots batie sur du vide coute la credibilite de toutes les autres.
`;

export const INSTRUCTIONS_CHAPITRE = `${COMMUN}

TU N'ECRIS QU'UN SEUL CHAPITRE, celui qu'on te donne. Pas d'introduction
generale, pas de conclusion d'ensemble : d'autres chapitres s'en chargent.

N'ECRIS PAS SON TITRE : il est deja fixe et sera ajoute autour de ton texte.
Commence directement par la prose.

Respecte l'ANGLE indique : c'est ce que ce chapitre doit etablir, et lui seul.

Une liste de chapitres deja ecrits t'est fournie. N'y reviens pas : redire ce
qu'un autre chapitre a etabli allonge sans rien apporter, et c'est exactement
le remplissage que le format long doit eviter.

Vise le nombre de mots indique. Si la matiere ne le permet pas, ecris moins
plutot que de delayer — un paragraphe creux se voit davantage qu'un chapitre
court.
`;

/** Premiere passe : decider et planifier. */
export class InvestigateurPlan extends Agent<InvestigateurInput, PlanEnquete> {
  readonly role = "investigateur" as const;
  protected readonly instructions = INSTRUCTIONS_PLAN;
  protected readonly outputSchema = PlanEnqueteSchema;
  protected readonly schemaName = "PlanEnquete";
  protected override readonly effort = "max" as const;

  protected buildUserMessage(input: InvestigateurInput): string {
    return asJson({
      sujet: input.topic,
      criteres_ayant_justifie_l_enquete: input.criteres,
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

/** Seconde passe, repetee : la prose d'un chapitre. */
export class InvestigateurChapitre extends Agent<ChapitreInput, ChapitreEcrit> {
  readonly role = "investigateur" as const;
  protected readonly instructions = INSTRUCTIONS_CHAPITRE;
  protected readonly outputSchema = ChapitreEcritSchema;
  protected readonly schemaName = "ChapitreEcrit";
  protected override readonly effort = "max" as const;

  protected buildUserMessage(input: ChapitreInput): string {
    return asJson({
      sujet: input.topic,
      chapitre_a_ecrire: {
        titre: input.chapitre.titre,
        role: input.chapitre.role,
        angle: input.chapitre.angle,
      },
      mots_vises: input.motsVises,
      chapitres_deja_ecrits: input.dejaEcrits,
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
