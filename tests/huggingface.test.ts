/**
 * Adaptateur Hugging Face — diffusion des modeles.
 *
 * Ecrits AVANT le code (TDD).
 *
 * LE PIEGE DE CETTE SOURCE TIENT EN DEUX CHIFFRES, MESURES LE 2026-09-19 sur
 * `sentence-transformers/all-MiniLM-L6-v2` :
 *
 *   downloads        =   254 149 235
 *   downloadsAllTime = 3 901 265 576
 *
 * Un facteur QUINZE. Le champ `downloads` est la fenetre de trente jours — la
 * page du modele l'intitule « Downloads last month » — et le cumul depuis la
 * publication porte un autre nom. La specification OpenAPI du Hub ne documente
 * ni l'un ni l'autre : seule la mesure le dit. Publier le premier comme un
 * cumul serait une erreur d'un ordre de grandeur, dans un article.
 *
 * ET UN TELECHARGEMENT N'EST PAS UN UTILISATEUR. La documentation officielle
 * (huggingface.co/docs/hub/en/models-download-stats, relevee le meme jour) est
 * explicite : « Every HTTP request to these files, including GET and HEAD, will
 * be counted as a download », sur un fichier de configuration. Les chaines
 * d'integration continue sont comptees, et la deduplication par utilisateur
 * n'est possible qu'avec l'outil payant reserve aux editeurs. Le chiffre est
 * donc exact en tant que compteur, et trompeur en tant que mesure d'adoption :
 * EP-005 exige qu'il voyage avec sa definition.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { huggingFaceAdapter } from "../src/sources/huggingface.js";
import { lastFetchedUrl, stubFetch } from "./helpers.js";

const QUERY = { topic: "modeles de langage", since: "2026-01-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Enregistrement conforme a ce que l'API a REELLEMENT rendu le 2026-09-19. */
const modele = (overrides: Record<string, unknown> = {}) => ({
  _id: "621ffdc136468d709f180294",
  id: "Qwen/Qwen3.8-27B",
  author: "Qwen",
  trendingScore: 167,
  downloads: 7_365_368,
  downloadsAllTime: 3_901_265_576,
  likes: 15_749,
  createdAt: "2026-08-05T08:22:59.000Z",
  pipeline_tag: "text-generation",
  ...overrides,
});

const adaptateur = () => huggingFaceAdapter({ limit: 3, cacheDir: null });

describe("interrogation", () => {
  it("DEMANDE explicitement le cumul, qui n'est pas rendu par defaut", async () => {
    // Mesure du 2026-09-19 : sans `expand[]=downloadsAllTime`, la reponse ne
    // porte QUE la fenetre de trente jours. L'adaptateur ne peut donc pas
    // distinguer les deux chiffres — il les confondrait en silence.
    stubFetch([modele()]);
    await adaptateur().fetch(QUERY);
    expect(lastFetchedUrl()).toMatch(/expand%5B%5D=downloadsAllTime/);
    expect(lastFetchedUrl()).toMatch(/sort=trendingScore/);
  });

  it("n'utilise PAS le tri par date de creation", async () => {
    // Mesure du 2026-09-19 : `sort=createdAt` rend des depots personnels
    // vieux de quelques minutes, a zero telechargement. Un flux de bruit.
    stubFetch([modele()]);
    await adaptateur().fetch(QUERY);
    expect(lastFetchedUrl()).not.toMatch(/sort=createdAt/);
  });
});

describe("ce que le chiffre veut dire (EP-005)", () => {
  it("DISTINGUE la fenetre de trente jours du cumul", async () => {
    stubFetch([modele()]);
    const resume = (await adaptateur().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume, "la fenetre de 30 jours n'est pas nommee").toMatch(/30 derniers jours/);
    expect(resume, "le cumul n'est pas nomme").toMatch(/depuis la publication/);
    expect(resume).toMatch(/7 365 368|7365368/);
    expect(resume).toMatch(/3 901 265 576|3901265576/);
  });

  it("accole la DEFINITION du telechargement", async () => {
    // Sans elle, « 7,3 millions de telechargements » se lit comme 7,3 millions
    // d'utilisateurs, alors que ce sont des requetes HTTP vers un fichier de
    // configuration, chaines d'integration continue comprises.
    stubFetch([modele()]);
    const resume = (await adaptateur().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/requete/i);
    expect(resume).toMatch(/pas (des|d'|de) utilisateur|non deduplique|sans deduplication/i);
  });

  it("declare le classement de tendance comme une mesure OPAQUE", async () => {
    // Hugging Face ne publie aucune methode pour son `trendingScore`. Le
    // reproduire sans le dire donnerait a un chiffre invente par une
    // plateforme l'allure d'une mesure.
    stubFetch([modele()]);
    const resume = (await adaptateur().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/non publiee|opaque|non documentee/i);
  });

  it("ne PRESENTE PAS le classement comme un ordre de popularite", async () => {
    // Deux modeles, le second bien plus telecharge que le premier : la
    // tendance n'est pas le volume, et l'article ne doit pas le suggerer.
    stubFetch([
      modele({ id: "a/petit", downloads: 1000, downloadsAllTime: 2000, trendingScore: 900 }),
      modele({ id: "b/gros", downloads: 9_000_000, downloadsAllTime: 90_000_000, trendingScore: 10 }),
    ]);
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]?.resume).not.toMatch(/le plus telecharge|premier au classement/i);
  });
});

describe("contrat d'observation", () => {
  it("cite l'enregistrement qui porte REELLEMENT les deux chiffres", async () => {
    stubFetch([modele()]);
    const url = (await adaptateur().fetch(QUERY)).observations[0]?.url ?? "";
    expect(url).toMatch(/^https:\/\/huggingface\.co\/api\/models\/Qwen\/Qwen3\.8-27B/);
    expect(url, "l'adresse citee ne rend pas le cumul").toMatch(/downloadsAllTime/);
  });

  it("date la publication du modele, pas la collecte", async () => {
    stubFetch([modele()]);
    const o = (await adaptateur().fetch(QUERY)).observations[0];
    expect(o?.date_published).toBe("2026-08-05T08:22:59.000Z");
    expect(o?.date_observed).not.toBe(o?.date_published);
  });

  it("NE declare AUCUN tier : c'est le registre qui le fixe (§4)", async () => {
    stubFetch([modele()]);
    const o = (await adaptateur().fetch(QUERY)).observations[0] as unknown as Record<
      string,
      unknown
    >;
    expect(o["tier"]).toBeUndefined();
  });

  it("nomme le modele et son auteur", async () => {
    stubFetch([modele()]);
    const resume = (await adaptateur().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/Qwen\/Qwen3\.8-27B/);
  });
});

describe("refus", () => {
  it("ECARTE un modele sans date de creation", async () => {
    // Sans date, l'observation ne peut pas atteindre le niveau de preuve 2
    // (§2) : rien ne permet de situer le fait dans le temps.
    stubFetch([modele({ createdAt: undefined }), modele({ id: "b/ok" })]);
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toMatch(/b\/ok/);
  });

  it("ECARTE un modele sans identifiant", async () => {
    stubFetch([modele({ id: undefined }), modele({ id: "b/ok" })]);
    expect((await adaptateur().fetch(QUERY)).observations).toHaveLength(1);
  });

  it("ECARTE un modele dont le cumul manque, plutot que de servir la fenetre", async () => {
    // Le coeur du piege : en l'absence du cumul, presenter les trente jours
    // comme un total serait une erreur d'un facteur quinze.
    stubFetch([modele({ downloadsAllTime: undefined }), modele({ id: "b/ok" })]);
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toMatch(/b\/ok/);
  });

  it("echoue si la reponse n'est pas une liste", async () => {
    stubFetch({ error: "Not found" });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/liste|tableau/i);
  });

  it("echoue en disant combien d'enregistrements ont ete ecartes", async () => {
    stubFetch([modele({ id: undefined }), modele({ createdAt: undefined })]);
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/2 /);
  });

  it("sur un refus de debit, RAPPELLE la limite documentee", async () => {
    // Relevee le 2026-09-19 : 500 requetes par fenetre de cinq minutes en
    // anonyme. Un « HTTP 429 » nu obligerait a rouvrir la documentation.
    stubFetch(undefined, { ok: false, status: 429 });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/500 requetes.*5 minutes/is);
  });
});

describe("debit et cache", () => {
  it("ne redemande PAS la liste a la seconde collecte", async () => {
    const adaptateurUnique = huggingFaceAdapter({ limit: 3, cacheDir: null, ttlMs: 60_000 });
    stubFetch([modele()]);
    await adaptateurUnique.fetch(QUERY);
    await adaptateurUnique.fetch(QUERY);
    const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(mock.mock.calls).toHaveLength(1);
  });
});
