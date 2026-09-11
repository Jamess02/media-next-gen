/**
 * Adaptateur newsdata.io — agregateur de presse.
 *
 * Meme principe que Currents : newsdata ne PRODUIT rien, il agrege. Chaque
 * article porte `link`, l'URL de l'editeur d'origine, et c'est elle qui est
 * citee. Le tier suit donc le domaine de l'editeur, jamais newsdata.io.
 *
 * Contraintes MESUREES sur l'API reelle le 2026-09-10. La page de
 * documentation est rendue en JavaScript, donc vide pour un client HTTP :
 * tout ce qui suit vient de la spec OpenAPI (/openapi.json) et de sondes.
 *
 *  - la clef s'envoie en en-tete `X-ACCESS-KEY` ; le parametre `apikey` en URL
 *    est l'autre methode offerte, et l'employer ferait ARCHIVER la clef dans
 *    le journal d'audit (§9.4) ;
 *  - `size` est plafonne a 10 sur le palier gratuit : `size=50` rend un
 *    HTTP 422 {"code":"UnsupportedFilter"} ;
 *  - quota vu en en-tetes : x-ratelimit-limit 60, retry-after 900 s ;
 *  - EN CAS D'ERREUR, `results` est un OBJET et non un tableau. Tester la
 *    forme avant le statut ferait donc rendre un message trompeur.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { newsdataAdapter } from "../src/sources/newsdata.js";

const CLEF = "pub_clef-de-test-jamais-reelle";
const QUERY = { topic: "inflation zone euro", since: "2026-09-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

const article = (o: Record<string, unknown> = {}) => ({
  article_id: "a".repeat(32),
  link: "https://www.boursorama.com/bourse/actualites/inflation-zone-euro",
  title: "L'inflation ralentit en zone euro",
  description: "Les prix progressent moins vite qu'au trimestre precedent.",
  language: "french",
  category: ["business"],
  datatype: "news",
  pubDate: "2026-09-09 10:58:10",
  pubDateTZ: "UTC",
  source_name: "Boursorama",
  source_priority: 1375,
  duplicate: false,
  ...o,
});

function stub(charge: unknown, ok = true, status = 200) {
  const faux = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
    ok,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(charge),
  }));
  vi.stubGlobal("fetch", faux);
  return faux;
}

const ok = (results: unknown[]) => ({
  status: "success",
  totalResults: results.length,
  results,
  nextPage: null,
});

const adaptateur = () => newsdataAdapter({ apiKey: CLEF });

describe("newsdata — correspondance vers une observation", () => {
  it("cite l'URL de l'EDITEUR, pas celle de newsdata", async () => {
    stub(ok([article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toContain("boursorama.com");
    expect(r.observations[0]?.url).not.toContain("newsdata.io");
  });

  it("combine pubDate et pubDateTZ pour produire une date ISO", async () => {
    // `pubDate` ne porte AUCUN decalage : "2026-09-09 10:58:10". Le fuseau est
    // dans un champ separe. Concatener sans lui ferait interpreter l'heure en
    // heure LOCALE de la machine — donc une date fausse, et silencieusement.
    stub(ok([article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]?.date_published).toBe("2026-09-09T10:58:10.000Z");
  });

  it("ne declare AUCUN tier : la passerelle le derive du domaine", async () => {
    stub(ok([article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]).not.toHaveProperty("tier");
  });

  it("prend `source_name` comme editeur, et retombe sur le domaine sinon", async () => {
    stub(ok([article({ source_name: null })]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]?.source).toBe("www.boursorama.com");
  });

  it("ecarte un article marque `duplicate`", async () => {
    // Sans ce filtre, un meme fait repris par cinq sites occuperait cinq
    // places dans la selection et donnerait l'illusion d'une convergence.
    stub(ok([article({ duplicate: true }), article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
  });

  it("ecarte une entree sans lien exploitable", async () => {
    stub(ok([article({ link: null }), article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
  });

  it("accole la mention de presse au resume quand elle est fournie", async () => {
    stub(ok([article()]));
    const a = newsdataAdapter({ apiKey: CLEF, caveat: "Source de presse (tier 3)." });
    const r = await a.fetch(QUERY);
    expect(r.observations[0]?.resume).toContain("Source de presse (tier 3).");
  });
});

describe("newsdata — la clef ne doit jamais atteindre le journal", () => {
  it("envoie la clef en en-tete X-ACCESS-KEY", async () => {
    const faux = stub(ok([article()]));
    await adaptateur().fetch(QUERY);
    const init = faux.mock.calls[0]?.[1] as unknown as {
      headers?: Record<string, string>;
    };
    expect(init?.headers?.["X-ACCESS-KEY"]).toBe(CLEF);
  });

  it("n'ecrit JAMAIS la clef dans l'URL interrogee", async () => {
    const faux = stub(ok([article()]));
    const r = await adaptateur().fetch(QUERY);
    expect(r.requestedUrl).not.toContain(CLEF);
    expect(r.requestedUrl).not.toContain("apikey");
    expect(String(faux.mock.calls[0]?.[0])).not.toContain(CLEF);
  });
});

describe("newsdata — plafond du palier gratuit", () => {
  it("borne `size` a 10, meme si on en demande davantage", async () => {
    // MESURE : size=50 rend HTTP 422 {"code":"UnsupportedFilter"}. Laisser
    // passer une valeur plus grande ferait echouer la collecte entiere.
    const faux = stub(ok([article()]));
    await newsdataAdapter({ apiKey: CLEF, limit: 50 }).fetch(QUERY);
    const url = new URL(String(faux.mock.calls[0]?.[0]));
    expect(Number(url.searchParams.get("size"))).toBeLessThanOrEqual(10);
  });
});

describe("newsdata — echecs", () => {
  it("echoue explicitement sur un HTTP non 200", async () => {
    stub({ status: "error", results: { message: "quota", code: "RateLimit" } }, false, 429);
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/429/);
  });

  it("echoue quand la charge annonce une erreur, dont `results` est un OBJET", async () => {
    // Forme reelle d'une erreur newsdata. Un controle « results est-il un
    // tableau ? » place AVANT le statut rendrait ici un message trompeur sur
    // la forme de la reponse au lieu du motif reel.
    stub({
      status: "error",
      results: { message: "The size provided is invalid", code: "UnsupportedFilter" },
    });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/size provided is invalid/);
  });

  it("echoue quand `results` est absent, au lieu de rendre du vide", async () => {
    stub({ status: "success", totalResults: 0 });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow();
  });
});

describe("newsdata — la requete envoyee", () => {
  it("n'envoie PAS le sujet entier, mais des termes joints par OU", async () => {
    const faux = stub(ok([article()]));
    const sujet = "bilan de la Reserve federale : niveau de l'actif total";
    await adaptateur().fetch({ topic: sujet, since: QUERY.since });
    const q = new URL(String(faux.mock.calls[0]?.[0])).searchParams.get("q") ?? "";
    expect(q).not.toBe(sujet);
    expect(q).not.toContain(" OR ");
    expect(q.split(" ")).toHaveLength(2);
  });
});

describe("newsdata — tri des resultats", () => {
  it("demande un tri par PERTINENCE, pas par date", async () => {
    // MESURE du 2026-09-10. Le defaut est `pubdatedesc` : l'API rend les
    // articles les plus RECENTS parmi ceux qui correspondent, pas les plus
    // pertinents. Sur « inflation zone », cela donnait « On vous explique le
    // syndrome de Kessler » ; avec `relevancy`, « La BCE devrait relever son
    // taux de depot de 25 points ». Meme requete, meme instant.
    const faux = stub(ok([article()]));
    await adaptateur().fetch(QUERY);
    const url = new URL(String(faux.mock.calls[0]?.[0]));
    expect(url.searchParams.get("sort")).toBe("relevancy");
  });
});
