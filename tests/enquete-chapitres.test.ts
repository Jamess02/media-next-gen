/**
 * Ecriture de l'enquete CHAPITRE PAR CHAPITRE.
 *
 * NE D'UNE MESURE, pas d'une preference. Trois executions reelles, meme sujet,
 * une seule requete par enquete :
 *
 *   gemini-3.5-flash-lite      496 mots, aucun chapitre
 *   idem + rendu des sections  640 mots
 *   gemini-3.6-flash           990 mots, chapitres presents
 *
 * Aucun ne franchit le plancher de 1500 mots, et ce n'est ni un plafond de
 * tokens (8192, verifie) ni un defaut de code : demander 1500 a 3000 mots
 * structures en UNE reponse depasse ce que ces modeles produisent.
 *
 * CE QUE CE DECOUPAGE CORRIGE VRAIMENT
 *
 * Le cahier des charges demandait « un temps de recherche et de verification
 * plus long par article ». La lenteur avait ete implementee comme un QUOTA —
 * une enquete par semaine — mais pas comme un TRAVAIL plus long : l'enquete se
 * faisait en un appel, comme une breve. Un appel par chapitre rend le travail
 * reellement plus long, et donne a chaque partie toute l'attention du modele.
 *
 * LES CHAPITRES OBLIGATOIRES SONT GARANTIS PAR LE CODE. Le plan du modele est
 * complete s'il en oublie : demander au modele de ne pas oublier le chapitre
 * contradictoire, c'est esperer ; l'ajouter quand il manque, c'est l'obtenir.
 */

import { describe, expect, it } from "vitest";

import {
  ROLES_OBLIGATOIRES,
  completerChapitres,
  rendreCorpsEnquete,
} from "../src/agents/investigateur.js";

describe("completion du plan — les chapitres obligatoires ne s'oublient pas", () => {
  it("ajoute le chapitre CONTRADICTOIRE quand le plan l'omet", () => {
    const complete = completerChapitres([
      { role: "etabli", titre: "Ce que les donnees etablissent", angle: "les chiffres" },
      { role: "mecanisme", titre: "Le mecanisme", angle: "la transmission" },
    ]);
    expect(complete.map((c) => c.role)).toContain("contradictoire");
  });

  it("ajoute le chapitre des ECHEANCES quand le plan l'omet", () => {
    const complete = completerChapitres([
      { role: "etabli", titre: "Les faits", angle: "les chiffres" },
    ]);
    expect(complete.map((c) => c.role)).toContain("echeances");
  });

  it("garantit TOUS les roles obligatoires, meme sur un plan vide", () => {
    const roles = completerChapitres([]).map((c) => c.role);
    for (const r of ROLES_OBLIGATOIRES) expect(roles, r).toContain(r);
  });

  it("conserve le titre du modele quand le chapitre existe deja", () => {
    // Un titre trouve par le modele vaut mieux qu'un intitule generique : on
    // ne complete que ce qui MANQUE.
    const complete = completerChapitres([
      { role: "contradictoire", titre: "Ce qui plaide en sens inverse", angle: "la these adverse" },
    ]);
    const c = complete.find((x) => x.role === "contradictoire");
    expect(c?.titre).toBe("Ce qui plaide en sens inverse");
  });

  it("place les echeances EN DERNIER : c'est une conclusion", () => {
    const complete = completerChapitres([
      { role: "echeances", titre: "A surveiller", angle: "la suite" },
      { role: "etabli", titre: "Les faits", angle: "les chiffres" },
    ]);
    expect(complete[complete.length - 1]?.role).toBe("echeances");
  });

  it("ne duplique jamais un role", () => {
    const complete = completerChapitres([
      { role: "contradictoire", titre: "A", angle: "a" },
      { role: "contradictoire", titre: "B", angle: "b" },
    ]);
    expect(complete.filter((c) => c.role === "contradictoire")).toHaveLength(1);
  });
});

describe("assemblage du corps depuis les chapitres ecrits", () => {
  const rendu = rendreCorpsEnquete({
    resume_en_bref: "Le fait, sa portee, ce qui reste incertain.",
    chapitres: [
      { titre: "Ce que les donnees etablissent", corps: "Premier paragraphe [[claim-1]]." },
      { titre: "Le versant rassurant", corps: "La lecture inverse se defend ainsi." },
      { titre: "Prochaines echeances a surveiller", corps: "Ce qui trancherait." },
    ],
    glossaire: [{ terme: "IPCH", definition: "indice harmonise" }],
    bibliographie: { primaires: ["Eurostat"], secondaires: [], hypotheses: [] },
  });

  it("titre chaque chapitre en niveau 2, pour que le gate les reconnaisse", () => {
    expect(rendu).toContain("## Ce que les donnees etablissent");
    expect(rendu).toContain("## Le versant rassurant");
  });

  it("conserve la prose de chaque chapitre", () => {
    expect(rendu).toContain("Premier paragraphe [[claim-1]].");
    expect(rendu).toContain("La lecture inverse se defend ainsi.");
  });

  it("respecte l'ordre des chapitres", () => {
    expect(rendu.indexOf("Le versant rassurant")).toBeLessThan(
      rendu.indexOf("Prochaines echeances"),
    );
  });

  it("place le resume avant tout chapitre", () => {
    expect(rendu.indexOf("Le fait, sa portee")).toBeLessThan(
      rendu.indexOf("## Ce que les donnees etablissent"),
    );
  });

  it("n'affiche pas de rubrique bibliographique vide", () => {
    expect(rendu).toContain("### Sources primaires");
    expect(rendu).not.toMatch(/###[^\n]*sources? secondaires?/i);
  });

  it("produit un corps que les regles du format long acceptent", async () => {
    // Verification de bout en bout : le rendu doit satisfaire le gate, pas
    // seulement ressembler a ce qu'il attend.
    const { runEditorialGate } = await import("../src/protocol/rules.js");
    const { article, claim } = await import("./helpers.js");
    const long = rendreCorpsEnquete({
      resume_en_bref: "Resume.",
      chapitres: [
        {
          titre: "Ce que les donnees etablissent",
          corps: Array.from({ length: 1600 }, (_, i) => `mot${i % 91}`).join(" "),
        },
        { titre: "Le versant rassurant", corps: "La lecture inverse." },
        { titre: "Prochaines echeances a surveiller", corps: "Ce qui trancherait." },
      ],
      glossaire: [{ terme: "IPCH", definition: "indice" }],
      bibliographie: { primaires: ["Eurostat"], secondaires: [], hypotheses: [] },
    });
    const noms = runEditorialGate(
      article({ mode: "enquete", claims: [claim()], body: long }),
    ).violations.map((v) => v.rule);
    for (const r of [
      "ENQUETE_TROP_COURTE",
      "ENQUETE_SANS_CONTRADICTOIRE",
      "ENQUETE_SANS_ECHEANCES",
      "ENQUETE_SANS_GLOSSAIRE",
      "ENQUETE_BIBLIO_NON_SEPAREE",
    ]) {
      expect(noms, r).not.toContain(r);
    }
  });
});
