/**
 * Reponses simulees ADAPTATIVES — derivees des donnees reellement collectees.
 *
 * Pourquoi un second jeu de reponses ?
 *
 * `mock-scenario.ts` est scripte sur l'economie fictive de Zembla : il pose des
 * pieges precis (surcote de niveau, promotion illegale) pour verifier le gate.
 * Mais il ignore son entree. Branche sur de vraies sources, il produirait des
 * claims sur Zembla en citant des donnees de la Banque mondiale : incoherent.
 *
 * Ces responders-ci lisent ce qu'on leur donne et construisent leurs sorties a
 * partir des observations reelles. Ils permettent de faire tourner la chaine
 * complete sur de vraies donnees, sans clef d'API.
 *
 * Ils restent PRUDENTS par construction : tout est plafonne au niveau de preuve
 * 2 (source liee) et rien n'est type au-dela de ce que le tier autorise. Un
 * responder simule n'a aucun moyen de verifier qu'une source soutient
 * PRECISEMENT une affirmation — c'est le travail du niveau 3, qui exige un
 * jugement. Il ne doit donc jamais le pretendre.
 */

import type { MockResponder } from "../llm/mock-client.js";
import type { RawEvent } from "../protocol/schema.js";

interface VeilleurPayload {
  sujet: string;
  evenements: RawEvent[];
}

interface AnalystePayload {
  sujet: string;
  observations_retenues: RawEvent[];
}

interface CandidatePayload {
  claims_candidates: Array<{
    id: string;
    text: string;
    type: string;
    proposed_evidence_level: number;
  }>;
}

interface ClaimsPayload {
  sujet: string;
  claims_validees_immuables: Array<{ id: string; text: string; type: string }>;
  /** §4 / EP-002 — deja en gras, a reproduire verbatim. */
  divulgations_obligatoires: string[];
}

const parse = <T>(request: { user: string }): T =>
  JSON.parse(request.user) as T;

/** Tronque un resume pour en faire une phrase de claim lisible. */
function toClaimText(resume: string): string {
  const trimmed = resume.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/**
 * Marqueurs par lesquels une source signale elle-meme que sa valeur n'est pas
 * une observation ferme : estimation, projection, serie incomplete, solution
 * preliminaire.
 */
const CAVEAT_MARKERS =
  /estimation|projection|preliminaire|revisee|partiel|millesime/i;

/**
 * §3 — choix du type de claim.
 *
 * Un tier 1/2 ne suffit PAS a faire un `fait`. Si la source declare elle-meme
 * que sa valeur peut etre une estimation ou une solution provisoire — ce que
 * font le FMI (WEO), FRED (millesimes) et l'USGS (solutions automatiques) —
 * alors la claim est une `estimation`, pas un fait.
 *
 * Sans cette regle, le pipeline publierait comme fait etabli un chiffre dont
 * la source dit, dans la phrase meme, qu'il peut changer.
 */
function chooseClaimType(event: RawEvent): "fait" | "estimation" | "inférence" {
  if (event.tier > 2) return "inférence";
  return CAVEAT_MARKERS.test(event.resume) ? "estimation" : "fait";
}

/** Mots trop courants pour discriminer un sujet. */
const STOP_WORDS = new Set([
  "et", "de", "des", "du", "la", "le", "les", "un", "une", "en", "sur",
  "dans", "pour", "aux", "au", "par",
]);

/**
 * Nombre de termes du sujet presents dans l'observation.
 *
 * Substitut GROSSIER du jugement editorial : un vrai Veilleur (LLM) pese la
 * pertinence, pas des occurrences. Mais un critere explicite et testable vaut
 * mieux qu'un ordre incident — au moins celui-ci se lit dans le
 * `selection_reason`, donc se conteste.
 */
function topicScore(event: RawEvent, topic: string): number {
  const haystack = `${event.resume} ${event.source} ${event.type}`.toLowerCase();
  const terms = topic
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return new Set(terms.filter((t) => haystack.includes(t))).size;
}

/** Date de publication en millisecondes ; 0 si la source ne la fournit pas. */
function freshness(event: RawEvent): number {
  if (event.date_published === null) return 0;
  const parsed = Date.parse(event.date_published);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export const ADAPTIVE_RESPONDERS: Record<string, MockResponder> = {
  /* --- §5.1 : retenir le primaire, ecarter le secondaire ----------------- */
  veilleur: (request) => {
    const { sujet, evenements } = parse<VeilleurPayload>(request);
    const primary = evenements
      .filter((e) => e.tier <= 2)
      .map((e) => ({ event: e, score: topicScore(e, sujet) }))
      // L'etape suivante plafonne a 3 claims (§3) : l'ordre rendu ici decide
      // donc de ce qui sera publie. Le laisser dependre de l'ordre du
      // catalogue de sources reviendrait a trancher au hasard.
      .sort(
        (a, b) =>
          b.score - a.score || freshness(b.event) - freshness(a.event),
      );
    const secondary = evenements.filter((e) => e.tier >= 3);

    return {
      retained: primary.map(({ event: e, score }) => ({
        url: e.url,
        selection_reason:
          `Source de tier ${e.tier} (${e.source}) : emetteur de la donnee, ` +
          `prioritaire sur toute reprise (EP-001). ` +
          (score > 0
            ? `Retenue en priorite : ${score} terme(s) du sujet present(s) dans l'observation.`
            : `Aucun terme du sujet ne figure dans l'observation : classee apres les correspondances directes, ` +
              `puis par fraicheur de publication.`),
      })),
      set_aside: secondary.map((e) => ({
        url: e.url,
        reason: `Source de tier ${e.tier} ecartee : ${
          primary.length > 0
            ? "la donnee est disponible chez son emetteur (EP-001)."
            : "aucune source primaire disponible, mais le tier 3 seul ne suffit pas a fonder une claim structurante."
        }`,
      })),
      freshness_assessment:
        primary.length > 0
          ? `Fenetre utile bornee par la date de publication la plus recente parmi ${primary.length} source(s) primaire(s) retenue(s). Les series annuelles portent un decalage de publication d'au moins un an.`
          : "Aucune source primaire retenue : fenetre de fraicheur non evaluable.",
      primary_source_available: primary.length > 0,
    };
  },

  /* --- §5.2 : une claim par observation, plafonnee au niveau 2 ----------- */
  analyste: (request) => {
    const { sujet, observations_retenues } = parse<AnalystePayload>(request);
    // §3 — plafond de 3 claims structurantes.
    const events = observations_retenues.slice(0, 3);
    const dropped = observations_retenues.slice(3);

    return {
      candidates: events.map((event, index) => ({
        id: `claim-${index + 1}`,
        type: chooseClaimType(event),
        text: toClaimText(event.resume),
        // Plafonne a 2 : verifier qu'une source soutient PRECISEMENT une
        // affirmation demande un jugement qu'un responder simule n'a pas.
        proposed_evidence_level: 2,
        rationale: `Reprise directe de l'observation publiee par ${event.source} (tier ${event.tier}), sans retraitement. Niveau plafonne a 2 : la source est liee et verifiable, mais la correspondance precise entre le chiffre et l'affirmation n'a pas ete etablie par un jugement humain.`,
        sources: [
          {
            url: event.url,
            tier: event.tier,
            date_observed: event.date_observed,
            date_published: event.date_published,
          },
        ],
      })),
      narrative_vs_data:
        events.length > 0
          ? `Lecture directe des donnees publiees sur "${sujet}", sans confrontation a un narratif mediatique : aucune source secondaire n'a ete retenue.`
          : "Aucune observation retenue.",
      publication_caveats: [
        "Series annuelles : la valeur la plus recente peut porter plusieurs mois de decalage et faire l'objet de revisions.",
        "Analyse produite par des responders simules : aucun jugement humain n'a valide la correspondance entre les chiffres et les affirmations.",
        // §3 plafonne a 3 claims, mais ce qui a ete ecarte doit se declarer :
        // un lecteur qui voit 3 sources doit savoir que 6 autres ont ete
        // collectees et non traitees, sinon la couverture parait complete.
        ...(dropped.length > 0
          ? [
              `Plafond de 3 claims structurantes atteint (§3) : ${dropped.length} observation(s) ` +
                `collectee(s) n'ont pas ete traitees dans cet article — ` +
                `${dropped.map((e) => e.source).join(", ")}. Elles justifieraient un article distinct.`,
            ]
          : []),
      ],
    };
  },

  /* --- §5.2 / §9.3 : accepter au niveau propose, sans jamais le relever -- */
  "fact-checker": (request) => {
    const { claims_candidates } = parse<CandidatePayload>(request);
    return {
      verdicts: claims_candidates.map((c) => ({
        claim_id: c.id,
        verdict: "accepte",
        adjusted_evidence_level: c.proposed_evidence_level,
        adjusted_type: c.type,
        justification:
          "Source liee et accessible : niveau 2 confirme. Niveau 3 non atteint — la correspondance precise entre la source et l'affirmation n'a pas ete verifiee.",
        reformulated_text: null,
      })),
      conflicts_found: [],
    };
  },

  /* --- §5.3 -------------------------------------------------------------- */
  redacteur: (request) => {
    const { sujet, claims_validees_immuables, divulgations_obligatoires } =
      parse<ClaimsPayload>(request);
    // §4 / EP-002 — les divulgations arrivent deja en gras et se reproduisent
    // VERBATIM. Un responder simule qui les paraphraserait se ferait refuser a
    // la publication, exactement comme un vrai modele : c'est la meme regle qui
    // s'applique aux deux, et c'est le but.
    const divulgations = divulgations_obligatoires ?? [];

    // NE RECOPIE PLUS LE TEXTE DES CLAIMS.
    //
    // La version precedente construisait le corps en collant chaque claim sous
    // sa propre reference. C'est exactement le defaut qu'un vrai modele a
    // reproduit en production, et que `BODY_IS_CLAIM_PASTE` refuse desormais.
    // Un responder simule doit se soumettre a la meme regle : s'il en etait
    // dispense, les tests du pipeline vaudraient pour un pipeline qui n'existe
    // pas.
    const nature: Record<string, string> = {
      fait: "un constat direct",
      estimation: "un chiffre calcule a partir de donnees incompletes",
      "inférence": "une deduction tiree de plusieurs elements",
      "scénario": "une projection conditionnelle",
    };

    const paragraphes = claims_validees_immuables.map((c, i) => {
      const rang = ["premier", "deuxieme", "troisieme"][i] ?? `${i + 1}e`;
      return (
        `Le ${rang} element retenu est ${nature[c.type] ?? "une affirmation"} ` +
        `[[${c.id}]]. Sa formulation exacte, sa source et sa date d'observation ` +
        `figurent dans la fiche de preuve jointe a cet article : le lecteur peut ` +
        `donc remonter a l'emetteur sans passer par ce texte. Ce que cette ` +
        `affirmation ne dit pas compte autant : elle ne couvre pas les periodes ` +
        `anterieures a la fenetre de collecte, et ne se prononce pas sur les ` +
        `grandeurs voisines que la meme source publie separement.`
      );
    });

    return {
      title: `Lecture datee : ${sujet}`,
      body: [
        `Cet article documente l'etat des donnees publiques disponibles sur ` +
          `"${sujet}" a la date de collecte. Il ne prolonge pas ces donnees au-dela ` +
          `de ce qu'elles portent, et signale a chaque etape ce qui releve de ` +
          `l'observation et ce qui n'en releve pas.`,
        "",
        ...(divulgations.length > 0 ? [...divulgations, ""] : []),
        ...paragraphes.flatMap((p) => [p, ""]),
        `Prises ensemble, ces affirmations decrivent un etat de publication, pas ` +
          `une dynamique. Chacune reprend une donnee publiee par son emetteur ; ` +
          `aucune n'a fait l'objet d'un recoupement entre sources independantes, ` +
          `et le rapprochement de deux series produites par des institutions ` +
          `differentes n'est pas fait ici.`,
        "",
        `La date de collecte compte autant que la valeur relevee. Une meme serie ` +
          `consultee deux semaines plus tard peut porter un chiffre different sans ` +
          `qu'aucun evenement ne se soit produit entre-temps : plusieurs des ` +
          `institutions citees revisent leurs publications apres diffusion, et la ` +
          `date d'observation retenue ici est celle de la lecture, distincte de ` +
          `celle du fait.`,
        "",
        `Ce qui reste ouvert : la prochaine publication de chaque source dira si ` +
          `les valeurs retenues sont revisees, plusieurs des series citees etant ` +
          `sujettes a revision apres leur premiere diffusion. Les elements ` +
          `absents du catalogue de sources ne sont pas traites, et leur absence ` +
          `ne vaut pas absence de fait.`,
      ].join("\n"),
      uncertainty_flags: [
        "Article genere sans jugement editorial humain : les affirmations reprennent les donnees publiees sans verification de leur correspondance precise.",
        "Corps produit par un responder simule : il respecte les planchers de redaction, mais ne constitue pas un travail journalistique.",
      ],
    };
  },

  /* --- §5.4 -------------------------------------------------------------- */
  "redacteur-en-chef": () => ({
    verdict: "publier",
    justification:
      "Le texte se limite a restituer des donnees publiees, chacune rattachee a sa source et a sa date. Aucune conclusion ne deborde ce que les claims soutiennent, aucune orientation d'action n'est formulee.",
    implicit_recommendations: [],
    unsupported_assertions: [],
    angle_issues: [],
    suggested_split: [],
  }),
};
