/**
 * §5.3 — regles opposables du format ENQUETE.
 *
 * Le cahier des charges decrit une structure : resume en tete, chapitres
 * thematiques, chapitre contradictoire, conclusion tournee vers les echeances,
 * glossaire, bibliographie separant primaire / secondaire / hypothese.
 *
 * POURQUOI CES REGLES PLUTOT QU'UN BRIEF DETAILLE
 *
 * Le Redacteur a deja fourni la demonstration : ses consignes ne portaient que
 * sur la forme des references, et il a rendu des corps de 107 mots colles sous
 * leurs propres marqueurs. Le §7 etait respecte a la lettre, et personne
 * n'avait redige. Un brief est une suggestion ; une regle testee est une
 * contrainte.
 *
 * Le risque propre au format long est different et plus insidieux : un modele
 * atteint 1500 mots sans difficulte en delayant. Les regles ci-dessous portent
 * donc sur ce qui ne se delaye pas — la presence du chapitre contradictoire,
 * la separation des sources, l'absence d'affirmation chiffree non reliee.
 */

import { describe, expect, it } from "vitest";

import { runEditorialGate } from "../src/protocol/rules.js";
import { article, claim } from "./helpers.js";

const regles = (a: Parameters<typeof runEditorialGate>[0]) =>
  runEditorialGate(a).violations.map((v) => v.rule);

/** Corps d'enquete conforme, servant de base aux variantes. */
function corpsEnquete(mots = 1600): string {
  const remplissage = Array.from(
    { length: mots },
    (_, i) => `terme${i % 97}`,
  ).join(" ");
  return [
    "## L'essentiel en trois minutes",
    "Le fait etabli, ce qu'il engage, et ce qui reste incertain [[claim-1]].",
    "",
    "## Ce que les donnees etablissent",
    remplissage,
    "",
    "## Ou se deplace le risque",
    "La tension se deplace vers le financement a court terme.",
    "",
    "## Le mecanisme",
    "Voici comment la transmission opere, etape par etape.",
    "",
    "## Le versant rassurant",
    "La lecture inverse merite d'etre prise au serieux : plusieurs elements la soutiennent.",
    "",
    "## Prochaines echeances a surveiller",
    "Les publications a venir trancheront ce que les donnees actuelles laissent ouvert.",
    "",
    "## Glossaire",
    "**Terme technique** : definition accessible sans jargon.",
    "",
    "## Bibliographie",
    "### Sources primaires",
    "- Eurostat, serie IPCH.",
    "### Sources secondaires",
    "- Presse specialisee.",
    "### Hypotheses et scenarios",
    "- Lecture prospective, non etablie.",
  ].join("\n");
}

const enquete = (corps: string) =>
  article({ mode: "enquete", claims: [claim()], body: corps });

describe("§5.3 — plancher de longueur propre a l'enquete", () => {
  it("bloque une enquete trop courte pour le format annonce", () => {
    const v = runEditorialGate(enquete(corpsEnquete(200))).violations.find(
      (x) => x.rule === "ENQUETE_TROP_COURTE",
    );
    expect(v?.severity).toBe("blocking");
    expect(v?.message).toMatch(/1500/);
  });

  it("laisse passer une enquete au-dessus du plancher", () => {
    expect(regles(enquete(corpsEnquete()))).not.toContain("ENQUETE_TROP_COURTE");
  });

  it("n'applique PAS ce plancher aux autres modes", () => {
    // Une breve de 300 mots est legitime ; seul le mode `enquete` promet
    // 1500 mots, et une promesse non tenue est le defaut a sanctionner.
    const court = article({ mode: "constat", claims: [claim()] });
    expect(regles(court)).not.toContain("ENQUETE_TROP_COURTE");
  });
});

describe("§5.3 — structure imposee de l'enquete", () => {
  const sans = (titre: string) =>
    corpsEnquete()
      .split("\n")
      .filter((l) => !l.startsWith(`## ${titre}`))
      .join("\n");

  it("exige le chapitre CONTRADICTOIRE", () => {
    // Le plus important des chapitres, et le plus facile a omettre : c'est
    // celui qui oblige a prendre au serieux la lecture inverse. Sans lui,
    // l'enquete devient une demonstration.
    const v = runEditorialGate(enquete(sans("Le versant rassurant"))).violations.find(
      (x) => x.rule === "ENQUETE_SANS_CONTRADICTOIRE",
    );
    expect(v?.severity).toBe("blocking");
  });

  it("exige un GLOSSAIRE", () => {
    expect(regles(enquete(sans("Glossaire")))).toContain("ENQUETE_SANS_GLOSSAIRE");
  });

  it("exige une BIBLIOGRAPHIE qui separe les natures de sources", () => {
    const ampute = corpsEnquete().replace("### Sources primaires", "### Divers");
    expect(regles(enquete(ampute))).toContain("ENQUETE_BIBLIO_NON_SEPAREE");
  });

  it("exige une conclusion tournee vers les ECHEANCES, pas une cloture", () => {
    expect(regles(enquete(sans("Prochaines echeances a surveiller")))).toContain(
      "ENQUETE_SANS_ECHEANCES",
    );
  });

  it("une enquete complete ne declenche AUCUNE de ces regles", () => {
    const r = regles(enquete(corpsEnquete()));
    for (const nom of [
      "ENQUETE_TROP_COURTE",
      "ENQUETE_SANS_CONTRADICTOIRE",
      "ENQUETE_SANS_GLOSSAIRE",
      "ENQUETE_BIBLIO_NON_SEPAREE",
      "ENQUETE_SANS_ECHEANCES",
    ]) {
      expect(r, nom).not.toContain(nom);
    }
  });

  it("n'impose cette structure QU'au mode enquete", () => {
    const constat = article({ mode: "constat", claims: [claim()] });
    const r = regles(constat);
    for (const nom of [
      "ENQUETE_SANS_CONTRADICTOIRE",
      "ENQUETE_SANS_GLOSSAIRE",
      "ENQUETE_BIBLIO_NON_SEPAREE",
      "ENQUETE_SANS_ECHEANCES",
    ]) {
      expect(r, nom).not.toContain(nom);
    }
  });
});

describe("§4 — la bibliographie n'exige pas d'inventer des sources", () => {
  /**
   * DEFAUT DE MA PROPRE REGLE, constate le 2026-09-11 sur une enquete reelle.
   *
   * La regle exigeait les TROIS rubriques remplies. Une enquete adossee
   * uniquement a des sources primaires — Eurostat, Banque mondiale, FMI — n'a
   * legitimement aucune source secondaire, et se voyait bloquee.
   *
   * La regle punissait donc le cas IDEAL, et poussait a inventer des
   * references de presse pour franchir un controle cense garantir la
   * tracabilite. Exactement l'inverse de son objet.
   *
   * Ce qui doit etre exige, c'est que la nature des sources soit DISTINGUEE
   * quand il y en a plusieurs — pas qu'il y en ait de chaque sorte.
   */
  const corpsSansSecondaires = corpsEnquete()
    .split("\n")
    .filter((l) => !/### Sources secondaires|^- Presse/.test(l))
    .join("\n");

  it("accepte une enquete fondee UNIQUEMENT sur des sources primaires", () => {
    expect(regles(enquete(corpsSansSecondaires))).not.toContain(
      "ENQUETE_BIBLIO_NON_SEPAREE",
    );
  });

  it("exige toujours la rubrique des sources PRIMAIRES", () => {
    // Une enquete sans source primaire n'est pas une enquete : c'est un
    // commentaire. Cette rubrique-la reste obligatoire.
    const sansPrimaires = corpsEnquete().replace("### Sources primaires", "### Divers");
    expect(regles(enquete(sansPrimaires))).toContain("ENQUETE_BIBLIO_NON_SEPAREE");
  });

  it("exige toujours une bibliographie", () => {
    const sansBiblio = corpsEnquete()
      .split("\n")
      .filter((l) => !/^#{2,3} (Bibliographie|Sources|Hypotheses)/.test(l))
      .join("\n");
    expect(regles(enquete(sansBiblio))).toContain("ENQUETE_BIBLIO_NON_SEPAREE");
  });
});

describe("§5.3 — le ROLE d'un chapitre est porte par le contrat, pas devine", () => {
  /**
   * TROISIEME DEFAUT DE MA CONCEPTION, constate le 2026-09-11 sur une enquete
   * reelle qui franchissait enfin le plancher de longueur.
   *
   * Le plan avait declare `role: contradictoire` pour « Harmonisation globale
   * contre precision locale : le dilemme des producteurs de donnees », et
   * `role: echeances` pour « Calendrier de revision et jalons statistiques ».
   * La structure etait COMPLETE. Le rendu jetait le role, puis le gate
   * essayait de le re-deviner a partir des mots du titre — et de bons titres
   * ne contiennent pas les mots-cles d'une regle.
   *
   * Meme faute que le glossaire jete en silence : une information produite
   * correctement, perdue entre deux etapes, puis devinee de travers.
   */
  const chapitresDeclares = [
    { role: "etabli" as const, titre: "Les donnees du constat" },
    { role: "contradictoire" as const, titre: "Harmonisation globale contre precision locale" },
    { role: "echeances" as const, titre: "Calendrier de revision et jalons statistiques" },
  ];
  const corpsAvecTitresLibres = corpsEnquete()
    .replace("## Le versant rassurant", "## Harmonisation globale contre precision locale")
    .replace("## Prochaines echeances a surveiller", "## Calendrier de revision et jalons statistiques");

  it("reconnait le chapitre contradictoire par son ROLE declare, quel que soit son titre", () => {
    const r = regles(
      article({ mode: "enquete", claims: [claim()], body: corpsAvecTitresLibres, chapitres: chapitresDeclares }),
    );
    expect(r).not.toContain("ENQUETE_SANS_CONTRADICTOIRE");
    expect(r).not.toContain("ENQUETE_SANS_ECHEANCES");
  });

  it("REFUSE un role declare dont le chapitre n'existe pas dans le corps", () => {
    // Sans cette verification, declarer « contradictoire » suffirait a franchir
    // la regle, meme sans ecrire le chapitre. Le role doit etre ADOSSE au texte.
    const creux = [
      { role: "contradictoire" as const, titre: "Un chapitre jamais ecrit" },
      { role: "echeances" as const, titre: "Calendrier de revision et jalons statistiques" },
    ];
    const r = regles(
      article({ mode: "enquete", claims: [claim()], body: corpsAvecTitresLibres, chapitres: creux }),
    );
    expect(r).toContain("ENQUETE_SANS_CONTRADICTOIRE");
  });

  it("reconnait un titre ACCENTUE quand aucun role n'est declare", () => {
    // Repli pour les articles sans champ `chapitres`. Les motifs etaient ecrits
    // sans accents : « Les echeances a surveiller » passait, « Les échéances à
    // surveiller » — le francais correct — echouait.
    const accentue = corpsEnquete().replace(
      "## Prochaines echeances a surveiller",
      "## Les échéances à surveiller",
    );
    expect(regles(enquete(accentue))).not.toContain("ENQUETE_SANS_ECHEANCES");
  });
});
