/**
 * Vagues automatiques — six articles toutes les quatre heures.
 *
 * Ecrits AVANT le code (TDD).
 *
 * CE QUE LA COMPOSITION DOIT GARANTIR, ET QUI NE PEUT PAS DEPENDRE DU HASARD
 *
 * « Dans chaque vague il doit y avoir les deux types » : constat ET prospectif.
 * Tirer les modes au sort produirait, tot ou tard, une vague entierement d'un
 * cote — rare, donc constatee tard, et sur un lot deja publie. La composition
 * est donc FIXE et verifiee.
 *
 * Les sujets tournent : deux vagues consecutives sur les memes themes
 * produiraient six articles quasi identiques, ce qui remplirait `output/` sans
 * rien apprendre a personne.
 *
 * CE QU'UNE VAGUE NE FAIT PAS, et c'est le point le plus important : elle ne
 * PUBLIE rien. Elle produit des brouillons dans `output/`. La regle du projet
 * est qu'aucun article ne parait sans relecture humaine nommee ; une
 * automatisation qui publierait la contournerait, et l'attestation ne
 * vaudrait plus rien.
 *
 * ENFIN, un echec n'arrete pas la vague. Le gate refuse regulierement des
 * articles — c'est son travail. Une vague qui s'interromprait au premier refus
 * ne produirait presque jamais six articles.
 */

import { describe, expect, it } from "vitest";

import { ARTICLE_MODES } from "../src/protocol/constants.js";
import {
  INTERVALLE_VAGUE_MS,
  TAILLE_VAGUE,
  THEMES,
  composerVague,
  executerVague,
} from "../src/planification/vagues.js";
import type { PipelineResult } from "../src/pipeline.js";

describe("composition d'une vague", () => {
  it("produit exactement six sujets", () => {
    expect(composerVague(0)).toHaveLength(TAILLE_VAGUE);
    expect(TAILLE_VAGUE).toBe(6);
  });

  it("contient TOUJOURS les deux types, dans chaque vague", () => {
    // La propriete demandee. Verifiee sur cinquante vagues consecutives : une
    // composition tiree au sort passerait ce test la plupart du temps, et
    // echouerait un jour en production.
    for (let i = 0; i < 50; i += 1) {
      const modes = new Set(composerVague(i).map((s) => s.mode));
      for (const attendu of ["constat", "prospectif"] as const) {
        expect(modes).toContain(attendu);
      }
    }
  });

  it("n'y met JAMAIS d'enquete : ce format a sa propre cadence", () => {
    // Le test precedent iterait sur ARTICLE_MODES comme raccourci pour « les
    // deux types ». L'ajout du mode `enquete` l'a fait echouer — a juste titre,
    // mais pour une raison trompeuse.
    //
    // L'enquete longue est volontairement RARE : une par semaine, contre
    // quarante-deux brouillons produits par les vagues sur la meme duree. La
    // faire entrer dans une vague annulerait cette cadence, et le format long
    // ne se distinguerait plus que par son nom.
    for (let i = 0; i < 50; i += 1) {
      expect(composerVague(i).map((s) => s.mode)).not.toContain("enquete");
    }
  });

  it("ne repete aucun sujet a l'interieur d'une vague", () => {
    for (let i = 0; i < 20; i += 1) {
      const sujets = composerVague(i).map((s) => s.sujet);
      expect(new Set(sujets).size).toBe(sujets.length);
    }
  });

  it("fait TOURNER les themes d'une vague a l'autre", () => {
    // Deux vagues identiques rempliraient `output/` de doublons.
    const a = composerVague(0).map((s) => s.sujet);
    const b = composerVague(1).map((s) => s.sujet);
    expect(a).not.toEqual(b);
  });

  it("est deterministe : meme index, meme vague", () => {
    // Une vague reproductible se rejoue et se compare. Un tirage aleatoire
    // rendrait tout diagnostic impossible apres coup.
    expect(composerVague(7)).toEqual(composerVague(7));
  });

  it("finit par reutiliser les themes, sans jamais manquer de sujets", () => {
    // Le catalogue est fini : la rotation doit boucler proprement plutot que
    // de rendre des sujets vides au bout de quelques jours.
    const loin = composerVague(999);
    expect(loin).toHaveLength(TAILLE_VAGUE);
    for (const s of loin) expect(s.sujet.length).toBeGreaterThan(10);
  });

  it("chaque sujet nomme son domaine, pour que la variete soit verifiable", () => {
    const domaines = new Set(composerVague(0).map((s) => s.domaine));
    expect(domaines.size).toBeGreaterThan(1);
  });

  it("le catalogue de themes couvre les deux modes", () => {
    expect(THEMES.some((t) => t.mode === "constat")).toBe(true);
    expect(THEMES.some((t) => t.mode === "prospectif")).toBe(true);
  });
});

describe("cadence", () => {
  it("l'intervalle est de quatre heures", () => {
    expect(INTERVALLE_VAGUE_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("execution d'une vague", () => {
  const publie = (id: string): PipelineResult =>
    ({
      status: "published",
      article: { id } as never,
      jsonPath: `${id}.json`,
      markdownPath: `${id}.md`,
      warnings: [],
      adjustments: [],
    }) as PipelineResult;

  const arrete = (motif: string): PipelineResult => ({
    status: "halted",
    stage: "fact-checking",
    reason: motif,
    details: [],
  });

  it("execute les six sujets et rend un compte rendu", async () => {
    const vus: string[] = [];
    const rapport = await executerVague({
      index: 0,
      executer: async (sujet) => {
        vus.push(`${sujet.mode}:${sujet.sujet}`);
        return publie(`a-${vus.length}`);
      },
    });

    expect(vus).toHaveLength(6);
    expect(rapport.publies).toBe(6);
    expect(rapport.arretes).toBe(0);
  });

  it("POURSUIT la vague quand un article est refuse par le gate", async () => {
    // Le gate refuse regulierement : c'est son travail. Une vague qui
    // s'arreterait au premier refus ne produirait presque jamais six articles.
    let n = 0;
    const rapport = await executerVague({
      index: 0,
      executer: async () => {
        n += 1;
        return n % 2 === 0 ? arrete("niveau de preuve insuffisant") : publie(`a-${n}`);
      },
    });

    expect(n).toBe(6);
    expect(rapport.publies).toBe(3);
    expect(rapport.arretes).toBe(3);
  });

  it("POURSUIT aussi quand un sujet leve une exception", async () => {
    // Un fournisseur qui tombe au milieu d'une vague ne doit pas emporter les
    // cinq sujets suivants.
    let n = 0;
    const rapport = await executerVague({
      index: 0,
      executer: async () => {
        n += 1;
        if (n === 2) throw new Error("fournisseur indisponible");
        return publie(`a-${n}`);
      },
    });

    expect(n).toBe(6);
    expect(rapport.publies).toBe(5);
    expect(rapport.erreurs).toHaveLength(1);
    expect(rapport.erreurs[0]).toContain("fournisseur indisponible");
  });

  it("rend le detail par sujet, motif d'arret compris", async () => {
    // Un compte rendu qui dirait seulement « 3 sur 6 » n'apprendrait rien :
    // c'est le MOTIF qui indique s'il faut corriger le pipeline ou le sujet.
    const rapport = await executerVague({
      index: 0,
      executer: async () => arrete("aucune claim n'atteint le niveau 2"),
    });
    expect(rapport.lignes).toHaveLength(6);
    expect(rapport.lignes[0]?.motif).toMatch(/niveau 2/);
    expect(rapport.lignes[0]?.mode).toBeDefined();
  });

  it("signale la progression au fil de la vague", async () => {
    // Une vague dure plusieurs minutes : sans progression, on ne distingue pas
    // un traitement en cours d'un processus bloque.
    const etapes: string[] = [];
    await executerVague({
      index: 0,
      executer: async () => publie("a"),
      onProgres: (fait, total, sujet) => etapes.push(`${fait}/${total} ${sujet.mode}`),
    });
    expect(etapes).toHaveLength(6);
    expect(etapes[0]).toMatch(/^1\/6 /);
    expect(etapes[5]).toMatch(/^6\/6 /);
  });
});
