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

export const ADAPTIVE_RESPONDERS: Record<string, MockResponder> = {
  /* --- §5.1 : retenir le primaire, ecarter le secondaire ----------------- */
  veilleur: (request) => {
    const { evenements } = parse<VeilleurPayload>(request);
    const primary = evenements.filter((e) => e.tier <= 2);
    const secondary = evenements.filter((e) => e.tier >= 3);

    return {
      retained: primary.map((e) => ({
        url: e.url,
        selection_reason: `Source de tier ${e.tier} (${e.source}) : emetteur de la donnee, prioritaire sur toute reprise (EP-001).`,
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
    const { sujet, claims_validees_immuables } = parse<ClaimsPayload>(request);
    return {
      title: `Lecture datee : ${sujet}`,
      body: [
        `Etat des donnees publiques disponibles sur "${sujet}" a la date de collecte.`,
        "",
        ...claims_validees_immuables.map((c) => `${c.text} [[${c.id}]]`),
        "",
        "Chaque affirmation ci-dessus reprend une donnee publiee par son emetteur. Aucune n'a fait l'objet d'un recoupement entre sources independantes.",
      ].join("\n"),
      uncertainty_flags: [
        "Article genere sans jugement editorial humain : les affirmations reprennent les donnees publiees sans verification de leur correspondance precise.",
      ],
    };
  },

  /* --- §5.4 -------------------------------------------------------------- */
  "redacteur-en-chef": () => ({
    verdict: "publier",
    justification:
      "Le texte se limite a restituer des donnees publiees, chacune rattachee a sa source et a sa date. Aucune conclusion ne deborde ce que les claims soutiennent, aucune orientation d'action n'est formulee.",
    implicit_recommendations: [],
    angle_issues: [],
    suggested_split: [],
  }),
};
