/**
 * Convention de tracabilite, et surfaces machine du site.
 *
 * METHODE REPRISE, PAS SOURCE CITEE. l0g.fr documente publiquement une
 * convention de citation en trois regles et un ensemble de surfaces lisibles
 * par machine. On en reprend la METHODE — c'est le seul usage admis de ce site
 * dans ce projet, qui ne le cite jamais comme source.
 *
 * LES TROIS REGLES, telles que formulees par la convention reprise :
 *
 *   CITER          nom de la serie, site, DATE DE CONSULTATION, lien permanent
 *   DATER          « Une valeur courante n'est pas une observation historique
 *                  retroactive » — la date du point publie doit survivre
 *   CONTEXTUALISER « Deux niveaux identiques ne sont pas comparables » — chaque
 *                  chiffre porte sa propre methode
 *
 * POURQUOI C'EST UNE REGLE ET NON UNE MENTION DE PIED DE PAGE
 *
 * Un article de ce pipeline sera repris. S'il ne dit pas COMMENT le citer, il
 * sera cite de travers : valeur sans date, chiffre sorti de son perimetre,
 * lien vers l'accueil plutot que vers l'article. La convention n'existe que si
 * elle voyage AVEC le texte.
 */

import { describe, expect, it } from "vitest";

import { blocDeCitation, llmsTxt, statusSurface } from "../src/site/tracabilite.js";
import { article, claim } from "./helpers.js";

describe("bloc « comment citer » — une regle par article", () => {
  const a = article({ claims: [claim()] });
  const bloc = blocDeCitation(a, "https://exemple.test");

  it("porte le lien PERMANENT de l'article, pas celui de l'accueil", () => {
    expect(bloc).toContain(`https://exemple.test/articles/${a.id}.html`);
  });

  it("porte la date de PUBLICATION, qui ne doit pas se perdre a la reprise", () => {
    // « Une valeur courante n'est pas une observation historique retroactive. »
    expect(bloc).toContain(a.published_at.slice(0, 10));
  });

  it("reclame la date de CONSULTATION, que seul le lecteur connait", () => {
    // Le site ne peut pas la fournir : elle depend du moment de la reprise.
    // Il peut en revanche dire qu'elle est attendue.
    expect(bloc).toMatch(/consultation|consulte/i);
  });

  it("rappelle que chaque chiffre porte sa PROPRE methode", () => {
    // « Deux niveaux identiques ne sont pas comparables. » Sans ce rappel, deux
    // chiffres alignes dans un tableau passent pour equivalents.
    expect(bloc).toMatch(/methode|perimetre|comparable/i);
  });

  it("mentionne la licence et l'attribution", () => {
    expect(bloc).toMatch(/attribution/i);
  });

  it("echappe le HTML : un titre est une donnee, pas du balisage", () => {
    const piege = article({ title: '<script>alert(1)</script>', claims: [claim()] });
    const b = blocDeCitation(piege, "https://exemple.test");
    expect(b).not.toContain("<script>");
  });
});

describe("llms.txt — point d'entree compact pour les machines", () => {
  const txt = llmsTxt([article({ claims: [claim()] })], "https://exemple.test");

  it("annonce les surfaces machine plutot que de les faire deviner", () => {
    for (const surface of ["/api/articles.json", "/agents.json", "/integrity.json", "/feed.xml"]) {
      expect(txt, surface).toContain(surface);
    }
  });

  it("dit ce que le site N'EST PAS", () => {
    // EP-007 : ni conseil d'investissement, ni recommandation. Une surface
    // destinee aux machines doit porter cette limite autant que les pages.
    expect(txt).toMatch(/ni un conseil|pas un conseil|EP-007/i);
  });

  it("declare la regle de citation, pas seulement les fichiers", () => {
    expect(txt).toMatch(/citer|attribution/i);
  });

  it("reste compact : c'est un point d'entree, pas un miroir du site", () => {
    expect(txt.length).toBeLessThan(4000);
  });
});

describe("status.json — etat de fraicheur, verifiable", () => {
  const s = statusSurface(
    [article({ published_at: "2026-09-01T10:00:00Z", claims: [claim()] })],
    new Date("2026-09-10T12:00:00Z"),
  );

  it("date la generation", () => {
    expect(String(s["genere_le"])).toMatch(/^2026-09-10T/);
  });

  it("compte les articles publies", () => {
    expect(s["articles_publies"]).toBe(1);
  });

  it("expose l'AGE du contenu le plus recent, en jours", () => {
    // Un site qui ne dit pas sa fraicheur laisse croire qu'il est a jour.
    expect(s["age_du_plus_recent_en_jours"]).toBe(9);
  });

  it("rend un age nul et un compte a zero quand rien n'est publie", () => {
    const vide = statusSurface([], new Date("2026-09-10T12:00:00Z"));
    expect(vide["articles_publies"]).toBe(0);
    expect(vide["age_du_plus_recent_en_jours"]).toBeNull();
  });
});

describe("integration — le bloc voyage AVEC l'article", () => {
  it("apparait sur la page d'article rendue", async () => {
    // Une convention rangee dans une page « a propos » ne protege rien : celui
    // qui reprend l'article ne l'ouvre pas. Elle doit etre sous ses yeux.
    const { articlePage } = await import("../src/site/templates.js");
    const html = articlePage(article({ claims: [claim()] }));
    expect(html).toMatch(/Comment citer cet article/i);
    expect(html).toMatch(/consultation/i);
  });
});
