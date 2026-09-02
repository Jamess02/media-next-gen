/**
 * Adaptateur l0g.fr (tier 2, CC BY 4.0).
 *
 * Deux obligations distinctes sont testees ici :
 *  - l'ATTRIBUTION, imposee par la licence et inscrite dans les usages
 *    interdits du manifeste de la source ;
 *  - la FRAICHEUR, que le manifeste demande explicitement de verifier pour ne
 *    pas presenter un instantane ancien comme du temps reel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { l0gAdapter } from "../src/sources/l0g.js";

const QUERY = { topic: "dette souveraine", since: "2026-01-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const article = (o: Record<string, unknown> = {}) => ({
  canonicalId: "article:dette",
  language: "fr",
  url: "https://l0g.fr/posts/dette/",
  title: "Les Etats ont raccourci la meche",
  date: "2026-09-02",
  description: "18 000 Md$ a emprunter : les maturites courtes accelerent le passage des taux.",
  topics: ["macro-banques-centrales"],
  ...o,
});

/**
 * L'adaptateur emet DEUX requetes : freshness d'abord, puis recent. Le bouchon
 * route sur l'URL plutot que sur l'ordre, pour ne pas dependre de l'ordonnancement.
 */
function stub(
  recent: unknown,
  freshness: unknown = { generated: "2026-09-02T15:49:20+02:00", staleAfter: "P2D" },
  freshnessFails = false,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("freshness")) {
        if (freshnessFails) throw new Error("reseau");
        return { ok: true, status: 200, text: async () => JSON.stringify(freshness) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(recent) };
    }),
  );
}

const surface = (articles: unknown[], generated = "2026-09-02T15:49:20+02:00") => ({
  generated,
  license: "CC BY 4.0",
  attribution: "l0g.fr",
  articles,
});

describe("attribution CC BY 4.0", () => {
  it("porte l'attribution DANS le resume, donc jusqu'a l'article publie", async () => {
    // Le manifeste de la source classe « supprimer l'attribution » parmi les
    // usages interdits. Placee ailleurs que dans le texte, elle se perdrait au
    // premier retraitement.
    stub(surface([article()]));
    const r = await l0gAdapter().fetch(QUERY);
    expect(r.observations[0]?.resume).toMatch(/Source : l0g\.fr, CC BY 4\.0\./);
  });
});

describe("fraicheur (§5.1)", () => {
  it("signale un instantane perime, avec le seuil publie par la source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z")); // 8 jours apres
    stub(surface([article()]));

    const resume = (await l0gAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/ATTENTION : instantane genere/);
    expect(resume).toMatch(/P2D/);
    expect(resume).toMatch(/ne pas presenter comme temps reel/);
  });

  it("ne signale rien quand l'instantane est frais", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T16:00:00Z"));
    stub(surface([article()]));

    const resume = (await l0gAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).not.toMatch(/ATTENTION/);
  });

  it("continue si freshness.json echoue : on perd la borne, pas le contenu", async () => {
    stub(surface([article()]), undefined, true);
    const r = await l0gAdapter().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
  });

  it("filtre par la fenetre de fraicheur de la requete", async () => {
    stub(surface([article({ date: "2025-01-01" }), article({ date: "2026-06-01" })]));
    const r = await l0gAdapter().fetch({ ...QUERY, since: "2026-01-01T00:00:00Z" });
    expect(r.observations).toHaveLength(1);
  });
});

describe("selection et contrat", () => {
  it("classe par pertinence au sujet, puis par fraicheur", async () => {
    stub(
      surface([
        article({ url: "https://l0g.fr/posts/hors-sujet/", title: "Energie", description: "Petrole", topics: [] }),
        article({ url: "https://l0g.fr/posts/pertinent/", title: "Dette souveraine et refinancement", description: "dette" }),
      ]),
    );
    const r = await l0gAdapter({ limit: 2 }).fetch(QUERY);
    expect(r.observations[0]?.url).toBe("https://l0g.fr/posts/pertinent/");
  });

  it("explicite le critere de selection dans le resume", async () => {
    // Un critere invisible n'est pas contestable.
    stub(surface([article()]));
    const resume = (await l0gAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/terme\(s\) du sujet present\(s\)|retenue par fraicheur/);
  });

  it("NE declare PAS de tier : c'est le registre qui le fixe (§4)", async () => {
    stub(surface([article()]));
    const observation = (await l0gAdapter().fetch(QUERY)).observations[0];
    expect(observation).toBeDefined();
    expect("tier" in (observation as object)).toBe(false);
  });

  it("respecte la limite demandee", async () => {
    stub(surface([article(), article({ url: "https://l0g.fr/posts/b/" }), article({ url: "https://l0g.fr/posts/c/" })]));
    expect((await l0gAdapter({ limit: 2 }).fetch(QUERY)).observations).toHaveLength(2);
  });

  it("ne retient que la langue demandee", async () => {
    stub(surface([article({ language: "en", url: "https://l0g.fr/en/x/" }), article()]));
    const r = await l0gAdapter({ language: "fr" }).fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).not.toMatch(/\/en\//);
  });

  it("normalise la date en ISO-8601 complet (§7)", async () => {
    stub(surface([article({ date: "2026-09-02" })]));
    const r = await l0gAdapter().fetch(QUERY);
    expect(r.observations[0]?.date_published).toBe("2026-09-02T00:00:00.000Z");
  });

  it("archive les deux surfaces pour l'audit (§9.4)", async () => {
    stub(surface([article()]));
    const r = await l0gAdapter().fetch(QUERY);
    expect(r.raw).toHaveProperty("recent");
    expect(r.raw).toHaveProperty("freshness");
  });
});

describe("echecs", () => {
  it("echoue sur une reponse sans tableau d'analyses", async () => {
    stub({ generated: "2026-09-02T00:00:00Z" });
    await expect(l0gAdapter().fetch(QUERY)).rejects.toThrow(/aucun tableau/);
  });

  it("echoue quand rien ne correspond, en disant combien ont ete examinees", async () => {
    stub(surface([article({ date: "2020-01-01" })]));
    await expect(l0gAdapter().fetch(QUERY)).rejects.toThrow(/sur 1 publiees/);
  });
});
