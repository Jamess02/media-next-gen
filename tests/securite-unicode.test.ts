/**
 * SECURITE — caracteres invisibles et inversion de sens de lecture.
 *
 * Ecrits AVANT le code (TDD).
 *
 * L'echappement existant traite le BALISAGE : crochets, chevrons, accents
 * graves. Il ne voit pas les caracteres qui n'ont aucune apparence propre mais
 * qui changent ce que l'oeil lit.
 *
 *  - U+202E (RIGHT-TO-LEFT OVERRIDE) inverse l'ordre d'affichage de ce qui
 *    suit. Le texte stocke dit une chose, le texte affiche en dit une autre —
 *    et c'est l'affiche que le lecteur croit. Sur un media dont la promesse est
 *    « chaque affirmation peut etre relue et contestee », un texte qui ne se
 *    lit pas tel qu'il est ecrit ruine la promesse a la racine.
 *  - U+200B et ses voisins sont de largeur nulle. Glisses dans une URL
 *    AFFICHEE, ils la font ressembler a un domaine legitime alors que la cible
 *    du lien est ailleurs.
 *
 * Le texte concerne vient des sources : titres de flux, resumes d'API. Il
 * traverse le pipeline verbatim jusqu'au markdown et au site.
 */

import { describe, expect, it } from "vitest";

import { escapeSourceText } from "../src/editorial/markdown.js";
import { renderArticle } from "../src/agents/editeur.js";
import { articlePage } from "../src/site/templates.js";
import { article, claim } from "./helpers.js";

const RLO = "‮";
const LRO = "‭";
const ZWSP = "​";
const ZWJ = "‍";
const BOM = "﻿";
const ISOLE = "⁦";

describe("controles de sens de lecture", () => {
  it("neutralise l'inversion droite-a-gauche dans un texte de source", () => {
    const sortie = escapeSourceText(`Solde de ${RLO}00,5- MUSD`);
    expect(sortie).not.toContain(RLO);
  });

  it("neutralise toutes les variantes de forcage bidirectionnel", () => {
    for (const c of [RLO, LRO, ISOLE, "‪", "‫", "‬", "⁩"]) {
      expect(escapeSourceText(`avant${c}apres`)).not.toContain(c);
    }
  });

  it("SIGNALE le retrait au lieu de le faire en silence", () => {
    // Supprimer sans rien dire modifierait une donnee de source sans trace, ce
    // que le §8 refuse. Le lecteur doit voir qu'il manque quelque chose.
    expect(escapeSourceText(`Solde${RLO} inverse`)).toMatch(/U\+202E/);
  });
});

describe("caracteres de largeur nulle", () => {
  it("neutralise les caracteres invisibles", () => {
    for (const c of [ZWSP, ZWJ, BOM, "‌", "⁠"]) {
      expect(escapeSourceText(`fred${c}.org`)).not.toContain(c);
    }
  });

  it("laisse intact un texte francais ordinaire, accents compris", () => {
    // Une neutralisation trop large rendrait le francais illisible : c'est le
    // defaut symetrique, et il ferait desactiver la regle.
    const texte = "L'inflation s'établit à 2,47 % — chiffre révisé le 1er août.";
    expect(escapeSourceText(texte)).toContain("établit");
    expect(escapeSourceText(texte)).toContain("—");
    expect(escapeSourceText(texte)).toContain("2,47 %");
  });
});

describe("l'article publie ne transporte aucun de ces caracteres", () => {
  const hostile = article({
    claims: [claim({ text: `Le solde ${RLO}00,5- MUSD${ZWSP} est confirme.` })],
    title: `Titre${RLO} pige`,
  });

  it("markdown : ni dans le corps, ni dans la fiche de preuve", () => {
    const md = renderArticle(hostile);
    expect(md).not.toContain(RLO);
    expect(md).not.toContain(ZWSP);
  });

  it("HTML du site : ni dans le titre, ni dans les claims", () => {
    const html = articlePage(hostile);
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(ZWSP);
  });
});
