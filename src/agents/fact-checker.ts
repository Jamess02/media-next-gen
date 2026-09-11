/**
 * §5.2 + §9.3 — Le gate bloquant.
 *
 * "Le Fact-checker est un gate bloquant : si une claim n'atteint pas le niveau
 * de preuve 2, l'article ne passe pas a l'etape de redaction finale."
 *
 * ARCHITECTURE DU GATE, en trois temps :
 *
 *  1. PRE-CONTROLE DETERMINISTE — les tiers annonces sont reverifies contre le
 *     registre de domaines. Un tier falsifie en amont est corrige ici, avant
 *     que le modele ne le voie.
 *
 *  2. JUGEMENT SEMANTIQUE — le modele repond a la seule question qu'une
 *     fonction ne peut pas trancher : la source soutient-elle PRECISEMENT
 *     l'affirmation (niveau 3), ou seulement le sujet general (niveau 2) ?
 *
 *  3. CLAMP MONOTONE — et c'est le point critique : la sortie du modele est
 *     bornee par du code. Un verdict ne peut QUE degrader. Le modele peut
 *     abaisser un niveau de preuve, jamais le relever ; affaiblir le type d'une
 *     claim, jamais la promouvoir en `fait`.
 *
 * Consequence : meme un modele defaillant, ou influence par le contenu d'une
 * source hostile, ne peut pas ouvrir le gate. Il ne dispose que du pouvoir de
 * refuser. Un gate dont la garantie dependrait du bon comportement d'un LLM ne
 * serait pas un gate.
 */

import { z } from "zod";

import {
  CLAIM_TYPES,
  EVIDENCE_LEVELS,
  MIN_PUBLISHABLE_EVIDENCE_LEVEL,
  type ClaimType,
  type EvidenceLevel,
  type SourceTier,
} from "../protocol/constants.js";
import type { Claim } from "../protocol/schema.js";
import {
  emetteurAttendu,
  formuleDAttribution,
  sourceDeMarche,
  type PerimetreDeMarche,
} from "../protocol/sources-de-marche.js";
import { classifySource } from "../sources/registry.js";
import { Agent, asJson } from "./base.js";
import type { AnalysteOutput } from "./analyste.js";

export const VERDICTS = ["accepte", "abaisse", "reformule", "rejete"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const FactCheckerOutputSchema = z
  .object({
    verdicts: z.array(
      z.object({
        claim_id: z.string(),
        verdict: z.enum(VERDICTS),
        /** Niveau retenu apres verification. Ne peut que baisser (clamp aval). */
        adjusted_evidence_level: z.literal(EVIDENCE_LEVELS),
        /** Type retenu. Ne peut pas devenir "fait" (clamp aval). */
        adjusted_type: z.enum(CLAIM_TYPES),
        /** Obligatoire : EP-002, toute decision pointe vers son motif. */
        justification: z.string(),
        /**
         * Renseigne si verdict = "reformule" : §2 autorise a transformer une
         * claim trop faible en hypothese explicite plutot qu'a la retirer.
         */
        reformulated_text: z.string().nullable(),
      }),
    ),
    /** Contradictions entre sources, a remonter meme si rien n'est bloque. */
    conflicts_found: z.array(z.string()),
  })
  .strict();

export type FactCheckerOutput = z.infer<typeof FactCheckerOutputSchema>;

export interface FactCheckerInput {
  candidates: AnalysteOutput["candidates"];
  publicationCaveats: readonly string[];
  /**
   * §9.3 — seconde passe. Quand aucune claim n'a survecu au premier controle,
   * le protocole ne dit pas "abandonner" : il dit que la claim "retourne en
   * collecte OU est reformulee en scenario/hypothese explicite". Ce drapeau
   * demande explicitement la seconde option.
   */
  reformulationPass: boolean;
}

const INSTRUCTIONS = `
Tu es le gate bloquant du pipeline. Ton biais par defaut est le refus : dans le
doute, on abaisse ou on rejette. Un article non publie ne coute rien ; un fait
faux publie coute la credibilite du media.

Pour chaque claim candidate, verifie :

1. NIVEAU DE PREUVE (§2). Le niveau annonce est-il soutenu ?
   - niveau 3 exige que la source soutienne PRECISEMENT l'affirmation, pas
     seulement son sujet. Une source qui parle du bon pays et du bon mois mais
     pas du chiffre cite, c'est un niveau 2, pas un 3.
   - niveau 4 exige que le lecteur puisse REFAIRE le calcul : formule explicite
     ET acces aux donnees brutes. Sinon, abaisse.
   - niveau < 2 : la claim ne peut pas etre publiee telle quelle. Choisis
     "reformule" (en hypothese/scenario explicite, via reformulated_text) ou
     "rejete".

2. TYPAGE (§3). Le type colle-t-il au contenu reel ?
   - une claim typee \`fait\` dont le texte contient "suggere", "pourrait",
     "semble" n'est pas un fait : abaisse en \`inférence\`.
   - une claim typee \`fait\` adossee a une donnee partielle ou calculee est une
     \`estimation\`.
   - une projection sans condition explicite n'est pas un \`scénario\` valide :
     demande la reformulation.

3. CONTRADICTIONS. Si deux sources se contredisent, liste-le dans
   \`conflicts_found\`, meme si tu acceptes la claim par ailleurs.

4. NATURE DES SOURCES. \`nature_des_sources\` te donne, pour chaque URL, ce que
   le registre sait d'elle. Elle est derivee du domaine : ne la conteste pas.
   - \`secondaire\` avec \`remontee_requise\` : une reprise ne suffit pas a
     etablir un \`fait\`. Une claim typee \`fait\` sans aucune source primaire
     n'a pas ete remontee a son emetteur : abaisse-la en \`inférence\` ou en
     \`estimation\`, ou rejette-la.
   - \`perimetre: plateforme-unique\` : la donnee ne vaut que pour cette
     plateforme. Une claim qui en tire un prix du marche entier depasse sa
     source : reformule-la avec la formule donnee dans \`attribution\`.
   - \`perimetre: agrege\` : la valeur depend de la methodologie de
     l'agregateur, et la claim doit l'attribuer (\`attribution\`).
   - Les signaux de pre-verification (Yahoo Finance) ont deja ete retires par
     le pipeline : tu n'en verras aucun, et aucun ne vaut preuve.

Regles absolues :
- Tu ne peux JAMAIS remonter un niveau de preuve ni promouvoir une claim en
  \`fait\`. Le pipeline borne tes sorties dans ce sens : proposer une remontee
  ne sert a rien, elle sera ignoree.
- \`reformulated_text\` doit etre rempli quand et seulement quand verdict =
  "reformule".
- Chaque verdict porte une \`justification\` qui cite ce que tu as verifie.
`;

export class FactChecker extends Agent<FactCheckerInput, FactCheckerOutput> {
  readonly role = "fact-checker" as const;
  protected readonly instructions = INSTRUCTIONS;
  protected readonly outputSchema = FactCheckerOutputSchema;
  protected readonly schemaName = "FactCheckerOutput";
  /** Etape a plus fort enjeu du pipeline : on y met la profondeur maximale. */
  protected override readonly effort = "max" as const;

  protected buildUserMessage(input: FactCheckerInput): string {
    return asJson({
      claims_candidates: input.candidates,
      // Calculee par le code, pas par le modele : c'est le registre qui sait
      // qu'une source est secondaire, pas la claim qui la cite.
      nature_des_sources: natureDesSources(input.candidates),
      reserves_de_publication: input.publicationCaveats,
      ...(input.reformulationPass
        ? {
            consigne_de_seconde_passe:
              "SECONDE PASSE (§9.3). Aucune claim n'a atteint le niveau 2 au " +
              "premier controle. Pour chaque claim encore recuperable, emets un " +
              "verdict \"reformule\" avec un `reformulated_text` qui la restitue " +
              "en HYPOTHESE EXPLICITE : type `scénario` portant sa condition, ou " +
              "`inférence` portant son verbe de deduction. Le texte reformule ne " +
              "doit affirmer que ce que les sources soutiennent reellement. " +
              "Si une claim reste insoutenable meme reformulee, rejette-la : " +
              "reformuler n'est pas maquiller.",
          }
        : {}),
    });
  }
}

/* -------------------------------------------------------------------------
 * Temps 1 — pre-controle deterministe
 * ---------------------------------------------------------------------- */

export interface TierCorrection {
  claimId: string;
  url: string;
  declaredTier: number;
  actualTier: number;
}

/**
 * Reverifie chaque tier annonce contre le registre de domaines et corrige les
 * ecarts. Retourne les candidates corrigees et la liste des corrections, qui
 * doit etre remontee : un tier surevalue en amont n'est pas une broutille.
 */
export function reconcileTiers(candidates: AnalysteOutput["candidates"]): {
  candidates: AnalysteOutput["candidates"];
  corrections: TierCorrection[];
} {
  const corrections: TierCorrection[] = [];

  const reconciled = candidates.map((candidate) => ({
    ...candidate,
    sources: candidate.sources.map((source) => {
      const actual = classifySource(source.url).tier;
      if (actual !== source.tier) {
        corrections.push({
          claimId: candidate.id,
          url: source.url,
          declaredTier: source.tier,
          actualTier: actual,
        });
      }
      return { ...source, tier: actual };
    }),
  }));

  return { candidates: reconciled, corrections };
}

/* -------------------------------------------------------------------------
 * Temps 1 bis — usage des sources : un signal n'est jamais une preuve
 * ---------------------------------------------------------------------- */

export interface UsagesAppliques {
  /** Candidates debarrassees de leurs signaux ; celles qui n'avaient qu'eux sont retirees. */
  candidates: AnalysteOutput["candidates"];
  /** Rejets d'office, au format de `GateDecision.excluded`. */
  exclues: string[];
  /** Signaux retires des citations, au format de `GateDecision.adjustments`. */
  ajustements: string[];
}

/**
 * Applique l'USAGE de chaque source, avant tout jugement du modele.
 *
 * Un signal (Yahoo Finance) sert a pre-verifier : il indique qu'un chiffre
 * existe et ou le chercher. Il ne prouve rien — la preuve est l'emetteur
 * d'origine. D'ou deux traitements, tous deux deterministes :
 *
 *  - une claim qui a AUSSI une autre source perd le signal de ses citations :
 *    il a servi, il ne figurera pas comme preuve ;
 *  - une claim qui ne reposait QUE sur des signaux est rejetee d'office, avec
 *    l'emetteur qu'il faudrait citer. C'est la « remontee a la source
 *    primaire » que le signal reclamait, et qui n'a pas ete faite.
 *
 * Place AVANT l'appel au fact-checker : lui faire juger une claim deja
 * disqualifiee couterait un appel pour un verdict connu d'avance — et lui
 * laisserait la possibilite de la garder.
 */
export function appliquerUsagesDesSources(
  candidates: AnalysteOutput["candidates"],
): UsagesAppliques {
  const gardees: AnalysteOutput["candidates"] = [];
  const exclues: string[] = [];
  const ajustements: string[] = [];

  for (const candidate of candidates) {
    const estSignal = (url: string): boolean => sourceDeMarche(url)?.usage === "signal";
    const signaux = candidate.sources.filter((s) => estSignal(s.url));
    if (signaux.length === 0) {
      gardees.push(candidate);
      continue;
    }

    const noms = [...new Set(signaux.map((s) => sourceDeMarche(s.url)?.nom))].join(", ");

    if (signaux.length === candidate.sources.length) {
      const emetteurs = [
        ...new Set(
          signaux
            .map((s) => emetteurAttendu(s.url))
            .filter((e) => e !== null)
            .map((e) => `${e.nom} (${e.domaine})`),
        ),
      ];
      exclues.push(
        `${candidate.id} : rejetee — adossee au seul signal ${noms}, qui sert a ` +
          `pre-verifier et ne prouve rien (§4). Remontee a l'emetteur d'origine ` +
          `requise` +
          (emetteurs.length > 0 ? ` : ${emetteurs.join(", ")}.` : "."),
      );
      continue;
    }

    ajustements.push(
      `${candidate.id} : ${noms} retire des citations — signal de ` +
        `pre-verification, pas une preuve (§4). La claim repose sur ses autres sources.`,
    );
    gardees.push({
      ...candidate,
      sources: candidate.sources.filter((s) => !estSignal(s.url)),
    });
  }

  return { candidates: gardees, exclues, ajustements };
}

/** Ce que le fact-checker doit savoir d'une source, calcule depuis le registre. */
export interface NatureDeSource {
  url: string;
  tier: SourceTier;
  fiabilite: "primaire" | "secondaire";
  /** Vrai si un `fait` ne peut pas reposer sur elle seule. */
  remontee_requise: boolean;
  perimetre?: PerimetreDeMarche;
  /** Formule que la claim doit porter : « sur Binance », « selon CoinGecko ». */
  attribution?: string;
}

/**
 * Nature de chaque source citee, une fois par URL.
 *
 * Primaire = tier 1 ou 2, la frontiere que `FACT_NEEDS_PRIMARY_SOURCE` applique
 * deja au gate. Le modele recoit la meme frontiere des l'entree, plutot que de
 * la decouvrir a la publication, ou elle bloquerait l'article entier.
 */
export function natureDesSources(
  candidates: AnalysteOutput["candidates"],
): NatureDeSource[] {
  const vues = new Map<string, NatureDeSource>();
  for (const candidate of candidates) {
    for (const s of candidate.sources) {
      if (vues.has(s.url)) continue;
      const tier = classifySource(s.url).tier;
      const marche = sourceDeMarche(s.url);
      vues.set(s.url, {
        url: s.url,
        tier,
        fiabilite: tier <= 2 ? "primaire" : "secondaire",
        remontee_requise: tier > 2,
        ...(marche === null
          ? {}
          : { perimetre: marche.perimetre, attribution: formuleDAttribution(marche) }),
      });
    }
  }
  return [...vues.values()];
}

/* -------------------------------------------------------------------------
 * Temps 3 — clamp monotone
 * ---------------------------------------------------------------------- */

export interface GateDecision {
  /** Claims autorisees a passer en redaction. */
  accepted: Claim[];
  /** §7 — `editorial_notes.excluded_claims` : ce qui a ete ecarte, et pourquoi. */
  excluded: string[];
  /** Ajustements appliques, pour tracabilite (EP-002). */
  adjustments: string[];
  /** Vrai si au moins une claim survit au gate. */
  passed: boolean;
}

/**
 * Applique les verdicts en bornant le modele.
 *
 * Invariants garantis par cette fonction, independamment de ce que le modele
 * a repondu :
 *  - le niveau de preuve final <= niveau propose par l'analyste ;
 *  - une claim non typee `fait` en entree ne ressort jamais typee `fait` ;
 *  - toute claim finissant sous le niveau 2 est exclue, quel que soit le verdict.
 */
export function applyVerdicts(
  candidates: AnalysteOutput["candidates"],
  output: FactCheckerOutput,
): GateDecision {
  const byId = new Map(output.verdicts.map((v) => [v.claim_id, v]));
  const accepted: Claim[] = [];
  const excluded: string[] = [];
  const adjustments: string[] = [];

  for (const candidate of candidates) {
    const verdict = byId.get(candidate.id);

    // Absence de verdict = non verifie. Non verifie = non publiable (§9.3).
    if (verdict === undefined) {
      excluded.push(
        `${candidate.id} : aucun verdict du fact-checker ; une claim non verifiee n'est pas publiable.`,
      );
      continue;
    }

    if (verdict.verdict === "rejete") {
      excluded.push(`${candidate.id} : rejetee — ${verdict.justification}`);
      continue;
    }

    // --- Clamp du niveau de preuve : degradation seule ---------------------
    const proposed = candidate.proposed_evidence_level;
    let level: EvidenceLevel = verdict.adjusted_evidence_level;
    if (level > proposed) {
      adjustments.push(
        `${candidate.id} : remontee de niveau ${proposed} -> ${level} ignoree ` +
          `(le fact-checker ne peut que degrader). Niveau retenu : ${proposed}.`,
      );
      level = proposed;
    }

    // --- Clamp du type : pas de promotion en `fait` ------------------------
    let type: ClaimType = verdict.adjusted_type;
    if (type === "fait" && candidate.type !== "fait") {
      adjustments.push(
        `${candidate.id} : promotion "${candidate.type}" -> "fait" refusee (§3/§8). ` +
          `Type conserve : ${candidate.type}.`,
      );
      type = candidate.type;
    }

    // --- Plancher de publication (§2) --------------------------------------
    if (level < MIN_PUBLISHABLE_EVIDENCE_LEVEL) {
      excluded.push(
        `${candidate.id} : niveau de preuve ${level} < ${MIN_PUBLISHABLE_EVIDENCE_LEVEL} — ` +
          `${verdict.justification}`,
      );
      continue;
    }

    const text =
      verdict.verdict === "reformule" && verdict.reformulated_text !== null
        ? verdict.reformulated_text
        : candidate.text;

    if (verdict.verdict === "reformule") {
      adjustments.push(`${candidate.id} : reformulee — ${verdict.justification}`);
    } else if (level < proposed) {
      adjustments.push(
        `${candidate.id} : niveau abaisse ${proposed} -> ${level} — ${verdict.justification}`,
      );
    }

    accepted.push({
      id: candidate.id,
      text,
      type,
      evidence_level: level,
      // Le chiffre structure traverse le gate INCHANGE. Le fact-checker peut
      // degrader un niveau ou requalifier un type ; il n a aucune raison de
      // toucher a une valeur mesuree, et lui en donner la possibilite
      // ouvrirait une porte que le clamp monotone ferme partout ailleurs.
      ...(candidate.figure === undefined ? {} : { figure: candidate.figure }),
      sources: candidate.sources.map((s) => ({
        url: s.url,
        tier: s.tier,
        date_observed: s.date_observed,
        date_published: s.date_published,
      })),
    });
  }

  return { accepted, excluded, adjustments, passed: accepted.length > 0 };
}
