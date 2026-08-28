/**
 * EP-005, EP-006, §9.5 — chiffres et indicateurs composites.
 */

import { describe, expect, it } from "vitest";

import {
  ProtocolScoringError,
  combine,
  qualify,
  score,
  type Indicator,
  type Instrument,
} from "../src/protocol/scoring.js";

const conflictInstrument: Instrument = {
  id: "acled-conflict-risk",
  measures: "intensite d'evenements de conflit armes rapportes",
  unit: "index 0-100",
};

const macroInstrument: Instrument = {
  id: "imf-weo-gdp-growth",
  measures: "croissance du PIB reel projetee",
  unit: "% annuel",
};

const fullJustification = {
  coverage: "38 des 47 provinces couvertes",
  freshness: "derniere observation 2026-08-20, mise a jour hebdomadaire",
  method: "moyenne ponderee des evenements par population, formule publiee",
  uncertainty: "+/- 6 points sur les provinces a faible couverture",
};

function indicator(instrument: Instrument, value: number): Indicator {
  return score({
    instrument,
    value,
    justification: fullJustification,
    producedBy: "analyste",
  });
}

describe("EP-005 — pas d'illusion de precision", () => {
  it("refuse un chiffre sans couverture declaree", () => {
    expect(() =>
      score({
        instrument: conflictInstrument,
        value: 62,
        justification: { ...fullJustification, coverage: "" },
        producedBy: "analyste",
      }),
    ).toThrow(ProtocolScoringError);
  });

  it("refuse un chiffre sans incertitude assumee", () => {
    expect(() =>
      score({
        instrument: conflictInstrument,
        value: 62,
        justification: { ...fullJustification, uncertainty: "   " },
        producedBy: "analyste",
      }),
    ).toThrow(/uncertainty/);
  });

  it("accepte un chiffre entierement justifie", () => {
    expect(indicator(conflictInstrument, 62).value).toBe(62);
  });

  it("offre une sortie textuelle quand on ne peut pas chiffrer", () => {
    const text = qualify({
      instrument: conflictInstrument,
      assessment: "Intensite en hausse marquee",
      reasonNotQuantified: "couverture inferieure a 40 % des provinces",
      producedBy: "analyste",
    });
    expect(text).toMatch(/non chiffree/);
    expect(text).not.toMatch(/\d+(?:[.,]\d+)?\s*(?:points|\/100)/);
  });
});

describe("EP-006 / §9.5 — pas de fusion silencieuse", () => {
  const components = [
    indicator(conflictInstrument, 62),
    indicator(macroInstrument, 2.4),
  ];

  it("refuse un composite sans limites de comparabilite declarees", () => {
    expect(() =>
      combine(components, {
        id: "risque-global",
        weights: { "acled-conflict-risk": 0.5, "imf-weo-gdp-growth": 0.5 },
        comparabilityLimits: "",
        producedBy: "analyste",
      }),
    ).toThrow(/limites de comparabilite/);
  });

  it("refuse un composant non pondere", () => {
    expect(() =>
      combine(components, {
        id: "risque-global",
        weights: { "acled-conflict-risk": 1 },
        comparabilityLimits: "Deux instruments distincts.",
        producedBy: "analyste",
      }),
    ).toThrow(/sans ponderation explicite/);
  });

  it("refuse des ponderations qui ne somment pas a 1", () => {
    expect(() =>
      combine(components, {
        id: "risque-global",
        weights: { "acled-conflict-risk": 0.5, "imf-weo-gdp-growth": 0.9 },
        comparabilityLimits: "Deux instruments distincts.",
        producedBy: "analyste",
      }),
    ).toThrow(/somment a/);
  });

  it("produit un composite qui expose sa ponderation et ses limites", () => {
    const composite = combine(components, {
      id: "risque-global",
      weights: { "acled-conflict-risk": 0.5, "imf-weo-gdp-growth": 0.5 },
      comparabilityLimits:
        "ACLED mesure une intensite d'evenements rapportes, le FMI une croissance projetee. Les deux ne sont pas commensurables : l'agregat est une commodite de lecture, pas une mesure.",
      producedBy: "analyste",
    });

    expect(composite.value).toBeCloseTo(32.2);
    expect(composite.disclosure).toMatch(/x0.5/);
    expect(composite.disclosure).toMatch(/ne sont pas commensurables/);
    // Les composants restent attaches : un composite n'efface pas ses sources.
    expect(composite.components).toHaveLength(2);
  });
});
