/**
 * §5.1 — application de la selection du Veilleur.
 *
 * L'enjeu de ces tests : l'ordre rendu par le Veilleur decide de ce qui sera
 * publie, puisque l'etape suivante plafonne a 3 claims (§3). Si l'ordre est
 * perdu, le plafond tranche au hasard et l'arbitrage editorial est annule.
 */

import { describe, expect, it } from "vitest";

import { applySelection, type VeilleurOutput } from "../src/agents/veilleur.js";
import type { RawEvent } from "../src/protocol/schema.js";

const event = (url: string, source: string): RawEvent => ({
  source,
  url,
  date_observed: "2026-08-27T09:00:00Z",
  date_published: null,
  tier: 1,
  type: "donnee-macro",
  resume: `Observation de ${source}.`,
});

const output = (urls: string[]): VeilleurOutput => ({
  retained: urls.map((url) => ({ url, selection_reason: "primaire" })),
  set_aside: [],
  freshness_assessment: "n/a",
  primary_source_available: true,
});

const A = event("https://fred.stlouisfed.org/series/A", "FRED");
const B = event("https://api.worldbank.org/b", "Banque mondiale");
const C = event("https://www.imf.org/c", "FMI");

describe("applySelection", () => {
  it("respecte l'ordre du Veilleur, pas celui de la collecte", () => {
    // Collecte : B, C, A. Priorite du Veilleur : A, B.
    const selected = applySelection([B, C, A], output([A.url, B.url]));
    expect(selected.map((e) => e.source)).toEqual(["FRED", "Banque mondiale"]);
  });

  it("ecarte les evenements non retenus", () => {
    const selected = applySelection([A, B, C], output([B.url]));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.source).toBe("Banque mondiale");
  });

  it("ignore une URL retenue absente du lot collecte", () => {
    // Un agent ne doit pas pouvoir faire entrer une source en l'inventant.
    const selected = applySelection(
      [A],
      output([A.url, "https://source-inventee.example/x"]),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.url).toBe(A.url);
  });

  it("dedoublonne une URL retenue deux fois", () => {
    const selected = applySelection([A, B], output([A.url, A.url, B.url]));
    expect(selected.map((e) => e.url)).toEqual([A.url, B.url]);
  });

  it("rend un lot vide quand rien n'est retenu", () => {
    expect(applySelection([A, B], output([]))).toHaveLength(0);
  });
});
