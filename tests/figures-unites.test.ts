/**
 * EP-006 applique SANS condamner l'article.
 *
 * Ecrits AVANT le code (TDD).
 *
 * NE D'UN REFUS REEL, le 2026-09-13. Un article sur un seisme de magnitude 6,5
 * en Indonesie — exactement le genre que l'editeur demande — a ete refuse au
 * controle final : il portait deux chiffres structures d'unites differentes,
 * « magnitude » et « personnes exposees ». La regle a raison sur le fond : les
 * classer dans un meme tableau affirmerait une comparabilite qui n'existe pas.
 *
 * Mais elle frappait APRES tous les appels au modele, et elle condamne un
 * genre entier : un evenement a toujours une magnitude ET une population
 * touchee. Le message de la regle indique lui-meme le remede — « retirer le
 * chiffre structure des claims qui ne se comparent pas ». C'est donc du code
 * qui l'applique, avant la redaction, et qui le DECLARE.
 *
 * Ce qui n'est jamais touche : le TEXTE de la claim. Le chiffre reste dans la
 * phrase, avec son unite ; seul le champ destine au tableau part.
 */

import { describe, expect, it } from "vitest";

import { unifierUnitesDesFigures } from "../src/protocol/figures.js";
import { claim } from "./helpers.js";

const avec = (id: string, unit: string, value: number, label: string) =>
  claim({ id, figure: { label, value, unit, as_of: "2026-09-11" } });

describe("unifierUnitesDesFigures", () => {
  it("ne touche a rien quand toutes les unites concordent", () => {
    const claims = [avec("c1", "magnitude", 6.5, "Seisme A"), avec("c2", "magnitude", 5.9, "Seisme B")];
    const r = unifierUnitesDesFigures(claims);
    expect(r.claims).toEqual(claims);
    expect(r.retirees).toEqual([]);
  });

  it("garde l'unite MAJORITAIRE et retire les autres chiffres du tableau", () => {
    const r = unifierUnitesDesFigures([
      avec("c1", "magnitude", 6.5, "Magnitude du seisme"),
      avec("c2", "personnes", 20000, "Population exposee"),
      avec("c3", "magnitude", 5.9, "Magnitude du second seisme"),
    ]);
    expect(r.claims.find((c) => c.id === "c1")?.figure).toBeDefined();
    expect(r.claims.find((c) => c.id === "c3")?.figure).toBeDefined();
    expect(r.claims.find((c) => c.id === "c2")?.figure).toBeUndefined();
  });

  it("dit CE QUI a ete retire, et pourquoi : le lecteur doit pouvoir le savoir", () => {
    const r = unifierUnitesDesFigures([
      avec("c1", "magnitude", 6.5, "Magnitude du seisme"),
      avec("c2", "personnes", 20000, "Population exposee"),
      avec("c3", "magnitude", 5.9, "Magnitude du second seisme"),
    ]);
    expect(r.retirees).toHaveLength(1);
    expect(r.retirees[0]).toMatch(/c2/);
    expect(r.retirees[0]).toMatch(/personnes/);
    expect(r.retirees[0]).toMatch(/magnitude/);
  });

  it("ne touche JAMAIS au texte de la claim : le chiffre reste dans la phrase", () => {
    const texte = "Le seisme a potentiellement expose 20 000 personnes dans un rayon de 100 km.";
    const r = unifierUnitesDesFigures([
      avec("c1", "magnitude", 6.5, "Magnitude"),
      claim({
        id: "c2",
        text: texte,
        figure: { label: "Population exposee", value: 20000, unit: "personnes", as_of: "2026-09-11" },
      }),
    ]);
    expect(r.claims.find((c) => c.id === "c2")?.text).toBe(texte);
  });

  it("a egalite, retient l'unite du premier chiffre : un choix arbitraire mais REPRODUCTIBLE", () => {
    // Deux generations du meme article doivent produire le meme tableau, sinon
    // l'empreinte de relecture change sans que rien n'ait bouge.
    const claims = [avec("c1", "magnitude", 6.5, "A"), avec("c2", "personnes", 20000, "B")];
    const r = unifierUnitesDesFigures(claims);
    expect(r.claims.find((c) => c.id === "c1")?.figure?.unit).toBe("magnitude");
    expect(r.claims.find((c) => c.id === "c2")?.figure).toBeUndefined();
    expect(unifierUnitesDesFigures(claims)).toEqual(r);
  });

  it("ignore la casse et les espaces : « Magnitude » et « magnitude » sont une seule unite", () => {
    const r = unifierUnitesDesFigures([
      avec("c1", "Magnitude", 6.5, "A"),
      avec("c2", " magnitude ", 5.9, "B"),
    ]);
    expect(r.retirees).toEqual([]);
  });

  it("laisse passer un article sans aucun chiffre structure", () => {
    const claims = [claim({ id: "c1" }), claim({ id: "c2" })];
    expect(unifierUnitesDesFigures(claims)).toEqual({ claims, retirees: [] });
  });
});
