/**
 * Mode sombre — trois etats : systeme, clair, sombre.
 *
 * Ecrits AVANT le code (TDD).
 *
 * CE QUI EXISTAIT DEJA : un mode sombre automatique, via
 * `@media (prefers-color-scheme: dark)`. Il suit le reglage du systeme et
 * fonctionne. Ce qui manquait, c'est le CHOIX du lecteur — beaucoup de gens
 * lisent en clair sur une machine en sombre, ou l'inverse.
 *
 * LE PIEGE PRINCIPAL. Ajouter un bouton par-dessus une regle `@media` non
 * gardee ne marche pas : sur une machine en sombre, choisir « clair » n'aurait
 * aucun effet, la media query continuant de gagner. La bascule impose donc de
 * restructurer les tokens en trois selecteurs, et c'est le coeur de ce que ces
 * tests verrouillent.
 *
 * LE SECOND PIEGE. Un theme applique par un script qui s'execute apres le
 * rendu produit un flash blanc a chaque navigation. La decision doit etre
 * prise dans le `<head>`, avant le premier pixel.
 */

import { describe, expect, it } from "vitest";

import { STYLES } from "../src/site/styles.js";
import { indexPage } from "../src/site/templates.js";

const page = indexPage([]);

/** Tokens de couleur : ceux dont l'absence dans un theme casse le rendu. */
const TOKENS = [
  "--encre",
  "--papier",
  "--gris",
  "--gris-clair",
  "--trait",
  "--fond-doux",
  "--accent",
  "--fort",
  "--moyen",
  "--faible",
] as const;

/** Contenu du premier bloc dont le selecteur correspond. */
function bloc(selecteur: string): string {
  const i = STYLES.indexOf(selecteur);
  if (i < 0) return "";
  const debut = STYLES.indexOf("{", i);
  const fin = STYLES.indexOf("}", debut);
  return STYLES.slice(debut, fin);
}

describe("les trois etats sont definis", () => {
  it("le clair est la definition de base, sur :root nu", () => {
    // Une couleur definie UNIQUEMENT dans une media query disparait des que la
    // media query ne s'applique pas : le theme se retrouve a moitie peint.
    const base = bloc(":root {");
    for (const token of TOKENS) expect(base).toContain(token);
  });

  it("le sombre explicite redefinit TOUS les tokens", () => {
    const sombre = bloc(':root[data-theme="dark"]');
    for (const token of TOKENS) expect(sombre).toContain(token);
  });

  it("le sombre systeme redefinit TOUS les tokens", () => {
    const systeme = bloc(":root:not([data-theme");
    for (const token of TOKENS) expect(systeme).toContain(token);
  });
});

describe("un choix manuel l'emporte sur le reglage systeme", () => {
  it("la media query est GARDEE contre un choix clair explicite", () => {
    // Sans cette garde, choisir « clair » sur une machine en sombre n'aurait
    // aucun effet. C'est le defaut le plus courant de ce genre de bascule.
    expect(STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]{0,80}:root:not\(\[data-theme="light"\]\)/,
    );
  });

  it("aucun token n'est defini UNIQUEMENT sous media query", () => {
    const avantMedia = STYLES.slice(0, STYLES.indexOf("@media"));
    for (const token of TOKENS) expect(avantMedia).toContain(token);
  });

  it("declare color-scheme pour les elements natifs", () => {
    // Barres de defilement et controles de formulaire restent clairs sans
    // cette declaration, meme sur une page entierement sombre.
    expect(STYLES).toMatch(/color-scheme:/);
  });
});

describe("la bascule est utilisable et sans flash", () => {
  it("la page porte un bouton de theme", () => {
    expect(page).toMatch(/id="theme-bascule"/);
  });

  it("le bouton annonce son etat aux technologies d'assistance", () => {
    expect(page).toMatch(/aria-label="[^"]*th[eè]me/i);
  });

  it("le theme est applique dans le HEAD, avant le premier rendu", () => {
    // Un script en fin de body repeindrait la page apres coup : flash blanc a
    // chaque navigation, sur un site fait de pages statiques.
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toContain("data-theme");
    expect(head).toMatch(/<script>/);
  });

  it("survit a un localStorage indisponible", () => {
    // Navigation privee, cookies bloques : l'acces LEVE au lieu de rendre
    // null. Sans try/catch, la page ne s'affiche pas du tout.
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toMatch(/try\s*\{/);
    expect(head).toMatch(/catch/);
  });

  it("le site reste lisible SANS JavaScript", () => {
    // Le script ne fait que surcharger un choix. Sans lui, la page tombe sur
    // le reglage systeme, qui est deja correct.
    expect(page).not.toMatch(/<noscript>/);
    expect(STYLES).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});

describe("lisibilite des composants ajoutes recemment", () => {
  it("les listes d'incertitude et de divulgation ont une couleur sombre", () => {
    // Le gris fonce des listes reste lisible sur papier blanc, pas sur fond
    // sombre : sans reprise, ces blocs disparaissaient.
    const sombre = STYLES.slice(STYLES.indexOf("@media"));
    expect(sombre).toMatch(/\.avertissement li/);
    expect(sombre).toMatch(/\.divulgation li/);
  });
});
