/**
 * INFOGRAPHIE — le contrat §7 et la regle qui bloque.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le brief du 2026-09-18 confie trois roles distincts : l'Analyste PRODUIT les
 * donnees du graphique, le Redacteur les integre, et le fact-checker « bloque
 * tout graphique dont une composante n'est pas tracable ». Ce dernier point est
 * une regle dure : il ne peut pas reposer sur la vigilance d'un modele.
 *
 * DEUX DECISIONS DE CONCEPTION, que ces tests fixent.
 *
 * 1. LE CONTRAT PORTE L'ENTREE, JAMAIS L'ECART. `ecart` et `residu` ne sont pas
 *    des champs du §7 : ils sont CALCULES par `calculerEcart`. Si l'Analyste
 *    les annoncait, il pourrait annoncer un ecart qui ne correspond pas a ses
 *    propres chiffres, et le graphique afficherait autre chose que les donnees.
 *    C'est le principe deja applique au tableau des chiffres : le modele decide
 *    ce qui est mesure, pas le rang, qui est calcule.
 *
 * 2. LE CHAMP EST OPTIONNEL, et doit le rester. `ArticleSchema` est `.strict()`
 *    et les articles anterieurs n'en portent pas ; le rendre obligatoire
 *    invaliderait d'un coup tous les brouillons existants ainsi que les
 *    attestations de relecture, dont l'empreinte couvre l'article entier.
 *    C'est la raison deja ecrite pour `mode` et `chapitres`.
 */

import { describe, expect, it } from "vitest";

import { ArticleSchema, type Article } from "../src/protocol/schema.js";
import { runEditorialGate, type Violation } from "../src/protocol/rules.js";
import { article } from "./helpers.js";

/** Entree d'infographie bien formee, au sens du brief. */
const INFOGRAPHIE = {
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
  composantes: [
    {
      name: "energie",
      value: 0.25,
      method: "publiee",
      source: "https://ec.europa.eu/eurostat/contributions",
    },
    {
      name: "services",
      value: 0.08,
      method: "estimee",
      source: "calcul interne : contributions ponderees par les poids IPCH 2026",
    },
  ],
};

/** Article portant une infographie, avant que le type ne connaisse le champ. */
function avecInfographie(infographie: unknown): Article {
  return article({ infographie } as unknown as Partial<Article>);
}

const violationsDe = (a: Article, rule: string): Violation[] =>
  runEditorialGate(a).violations.filter((v) => v.rule === rule);

const NON_TRACABLE = "INFOGRAPHIE_NON_TRACABLE";

/* -------------------------------------------------------------------------
 * Le contrat §7
 * ---------------------------------------------------------------------- */

describe("contrat §7 — le champ infographie", () => {
  it("reste OPTIONNEL : un article sans infographie demeure valide", () => {
    // Les articles publies avant ce champ n'en portent pas, et leur attestation
    // de relecture couvre l'article entier : le rendre obligatoire invaliderait
    // d'un coup tout l'existant.
    expect(ArticleSchema.safeParse(article()).success).toBe(true);
  });

  it("accepte une infographie bien formee", () => {
    const parsed = ArticleSchema.safeParse(avecInfographie(INFOGRAPHIE));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REFUSE une methode inconnue", () => {
    const parsed = ArticleSchema.safeParse(
      avecInfographie({
        ...INFOGRAPHIE,
        composantes: [{ ...INFOGRAPHIE.composantes[0]!, method: "officielle" }],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("REFUSE une composante sans source, des le contrat", () => {
    const parsed = ArticleSchema.safeParse(
      avecInfographie({
        ...INFOGRAPHIE,
        composantes: [{ ...INFOGRAPHIE.composantes[0]!, source: "" }],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("REFUSE un champ invente : le schema est strict", () => {
    const parsed = ArticleSchema.safeParse(
      avecInfographie({ ...INFOGRAPHIE, commentaire: "libre" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("REFUSE que l'ecart soit DECLARE : il est calcule, jamais annonce", () => {
    // Un ecart annonce pourrait ne pas correspondre aux chiffres qui
    // l'accompagnent — et c'est le graphique qui mentirait, avec l'autorite
    // d'un schema.
    expect(
      ArticleSchema.safeParse(avecInfographie({ ...INFOGRAPHIE, ecart: 0.37 })).success,
    ).toBe(false);
    expect(
      ArticleSchema.safeParse(avecInfographie({ ...INFOGRAPHIE, residu: 0.04 })).success,
    ).toBe(false);
  });

  it("REFUSE une anticipation non datee", () => {
    const parsed = ArticleSchema.safeParse(
      avecInfographie({ ...INFOGRAPHIE, anticipe: { ...INFOGRAPHIE.anticipe, date: "" } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepte ZERO composante : l'ecart nu est une reponse valable", () => {
    const parsed = ArticleSchema.safeParse(
      avecInfographie({ ...INFOGRAPHIE, composantes: [] }),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * La regle bloquante
 * ---------------------------------------------------------------------- */

describe("gate — une infographie non tracable BLOQUE", () => {
  it("laisse passer un article sans infographie", () => {
    expect(violationsDe(article(), NON_TRACABLE)).toHaveLength(0);
  });

  it("laisse passer une infographie dont tout est tracable", () => {
    const resultat = runEditorialGate(avecInfographie(INFOGRAPHIE));
    expect(resultat.violations.filter((v) => v.rule === NON_TRACABLE)).toHaveLength(0);
    expect(resultat.passed, JSON.stringify(resultat.violations)).toBe(true);
  });

  it("BLOQUE une anticipation sans source : l'ecart deviendrait une surprise fabriquee", () => {
    const violations = violationsDe(
      avecInfographie({
        ...INFOGRAPHIE,
        anticipe: { ...INFOGRAPHIE.anticipe, source: "   " },
      }),
      NON_TRACABLE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("blocking");
    expect(violations[0]!.message).toMatch(/source/i);
  });

  it("BLOQUE des unites incompatibles entre anticipe et realise (EP-006)", () => {
    const violations = violationsDe(
      avecInfographie({
        ...INFOGRAPHIE,
        anticipe: { ...INFOGRAPHIE.anticipe, unite: "milliards d'euros" },
      }),
      NON_TRACABLE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/unite/i);
  });

  it("rattache la violation au champ, pour que la correction sache ou aller", () => {
    const violations = violationsDe(
      avecInfographie({ ...INFOGRAPHIE, anticipe: { ...INFOGRAPHIE.anticipe, source: "" } }),
      NON_TRACABLE,
    );
    expect(violations[0]!.path).toMatch(/infographie/);
  });

  it("cite le MOTIF du refus, et non un message generique", () => {
    // Le motif vient de `calculerEcart`, donc d'un calcul teste : le gate ne
    // reformule pas, il transmet. Un message generique obligerait le relecteur
    // a rouvrir les donnees pour comprendre ce qui cloche.
    const violations = violationsDe(
      avecInfographie({
        ...INFOGRAPHIE,
        composantes: [{ ...INFOGRAPHIE.composantes[0]!, name: "energie", source: "  " }],
      }),
      NON_TRACABLE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/energie/);
  });
});
