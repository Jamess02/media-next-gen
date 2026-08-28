/**
 * EP-005, EP-006 et §9.5 — chiffres, indices et scores composites.
 *
 * STRATEGIE : rendre la violation impossible plutot que la detecter.
 *
 * §9.5 interdit "de la logique qui fusionne silencieusement deux scores
 * heterogenes". Un simple controle a posteriori ne suffirait pas : il faudrait
 * qu'un agent pense a l'appeler. Ici, le typage rend la fusion silencieuse non
 * ecrivable :
 *
 *  - EP-005 : on ne peut pas construire un `Indicator` sans couverture,
 *    fraicheur, methode et incertitude. Si ces elements manquent, il n'existe
 *    aucun moyen d'obtenir un chiffre : il faut passer par `qualify()`, qui
 *    rend du texte.
 *  - EP-006 : `combine()` refuse deux indicateurs d'instruments differents
 *    tant qu'on n'a pas fourni une ponderation explicite ET les limites de
 *    comparabilite. Le resultat conserve la trace de ses composants.
 */

/** Identifie l'instrument de mesure. Deux instruments differents ne se moyennent pas. */
export interface Instrument {
  /** Ex : "acled-conflict-risk", "imf-weo-gdp-growth". */
  id: string;
  /** Ce que l'instrument mesure reellement, en une phrase. */
  measures: string;
  /** Unite ou echelle. Ex : "index 0-100", "% annuel". */
  unit: string;
}

/**
 * EP-005 — les quatre justifications obligatoires pour avoir le droit de
 * chiffrer. Aucune n'est optionnelle : c'est le prix d'un nombre.
 */
export interface Justification {
  /** Couverture des donnees : quelle part du perimetre est reellement couverte. */
  coverage: string;
  /** Fraicheur : date d'observation la plus recente et cadence de mise a jour. */
  freshness: string;
  /** Methode reproductible : formule ou procedure, assez precise pour etre refaite. */
  method: string;
  /** Incertitude assumee : marge, intervalle, ou limites connues. */
  uncertainty: string;
}

export interface Indicator {
  readonly instrument: Instrument;
  readonly value: number;
  readonly justification: Justification;
  /** Agent qui a produit la valeur (EP-002 : la methode pointe vers son auteur). */
  readonly producedBy: string;
}

export class ProtocolScoringError extends Error {
  constructor(
    message: string,
    readonly clause: string,
  ) {
    super(`[${clause}] ${message}`);
    this.name = "ProtocolScoringError";
  }
}

const NON_EMPTY = (s: string): boolean => s.trim().length > 0;

/**
 * EP-005 — unique constructeur d'`Indicator`. Rejette toute justification
 * incomplete : sans elle, "l'agent ne doit pas chiffrer, il doit qualifier".
 */
export function score(input: {
  instrument: Instrument;
  value: number;
  justification: Justification;
  producedBy: string;
}): Indicator {
  const { justification: j } = input;
  const missing = (
    [
      ["coverage", j.coverage],
      ["freshness", j.freshness],
      ["method", j.method],
      ["uncertainty", j.uncertainty],
    ] as const
  )
    .filter(([, v]) => !NON_EMPTY(v))
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new ProtocolScoringError(
      `Justification incomplete (${missing.join(", ")}) pour "${input.instrument.id}". ` +
        `Sans couverture, fraicheur, methode et incertitude, ne pas chiffrer : utiliser qualify().`,
      "EP-005",
    );
  }
  if (!Number.isFinite(input.value)) {
    throw new ProtocolScoringError(
      `Valeur non finie pour "${input.instrument.id}".`,
      "EP-005",
    );
  }
  return Object.freeze({ ...input });
}

/**
 * EP-005 — la sortie de repli quand on n'a pas de quoi chiffrer honnetement.
 * Rend une qualification textuelle, jamais un nombre.
 */
export function qualify(input: {
  instrument: Pick<Instrument, "id" | "measures">;
  assessment: string;
  reasonNotQuantified: string;
  producedBy: string;
}): string {
  return (
    `${input.assessment} (lecture qualitative de ${input.instrument.measures}, ` +
    `source ${input.instrument.id}, produite par ${input.producedBy} ; ` +
    `non chiffree : ${input.reasonNotQuantified})`
  );
}

/** Ponderation explicite exigee par EP-006 pour tout indicateur composite. */
export interface CompositeSpec {
  id: string;
  /** Poids par `instrument.id`. Doivent couvrir exactement les composants. */
  weights: Record<string, number>;
  /**
   * EP-006 — enonce de ce que les instruments NE mesurent PAS en commun.
   * Ce texte doit accompagner le composite partout ou il est affiche.
   */
  comparabilityLimits: string;
  producedBy: string;
}

export interface CompositeIndicator {
  readonly spec: CompositeSpec;
  readonly value: number;
  /** Les composants restent attaches : un composite n'efface jamais ses sources. */
  readonly components: readonly Indicator[];
  /** Mention obligatoire a afficher avec la valeur. */
  readonly disclosure: string;
}

/**
 * EP-006 / §9.5 — seule voie pour agreger plusieurs indicateurs.
 *
 * Refuse : les poids manquants ou en trop, les poids qui ne somment pas a 1,
 * et une declaration de limites vide. Un composite sans ces trois elements
 * serait exactement la "comparaison illegitime" que le protocole interdit.
 */
export function combine(
  components: readonly Indicator[],
  spec: CompositeSpec,
): CompositeIndicator {
  if (components.length < 2) {
    throw new ProtocolScoringError(
      "Un composite exige au moins deux composants.",
      "EP-006",
    );
  }
  if (!NON_EMPTY(spec.comparabilityLimits)) {
    throw new ProtocolScoringError(
      `Composite "${spec.id}" sans declaration de limites de comparabilite. ` +
        `Deux instruments differents ne mesurent pas la meme chose : le dire est obligatoire.`,
      "EP-006",
    );
  }

  const componentIds = components.map((c) => c.instrument.id);
  const weightIds = Object.keys(spec.weights);

  const unweighted = componentIds.filter((id) => !(id in spec.weights));
  if (unweighted.length > 0) {
    throw new ProtocolScoringError(
      `Composants sans ponderation explicite : ${unweighted.join(", ")}.`,
      "EP-006",
    );
  }
  const orphanWeights = weightIds.filter((id) => !componentIds.includes(id));
  if (orphanWeights.length > 0) {
    throw new ProtocolScoringError(
      `Ponderations sans composant correspondant : ${orphanWeights.join(", ")}.`,
      "EP-006",
    );
  }

  const total = Object.values(spec.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new ProtocolScoringError(
      `Les ponderations de "${spec.id}" somment a ${total}, attendu 1.`,
      "EP-006",
    );
  }

  const value = components.reduce(
    (acc, c) => acc + c.value * (spec.weights[c.instrument.id] ?? 0),
    0,
  );

  const breakdown = components
    .map(
      (c) =>
        `${c.instrument.id} (${c.instrument.measures}, ${c.instrument.unit}) ` +
        `x${spec.weights[c.instrument.id]}`,
    )
    .join(" + ");

  return Object.freeze({
    spec,
    value,
    components: Object.freeze([...components]),
    disclosure:
      `Indicateur composite "${spec.id}" = ${breakdown}. ` +
      `Limites de comparabilite : ${spec.comparabilityLimits} ` +
      `(produit par ${spec.producedBy}).`,
  });
}
