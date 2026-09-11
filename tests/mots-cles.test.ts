/**
 * Termes de recherche envoyes aux agregateurs de presse.
 *
 * NE D'UN ECHEC REEL, le 2026-09-10. Les adaptateurs Currents et newsdata
 * envoyaient le SUJET ENTIER comme requete :
 *
 *   « inflation annuelle en zone euro : dernier releve publie par Eurostat »
 *
 * Les deux API traitent les mots comme un ET. Une vague complete de six
 * articles les a donc appeles douze fois, sans erreur, pour ZERO observation —
 * un echec parfaitement silencieux : HTTP 200, zero resultat, aucune trace
 * dans le journal d'audit. Les deux sources etaient branchees et inutiles.
 *
 * MESURE du meme jour, sur les deux API :
 *
 *   « inflation annuelle en zone euro : ... »  → 0
 *   « inflation zone euro Eurostat »           → 0
 *   « inflation euro »                         → 15
 *   « inflation »                              → 91
 *   « inflation OR Eurostat »                  → 94
 *
 * D'ou le choix du OU : il elargit au lieu de restreindre, et reste sur le
 * sujet. Le ET se vide des qu'on precise, ce qui est exactement l'inverse du
 * comportement attendu d'une recherche documentaire.
 */

import { describe, expect, it } from "vitest";

import { requeteDeRecherche, termesDeRecherche } from "../src/sources/mots-cles.js";

describe("extraction des termes", () => {
  it("retient les DEUX premiers mots porteurs de sens", () => {
    // « annuelle », « dernier », « releve », « publie » sont des mots outils du
    // vocabulaire de veille : ils decrivent la demarche, pas le sujet.
    //
    // Le resultat est « inflation zone », et non « inflation Eurostat » :
    // MESURE du 2026-09-10, « inflation Eurostat » rend 0 la ou
    // « inflation zone » rend 19, dont l'article de tete porte sur le taux de
    // depot de la BCE. Les deux PREMIERS termes valent mieux que les deux plus
    // rares.
    const t = termesDeRecherche("inflation annuelle en zone euro : dernier releve publie par Eurostat");
    expect(t).toEqual(["inflation", "zone"]);
  });

  it("ecarte les mots outils et la ponctuation", () => {
    const t = termesDeRecherche("bilan de la Reserve federale : niveau de l'actif total");
    for (const mot of ["de", "la", "l", ":", "'"]) {
      expect(t, mot).not.toContain(mot);
    }
  });

  it("ecarte les mots trop courts pour discriminer", () => {
    expect(termesDeRecherche("le et la un")).toEqual([]);
  });

  it("dedoublonne sans tenir compte de la casse", () => {
    const t = termesDeRecherche("Inflation et inflation encore inflation ailleurs");
    expect(t.filter((x) => x.toLowerCase() === "inflation")).toHaveLength(1);
  });

  it("borne le nombre de termes : au-dela, la requete se dilue", () => {
    const t = termesDeRecherche(
      "inflation croissance chomage salaires production consommation investissement exportations",
    );
    expect(t.length).toBeLessThanOrEqual(2);
  });

  it("garde l'ordre du sujet : les premiers mots portent l'intention", () => {
    const t = termesDeRecherche("inflation zone euro Eurostat croissance chomage");
    expect(t[0]).toBe("inflation");
  });
});

describe("construction de la requete", () => {
  it("joint deux termes en ET, sans ponctuation", () => {
    // Le OU a ete essaye puis ABANDONNE : il ramenait 324 resultats dont
    // « le syndrome de Kessler » et « des ballons a Rouen ». Six observations
    // hors sujet coutent plus cher que zero.
    const q = requeteDeRecherche("inflation annuelle en zone euro : releve Eurostat");
    expect(q).not.toContain(" OR ");
    expect(q).not.toContain(":");
    expect(q.split(" ")).toHaveLength(2);
  });

  it("n'envoie JAMAIS la phrase entiere", () => {
    const sujet = "bilan de la Reserve federale : niveau de l'actif total";
    expect(requeteDeRecherche(sujet)).not.toBe(sujet);
  });

  it("rend un terme seul tel quel", () => {
    expect(requeteDeRecherche("inflation")).toBe("inflation");
  });

  it("retombe sur le sujet nettoye quand aucun terme ne survit", () => {
    // Mieux vaut une requete faible qu'une requete VIDE, qui rendrait la
    // source muette sans que rien ne le signale.
    expect(requeteDeRecherche("le PIB et la TVA").length).toBeGreaterThan(0);
  });
});
