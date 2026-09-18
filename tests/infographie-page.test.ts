/**
 * INFOGRAPHIE — ce que la PAGE en montre au lecteur.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le calcul, le rendu et le contrat sont deja tenus par du code teste. Il reste
 * le dernier maillon, et c'est celui que le lecteur voit : la page.
 *
 * DEUX EXIGENCES DU BRIEF SE JOUENT ICI, et aucune ne va de soi.
 *
 *  - « Une estimation interne est etiquetee comme telle dans le graphique ET
 *    dans le texte. » Le graphique le fait deja ; la page doit le redire en
 *    toutes lettres, parce qu'une legende dessinee ne se lit pas comme une
 *    phrase, et parce qu'un lecteur qui cite l'article de memoire ne verra que
 *    le texte.
 *  - « Affiche toujours un terme residu / non explique. » Il existe dans le
 *    graphique ; la page doit le NOMMER, faute de quoi le lecteur pressé
 *    retiendra une decomposition qui explique tout.
 *
 * ET UNE EXIGENCE QUI N'EST PAS DANS LE BRIEF mais qui conditionne le reste :
 * une infographie invalide ne doit pas casser la page. Le gate la bloque deja
 * avant publication ; si malgre tout elle arrivait ici — un brouillon relu a la
 * main, un article ancien — le site doit l'omettre, pas rendre une page en
 * erreur. Une exception au rendu ferait disparaitre l'article entier.
 */

import { describe, expect, it } from "vitest";

import type { Infographie } from "../src/protocol/schema.js";
import { articlePage } from "../src/site/templates.js";
import { article, claim } from "./helpers.js";

const INFOGRAPHIE: Infographie = {
  indicateur: "inflation_zone_euro_hicp",
  libelle: "Inflation annuelle, zone euro (IPCH)",
  unite: "points de %",
  anticipe: {
    value: 2.1,
    source: "Projections BCE de juin 2026",
    date: "2026-06-12",
  },
  realise: {
    value: 2.47,
    source: "Eurostat, prc_hicp_manr",
    date: "2026-07-13",
  },
  composantes: [
    {
      name: "energie",
      value: 0.25,
      method: "publiee",
      source: "Eurostat, contributions",
    },
    {
      name: "services",
      value: 0.08,
      method: "estimee",
      source: "calcul interne : contributions ponderees par les poids IPCH 2026",
    },
  ],
};

const page = (infographie: Infographie = INFOGRAPHIE): string =>
  articlePage(article({ infographie }));

describe("page d'article — le graphique d'ecart", () => {
  it("rend le graphique quand l'article en porte un", () => {
    const html = page();
    expect(html).toContain("<svg");
    expect(html).toMatch(/role="img"/);
    expect(html).toContain("Inflation annuelle, zone euro");
  });

  it("n'ajoute RIEN sur un article ordinaire", () => {
    // La plupart des articles n'ont pas d'anticipation datee a confronter :
    // c'est le cas normal, et il ne doit laisser aucun bloc vide.
    //
    // On vise le BALISAGE, jamais le nom de classe : la feuille de style est
    // inlinee dans chaque page, donc « figure-ecart » y figure de toute facon.
    // Chercher le nom nu testerait la CSS, pas le rendu.
    const html = articlePage(article());
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/<figure class="figure-ecart"/);
  });

  it("place le graphique APRES le corps et AVANT le tableau des chiffres", () => {
    // Le graphique illustre le propos qu'on vient de lire ; le tableau
    // recapitule. Inverser les deux ferait commenter un tableau pas encore lu.
    //
    // L'article doit porter un chiffre STRUCTURE, sans quoi il n'y a pas de
    // tableau et l'ordre ne veut rien dire. Et l'on compare des balises : les
    // noms de classe apparaissent aussi dans la feuille de style inlinee, en
    // tete de document, donc bien avant le corps.
    // DEUX chiffres, parce qu'un classement d'un seul element n'en est pas un :
    // le tableau est omis en dessous de deux figures.
    const html = articlePage(
      article({
        claims: [
          claim({
            id: "claim-1",
            figure: {
              label: "Inflation annuelle",
              value: 2.47,
              unit: "points de %",
              as_of: "2026-07",
            },
          }),
          claim({
            id: "claim-2",
            figure: {
              label: "Contribution de l'energie",
              value: 0.25,
              unit: "points de %",
              as_of: "2026-07",
            },
          }),
        ],
        infographie: INFOGRAPHIE,
      }),
    );

    const corps = html.indexOf('<div class="corps">');
    const graphique = html.indexOf('<figure class="figure-ecart">');
    const tableau = html.indexOf('<div class="tableau-enveloppe">');

    expect(graphique, "aucun graphique rendu").toBeGreaterThan(-1);
    expect(tableau, "aucun tableau des chiffres : l'ordre ne veut rien dire").toBeGreaterThan(-1);
    expect(corps).toBeLessThan(graphique);
    expect(graphique).toBeLessThan(tableau);
  });

  it("enveloppe le graphique : un SVG libre deborde sur telephone", () => {
    expect(page()).toMatch(/class="figure-ecart"/);
  });
});

describe("page d'article — ce que la LEGENDE dit en toutes lettres", () => {
  it("ETIQUETTE l'estimation interne dans le texte, pas seulement dans le graphique", () => {
    const html = page();
    const legende = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(html);
    expect(legende, "aucune legende sous le graphique").not.toBeNull();
    expect(legende![1]).toMatch(/services/);
    // La mention doit etre une PHRASE, distincte de l'etiquette du graphique.
    // Chercher « estim » ne suffisait pas : le texte alternatif contient deja
    // « services +0.08 (estimee) », si bien que le test passait meme apres
    // retrait de la mention explicite — constate par mutation. Le brief exige
    // l'etiquetage dans le graphique ET dans le texte ; c'est le second que
    // cette assertion couvre.
    expect(legende![1]).toMatch(/estimation interne/i);
  });

  it("NOMME le residu : une decomposition n'explique jamais tout", () => {
    const legende = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(page());
    expect(legende![1]).toMatch(/residu|non explique/i);
  });

  it("porte l'unite, les deux dates et les deux sources", () => {
    const html = page();
    expect(html).toContain("points de %");
    expect(html).toContain("2026-06-12");
    expect(html).toContain("2026-07-13");
    expect(html).toContain("Projections BCE de juin 2026");
    expect(html).toContain("Eurostat, prc_hicp_manr");
  });

  it("ne presente AUCUNE estimation quand toutes les composantes sont publiees", () => {
    // Annoncer une estimation interne la ou il n'y en a pas jetterait un doute
    // sur des chiffres officiels.
    const html = page({
      ...INFOGRAPHIE,
      composantes: [
        { name: "energie", value: 0.37, method: "publiee", source: "Eurostat" },
      ],
    });
    const legende = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(html);
    expect(legende![1]).not.toMatch(/estimation interne/i);
  });
});

describe("page d'article — robustesse du rendu", () => {
  it("OMET le graphique plutot que d'echouer quand l'infographie est invalide", () => {
    // Le gate bloque deja ce cas avant publication. S'il arrivait malgre tout
    // jusqu'ici, une exception ferait disparaitre l'article ENTIER — une panne
    // de rendu bien pire que l'absence d'un graphique.
    const html = page({
      ...INFOGRAPHIE,
      anticipe: { ...INFOGRAPHIE.anticipe, source: "   " },
    });
    expect(html).toContain("Titre de test");
    expect(html).not.toContain("<svg");
  });

  it("echappe un libelle hostile venu du contrat", () => {
    const html = page({
      ...INFOGRAPHIE,
      libelle: "Inflation <script>alert(1)</script>",
    });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
  });
});
