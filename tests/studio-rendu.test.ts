/**
 * Le rendu de la liste des brouillons, EXECUTE pour de vrai.
 *
 * Ecrits AVANT le code (TDD).
 *
 * POURQUOI CE FICHIER EXISTE. Les tests du studio verifiaient jusqu'ici que des
 * CHAINES figurent dans la page — `id="recherche"`, `groupe-thematique`. Tous
 * verts, et pourtant l'editeur n'a pas vu ses categories s'afficher. Une
 * assertion sur la presence d'un mot dans un fichier ne dit rien de ce que le
 * navigateur produit : le code pouvait etre la sans jamais rien dessiner.
 *
 * Ici, le bloc de rendu est EXTRAIT de la page et EXECUTE contre un DOM
 * minimal. On regarde l'arbre obtenu, pas le texte du programme.
 *
 * CE QUE CE DOM SIMULE : createElement, appendChild, textContent (qui vide les
 * enfants, comme le vrai), setAttribute, addEventListener, et getElementById.
 * C'est tout ce que la page utilise. Un faux DOM plus riche donnerait
 * l'illusion de tester un navigateur, ce qu'il ne fait pas.
 */

import { describe, expect, it } from "vitest";

import { STUDIO_PAGE } from "../src/studio/page.js";

/* -------------------------------------------------------------------------
 * Un DOM minimal
 * ---------------------------------------------------------------------- */

interface Noeud {
  tagName: string;
  className: string;
  attributs: Record<string, string>;
  enfants: Noeud[];
  texte: string;
  handlers: Record<string, () => void>;
  textContent: string;
  appendChild(enfant: Noeud): Noeud;
  setAttribute(nom: string, valeur: string): void;
  addEventListener(type: string, fn: () => void): void;
  value?: string;
}

function creerNoeud(tagName: string): Noeud {
  const n: Noeud = {
    tagName,
    className: "",
    attributs: {},
    enfants: [],
    texte: "",
    handlers: {},
    get textContent(): string {
      return this.texte + this.enfants.map((e) => e.textContent).join("");
    },
    set textContent(v: string) {
      // Comme le vrai DOM : affecter textContent REMPLACE tout le contenu.
      this.texte = v;
      this.enfants = [];
    },
    appendChild(enfant: Noeud): Noeud {
      this.enfants.push(enfant);
      return enfant;
    },
    setAttribute(nom: string, valeur: string): void {
      this.attributs[nom] = valeur;
    },
    addEventListener(type: string, fn: () => void): void {
      this.handlers[type] = fn;
    },
  };
  return n;
}

/** Tous les descendants portant une classe donnee. */
function parClasse(racine: Noeud, classe: string): Noeud[] {
  const trouves: Noeud[] = [];
  const visiter = (n: Noeud): void => {
    if (n.className.split(/\s+/).includes(classe)) trouves.push(n);
    for (const e of n.enfants) visiter(e);
  };
  visiter(racine);
  return trouves;
}

const MARQUE_DEBUT = "/* --- rendu des brouillons --- */";
const MARQUE_FIN = "/* --- fin rendu des brouillons --- */";

/** Extrait le bloc de rendu de la page, tel qu'il part au navigateur. */
function blocDeRendu(): string {
  const debut = STUDIO_PAGE.indexOf(MARQUE_DEBUT);
  const fin = STUDIO_PAGE.indexOf(MARQUE_FIN);
  if (debut < 0 || fin < 0) {
    throw new Error(
      "bloc de rendu introuvable : les marqueurs doivent encadrer le code " +
        "reellement servi, sinon ce test verifie autre chose que la page",
    );
  }
  return STUDIO_PAGE.slice(debut, fin);
}

interface Rendu {
  boite: Noeud;
  recents: Noeud;
  compte: Noeud;
  rendre: () => void;
  champ: Noeud;
}

/** Execute le bloc de rendu sur un jeu d'articles, et rend l'arbre produit. */
function rendre(articles: unknown[], recherche = ""): Rendu {
  const boite = creerNoeud("div");
  const recents = creerNoeud("div");
  const compte = creerNoeud("span");
  const champ = creerNoeud("input");
  champ.value = recherche;

  const elements: Record<string, Noeud> = {
    articles: boite,
    "derniers-brouillons": recents,
    "compte-recherche": compte,
    recherche: champ,
  };

  const document = {
    createElement: (tag: string) => creerNoeud(tag),
    getElementById: (id: string) => elements[id] ?? null,
  };
  const $ = (id: string): Noeud | null => elements[id] ?? null;

  // `blocRelecture` et `carteArticle` appartiennent au reste de la page : on
  // fournit une doublure, ce test portant sur le GROUPEMENT, pas sur la carte.
  const blocRelecture = (): Noeud => creerNoeud("div");

  const fabrique = new Function(
    "document",
    "$",
    "blocRelecture",
    "ARTICLES_INIT",
    `${blocDeRendu()}
     ARTICLES = ARTICLES_INIT;
     return { rendreArticles };`,
  ) as (
    d: unknown,
    s: unknown,
    b: unknown,
    a: unknown,
  ) => { rendreArticles: () => void };

  const { rendreArticles } = fabrique(document, $, blocRelecture, articles);
  rendreArticles();

  return { boite, recents, compte, rendre: rendreArticles, champ };
}

const article = (titre: string, thematique: string, publie: string) => ({
  id: titre,
  titre,
  thematique,
  publie,
  revise: null,
  claims: [],
  incertitudes: 0,
  ecartees: 0,
  valide: false,
  relecteur: null,
});

const JEU = [
  article("BC recent", "banques centrales", "2026-09-19T08:00:00Z"),
  article("BC ancien", "banques centrales", "2026-09-10T08:00:00Z"),
  article("Macro recent", "macroeconomie", "2026-09-18T08:00:00Z"),
  article("Macro moyen", "macroeconomie", "2026-09-14T08:00:00Z"),
  article("Macro ancien", "macroeconomie", "2026-09-01T08:00:00Z"),
];

/* -------------------------------------------------------------------------
 * Ce que le rendu produit REELLEMENT
 * ---------------------------------------------------------------------- */

describe("rendu — les categories existent dans l'arbre", () => {
  it("dessine UNE entete par thematique", () => {
    // L'assertion qui manquait : les tests precedents verifiaient que le mot
    // « groupe-thematique » figure dans le fichier, pas qu'une entete soit
    // produite.
    const { boite } = rendre(JEU);
    const entetes = parClasse(boite, "groupe-thematique");
    expect(entetes).toHaveLength(2);
    expect(entetes[0]?.textContent).toMatch(/banques centrales/);
    expect(entetes[1]?.textContent).toMatch(/macroeconomie/);
  });

  it("annonce le NOMBRE d'articles de chaque categorie", () => {
    const { boite } = rendre(JEU);
    const entetes = parClasse(boite, "groupe-thematique");
    expect(entetes[0]?.textContent).toMatch(/2/);
    expect(entetes[1]?.textContent).toMatch(/3/);
  });

  it("rend les entetes CLIQUABLES", () => {
    // Demande de l'editeur : on clique sur une categorie et ses articles
    // apparaissent dedans.
    const { boite } = rendre(JEU);
    for (const e of parClasse(boite, "groupe-thematique")) {
      expect(typeof e.handlers["click"], `${e.textContent} n'est pas cliquable`).toBe(
        "function",
      );
    }
  });

  it("place les articles DANS leur categorie", () => {
    const { boite } = rendre(JEU);
    const groupes = parClasse(boite, "groupe");
    expect(groupes).toHaveLength(2);
    expect(parClasse(groupes[0] as Noeud, "carte")).toHaveLength(2);
    expect(parClasse(groupes[1] as Noeud, "carte")).toHaveLength(3);
  });

  it("trie chaque categorie du PLUS RECENT au plus ancien", () => {
    const { boite } = rendre(JEU);
    const groupes = parClasse(boite, "groupe");
    const titres = parClasse(groupes[1] as Noeud, "t").map((n) => n.textContent);
    expect(titres).toEqual(["Macro recent", "Macro moyen", "Macro ancien"]);
  });
});

describe("rendu — les plus recents restent visibles", () => {
  it("expose les derniers brouillons, toutes categories confondues", () => {
    // « Bien evidemment les articles les plus recents doivent etre visibles
    // sur la page » : replier toutes les categories les cacherait.
    const { recents } = rendre(JEU);
    const lignes = parClasse(recents, "recent");
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes[0]?.textContent).toMatch(/BC recent/);
    expect(lignes[1]?.textContent).toMatch(/Macro recent/);
  });

  it("les rend COMPACTS : ni carte, ni second formulaire de validation", () => {
    // Une carte pleine par recent poussait la premiere categorie a plus de
    // mille pixels sous la ligne de flottaison — l'editeur ne les voyait pas.
    // Et le meme article portait DEUX formulaires de relecture, dont l'un ne
    // se serait pas mis a jour apres l'autre.
    const { recents } = rendre(JEU);
    expect(parClasse(recents, "carte")).toHaveLength(0);
    expect(parClasse(recents, "relire")).toHaveLength(0);
  });

  it("montre la date et la thematique de chaque recent", () => {
    const { recents } = rendre(JEU);
    const premier = parClasse(recents, "recent")[0]?.textContent ?? "";
    expect(premier).toMatch(/2026-09-19/);
    expect(premier).toMatch(/banques centrales/);
  });

  it("OUVRE la categorie quand on clique un recent", () => {
    const { recents, boite } = rendre(JEU);
    const macro = parClasse(boite, "groupe")[1] as Noeud;
    expect(macro.className, "les categories doivent partir repliees").toMatch(/replie/);

    const ligne = parClasse(recents, "recent").find((n) =>
      n.textContent.includes("Macro recent"),
    );
    expect(ligne?.handlers["click"], "un recent n'est pas cliquable").toBeTypeOf(
      "function",
    );
    ligne?.handlers["click"]?.();

    expect(macro.className, "la categorie est restee fermee").not.toMatch(/replie/);
  });

  it("ne repete pas indefiniment : les recents sont bornes", () => {
    const beaucoup = Array.from({ length: 20 }, (_, i) =>
      article(`A${i}`, "macroeconomie", `2026-09-${String(28 - i).padStart(2, "0")}T08:00:00Z`),
    );
    const { recents } = rendre(beaucoup);
    expect(parClasse(recents, "recent").length).toBeLessThanOrEqual(6);
  });
});

describe("disposition — les categories d'abord", () => {
  it("place les categories AVANT les recents dans la page", () => {
    // L'ordre inverse les rendait invisibles : six cartes pleines les
    // repoussaient hors de l'ecran.
    const categories = STUDIO_PAGE.indexOf('id="articles"');
    const recents = STUDIO_PAGE.indexOf('id="derniers-brouillons"');
    expect(categories).toBeGreaterThan(-1);
    expect(recents).toBeGreaterThan(-1);
    expect(categories).toBeLessThan(recents);
  });
});

describe("rendu — la recherche", () => {
  it("ne garde que les articles correspondants, et le dit", () => {
    const { boite, compte } = rendre(JEU, "macro");
    expect(parClasse(boite, "carte")).toHaveLength(3);
    expect(compte.textContent).toMatch(/3/);
  });

  it("cherche aussi dans la THEMATIQUE", () => {
    const { boite } = rendre(JEU, "banques");
    expect(parClasse(boite, "carte")).toHaveLength(2);
  });

  it("annonce clairement une recherche sans resultat", () => {
    const { boite } = rendre(JEU, "zembla");
    expect(parClasse(boite, "carte")).toHaveLength(0);
    expect(boite.textContent).toMatch(/aucun/i);
  });
});
