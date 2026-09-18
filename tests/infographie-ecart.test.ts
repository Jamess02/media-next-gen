/**
 * INFOGRAPHIE — ecart mesure et decomposition.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Ce module porte les regles DURES du brief editorial du 2026-09-18, celles
 * qu'un prompt ne peut pas garantir :
 *
 *  - sans anticipation datee ET sourcee, aucun ecart n'est calcule ;
 *  - les composantes s'additionnent, et un RESIDU explicite absorbe ce qu'elles
 *    n'expliquent pas — on ne force jamais une explication complete ;
 *  - chaque composante porte sa valeur, sa methode et sa source ; une
 *    estimation interne est etiquetee comme telle ;
 *  - zero composante est une reponse valable : mieux vaut l'ecart nu qu'une
 *    decomposition fabriquee.
 *
 * Le graphique n'est que la mise en forme de ce calcul. S'il etait produit
 * autrement — par un modele, par une extraction de texte — il afficherait avec
 * l'autorite d'un schema ce que personne n'a verifie.
 */

import { describe, expect, it } from "vitest";

import { calculerEcart, type EntreeEcart } from "../src/infographie/ecart.js";

const BASE: EntreeEcart = {
  indicateur: "inflation_zone_euro_hicp",
  libelle: "Inflation annuelle, zone euro (IPCH)",
  unite: "points de %",
  anticipe: {
    value: 2.1,
    source: "https://www.ecb.europa.eu/projections-2026-06",
    date: "2026-06-12",
  },
  realise: {
    value: 2.47,
    source: "https://ec.europa.eu/eurostat/prc_hicp_manr",
    date: "2026-07-13",
  },
  composantes: [],
};

describe("ecart mesure", () => {
  it("vaut realise moins anticipe, dans l'unite de l'indicateur", () => {
    const r = calculerEcart(BASE);
    if (!r.ok) throw new Error(`attendu : calcule — ${r.motif}`);
    expect(r.ecart.ecart).toBeCloseTo(0.37, 10);
    expect(r.ecart.unite).toBe("points de %");
  });

  it("REFUSE de calculer un ecart sans anticipation sourcee", () => {
    const r = calculerEcart({ ...BASE, anticipe: { ...BASE.anticipe, source: "  " } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motif).toMatch(/anticipation/i);
    expect(r.motif).toMatch(/source/i);
  });

  it("REFUSE de calculer un ecart sans anticipation datee", () => {
    const r = calculerEcart({ ...BASE, anticipe: { ...BASE.anticipe, date: "" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motif).toMatch(/datee|date/i);
  });

  it("REFUSE un realise non date ou non source : la moitie d'une preuve n'en est pas une", () => {
    expect(calculerEcart({ ...BASE, realise: { ...BASE.realise, source: "" } }).ok).toBe(false);
    expect(calculerEcart({ ...BASE, realise: { ...BASE.realise, date: "" } }).ok).toBe(false);
  });

  it("REFUSE une valeur non numerique : un trou n'est pas un zero", () => {
    const r = calculerEcart({
      ...BASE,
      realise: { ...BASE.realise, value: null as unknown as number },
    });
    expect(r.ok).toBe(false);
  });
});

describe("decomposition", () => {
  const composantes = [
    {
      name: "energie",
      value: 0.25,
      method: "publiee" as const,
      source: "https://ec.europa.eu/eurostat/contributions",
    },
    {
      name: "services",
      value: 0.08,
      method: "estimee" as const,
      source: "calcul interne : contribution ponderee par les poids IPCH 2026",
    },
  ];

  it("rend TOUJOURS un residu, meme quand il est nul", () => {
    const r = calculerEcart({
      ...BASE,
      composantes: [{ ...composantes[0]!, value: 0.37 }],
    });
    if (!r.ok) throw new Error(r.motif);
    expect(r.ecart.residu).toBe(0);
  });

  it("le residu absorbe ce que les composantes n'expliquent pas", () => {
    const r = calculerEcart({ ...BASE, composantes });
    if (!r.ok) throw new Error(r.motif);
    // 0.37 - (0.25 + 0.08) = 0.04
    expect(r.ecart.residu).toBeCloseTo(0.04, 10);
  });

  it("accepte ZERO composante : le residu vaut alors l'ecart entier", () => {
    const r = calculerEcart(BASE);
    if (!r.ok) throw new Error(r.motif);
    expect(r.ecart.composantes).toEqual([]);
    expect(r.ecart.residu).toBeCloseTo(0.37, 10);
  });

  it("exige de chaque composante une source et une methode connue", () => {
    const sansSource = calculerEcart({
      ...BASE,
      composantes: [{ ...composantes[0]!, source: "" }],
    });
    expect(sansSource.ok).toBe(false);
    if (!sansSource.ok) expect(sansSource.motif).toMatch(/energie/);

    const methodeInconnue = calculerEcart({
      ...BASE,
      composantes: [
        { ...composantes[0]!, method: "officielle" as unknown as "publiee" },
      ],
    });
    expect(methodeInconnue.ok).toBe(false);
  });

  it("signale les composantes ESTIMEES : elles ne se presentent jamais comme officielles", () => {
    const r = calculerEcart({ ...BASE, composantes });
    if (!r.ok) throw new Error(r.motif);
    expect(r.ecart.estimationsInternes).toEqual(["services"]);
  });

  it("n'invente aucune precision : le residu garde celle de l'ecart", () => {
    // 0.1 + 0.2 vaut 0.30000000000000004 en flottant. Un residu qui trainerait
    // ces decimales afficherait une precision que la mesure n'a pas (EP-005).
    const r = calculerEcart({
      ...BASE,
      anticipe: { ...BASE.anticipe, value: 2 },
      realise: { ...BASE.realise, value: 2.3 },
      composantes: [
        { ...composantes[0]!, value: 0.1 },
        { ...composantes[1]!, value: 0.2 },
      ],
    });
    if (!r.ok) throw new Error(r.motif);
    expect(r.ecart.residu).toBe(0);
  });
});

describe("comparabilite (EP-006)", () => {
  it("REFUSE une anticipation et un realise d'unites differentes", () => {
    const r = calculerEcart({
      ...BASE,
      anticipe: { ...BASE.anticipe, unite: "milliards d'euros" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motif).toMatch(/unite/i);
  });
});
