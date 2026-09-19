/**
 * Le rendu de la liste des brouillons, EXECUTE pour de vrai.
 *
 * Ecrits AVANT le code (TDD).
 *
 * POURQUOI CE FICHIER EXISTE. Les tests du studio verifiaient qu'une CHAINE
 * figure dans la page — « groupe-thematique », « id=recherche ». Tous verts, et
 * pourtant l'editeur n'a pas vu ses categories. Une assertion sur la presence
 * d'un mot ne dit rien de ce que le navigateur produit.
 *
 * Ici, le bloc de rendu est EXTRAIT de la page et EXECUTE contre un DOM
 * minimal. On regarde l'arbre obtenu, pas le texte du programme.
 *
 * DEUX VUES, depuis la demande du 2026-09-19 : l'accueil liste les CATEGORIES,
 * et chaque categorie a sa propre page — une vraie adresse, donc un bouton
 * retour qui marche et un lien que l'on peut ouvrir dans un onglet.
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
  href?: string;
}

function creerNoeud(tagName: string): Noeud {
  return {
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
}

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
  titre: Noeud;
}

/** Execute le rendu. `thematique` simule l'adresse d'une page de categorie. */
function rendre(
  articles: unknown[],
  options: { recherche?: string; thematique?: string } = {},
): Rendu {
  const boite = creerNoeud("div");
  const recents = creerNoeud("div");
  const compte = creerNoeud("span");
  const titre = creerNoeud("div");
  const champ = creerNoeud("input");
  champ.value = options.recherche ?? "";

  const elements: Record<string, Noeud> = {
    articles: boite,
    "derniers-brouillons": recents,
    "compte-recherche": compte,
    "titre-vue": titre,
    recherche: champ,
  };

  const document = {
    createElement: (tag: string) => creerNoeud(tag),
    getElementById: (id: string) => elements[id] ?? null,
  };
  const $ = (id: string): Noeud | null => elements[id] ?? null;
  const location = {
    search:
      options.thematique === undefined
        ? ""
        : `?thematique=${encodeURIComponent(options.thematique)}`,
  };

  // Doublure : ce test porte sur le GROUPEMENT et la navigation, pas sur la
  // carte de relecture, qui a ses propres controles.
  const blocRelecture = (): Noeud => creerNoeud("div");

  const fabrique = new Function(
    "document",
    "$",
    "location",
    "blocRelecture",
    "ARTICLES_INIT",
    `${blocDeRendu()}
     ARTICLES = ARTICLES_INIT;
     return { rendreArticles };`,
  ) as (
    d: unknown,
    s: unknown,
    l: unknown,
    b: unknown,
    a: unknown,
  ) => { rendreArticles: () => void };

  fabrique(document, $, location, blocRelecture, articles).rendreArticles();
  return { boite, recents, compte, titre };
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
 * 1. L'accueil : les categories
 * ---------------------------------------------------------------------- */

describe("accueil — la liste des categories", () => {
  it("dessine UNE entree par thematique, avec son compte", () => {
    const { boite } = rendre(JEU);
    const entrees = parClasse(boite, "groupe-thematique");
    expect(entrees).toHaveLength(2);
    expect(entrees[0]?.textContent).toMatch(/banques centrales/);
    expect(entrees[0]?.textContent).toMatch(/2/);
    expect(entrees[1]?.textContent).toMatch(/3/);
  });

  it("chaque categorie est un LIEN vers sa propre page", () => {
    // Un lien, et non un bouton : le bouton retour du navigateur doit marcher,
    // et la page d'une categorie doit pouvoir s'ouvrir dans un onglet.
    const { boite } = rendre(JEU);
    for (const e of parClasse(boite, "groupe-thematique")) {
      expect(e.tagName, "une categorie doit etre un lien").toBe("a");
      expect(e.href ?? "", e.textContent).toMatch(/[?&]thematique=/);
    }
  });

  it("encode la thematique dans l'adresse", () => {
    const { boite } = rendre(JEU);
    const lien = parClasse(boite, "groupe-thematique")[0];
    expect(lien?.href).toContain(encodeURIComponent("banques centrales"));
  });

  it("n'affiche AUCUN article : ils vivent sur la page de leur categorie", () => {
    const { boite } = rendre(JEU);
    expect(parClasse(boite, "carte")).toHaveLength(0);
  });

  it("montre les plus recents, compacts et sans formulaire", () => {
    const { recents } = rendre(JEU);
    const lignes = parClasse(recents, "recent");
    expect(lignes[0]?.textContent).toMatch(/BC recent/);
    expect(lignes[1]?.textContent).toMatch(/Macro recent/);
    expect(parClasse(recents, "carte")).toHaveLength(0);
    expect(parClasse(recents, "relire")).toHaveLength(0);
  });

  it("borne les recents", () => {
    const beaucoup = Array.from({ length: 20 }, (_, i) =>
      article(`A${i}`, "macroeconomie", `2026-09-${String(28 - i).padStart(2, "0")}T08:00:00Z`),
    );
    expect(parClasse(rendre(beaucoup).recents, "recent").length).toBeLessThanOrEqual(6);
  });
});

/* -------------------------------------------------------------------------
 * 2. La page d'une categorie
 * ---------------------------------------------------------------------- */

describe("page d'une categorie", () => {
  it("n'affiche QUE les articles de cette categorie", () => {
    const { boite } = rendre(JEU, { thematique: "macroeconomie" });
    const titres = parClasse(boite, "t").map((n) => n.textContent);
    expect(titres).toHaveLength(3);
    expect(titres.every((t) => t.startsWith("Macro"))).toBe(true);
  });

  it("les trie du PLUS RECENT au plus ancien", () => {
    const { boite } = rendre(JEU, { thematique: "macroeconomie" });
    expect(parClasse(boite, "t").map((n) => n.textContent)).toEqual([
      "Macro recent",
      "Macro moyen",
      "Macro ancien",
    ]);
  });

  it("annonce la categorie ouverte", () => {
    const { titre } = rendre(JEU, { thematique: "macroeconomie" });
    expect(titre.textContent).toMatch(/macroeconomie/);
  });

  it("porte un lien de RETOUR vers toutes les thematiques", () => {
    const { titre } = rendre(JEU, { thematique: "macroeconomie" });
    const retours = parClasse(titre, "retour");
    expect(retours, "aucun retour : la page serait sans issue").toHaveLength(1);
    expect(retours[0]?.tagName).toBe("a");
  });

  it("ne montre PAS le bandeau des recents : on est deja dans une categorie", () => {
    const { recents } = rendre(JEU, { thematique: "macroeconomie" });
    expect(parClasse(recents, "recent")).toHaveLength(0);
  });

  it("le DIT quand la categorie est vide ou inconnue", () => {
    // Une page blanche laisserait croire a une panne.
    const { boite } = rendre(JEU, { thematique: "inexistante" });
    expect(parClasse(boite, "carte")).toHaveLength(0);
    expect(boite.textContent).toMatch(/aucun/i);
  });
});

/* -------------------------------------------------------------------------
 * 3. La recherche
 * ---------------------------------------------------------------------- */

describe("recherche", () => {
  it("sur l'accueil, ne garde que les categories qui repondent", () => {
    const { boite, compte } = rendre(JEU, { recherche: "macro" });
    expect(parClasse(boite, "groupe-thematique")).toHaveLength(1);
    expect(compte.textContent).toMatch(/3/);
  });

  it("cherche aussi dans la THEMATIQUE", () => {
    const { boite } = rendre(JEU, { recherche: "banques" });
    const entrees = parClasse(boite, "groupe-thematique");
    expect(entrees).toHaveLength(1);
    expect(entrees[0]?.textContent).toMatch(/banques centrales/);
  });

  it("sur une page de categorie, filtre DANS la categorie", () => {
    const { boite } = rendre(JEU, { thematique: "macroeconomie", recherche: "ancien" });
    expect(parClasse(boite, "t").map((n) => n.textContent)).toEqual(["Macro ancien"]);
  });

  it("annonce clairement une recherche sans resultat", () => {
    const { boite } = rendre(JEU, { recherche: "zembla" });
    expect(boite.textContent).toMatch(/aucun/i);
  });
});
