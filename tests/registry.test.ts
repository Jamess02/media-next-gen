/**
 * §4 / EP-001 — derivation des tiers depuis le domaine.
 */

import { describe, expect, it } from "vitest";

import {
  classifySource,
  secondariesShadowedByPrimary,
} from "../src/sources/registry.js";

describe("classification en tiers", () => {
  it("classe les emetteurs officiels en tier 1", () => {
    expect(classifySource("https://fred.stlouisfed.org/series/X").tier).toBe(1);
    expect(classifySource("https://comtrade.un.org/data/X").tier).toBe(1);
    expect(classifySource("https://reliefweb.int/report/x").tier).toBe(1);
  });

  it("classe les agregats publics sources en tier 2", () => {
    expect(classifySource("https://www.gdeltproject.org/data.html").tier).toBe(2);
    expect(classifySource("https://l0g.fr/protocole-editorial/").tier).toBe(2);
  });

  it("distingue GDELT (tier 2) de GDELT Cloud (tier 3)", () => {
    expect(classifySource("https://www.gdeltproject.org/cloud/x").tier).toBe(3);
    expect(classifySource("https://www.gdeltproject.org/api/x").tier).toBe(2);
  });

  it("classe la presse en tier 3", () => {
    expect(classifySource("https://gnews.io/articles/x").tier).toBe(3);
    expect(classifySource("https://acleddata.com/data/x").tier).toBe(3);
  });

  it("couvre les sous-domaines", () => {
    expect(classifySource("https://api.worldbank.org/v2/x").tier).toBe(1);
  });

  it("classe un domaine inconnu en tier 3, jamais mieux", () => {
    const result = classifySource("https://un-blog-quelconque.example/post");
    expect(result.tier).toBe(3);
    expect(result.registered).toBe(false);
  });

  it("ne fait pas tomber le pipeline sur une URL invalide", () => {
    const result = classifySource("pas-une-url");
    expect(result.tier).toBe(3);
    expect(result.registered).toBe(false);
  });
});

describe("EP-001 — secondaires eclipsees par une primaire", () => {
  it("signale la presse quand une source primaire est disponible", () => {
    const shadowed = secondariesShadowedByPrimary([
      "https://fred.stlouisfed.org/series/X",
      "https://gnews.io/articles/x",
    ]);
    expect(shadowed).toEqual(["https://gnews.io/articles/x"]);
  });

  it("ne signale rien quand il n'y a que du secondaire", () => {
    expect(
      secondariesShadowedByPrimary(["https://gnews.io/articles/x"]),
    ).toHaveLength(0);
  });
});
