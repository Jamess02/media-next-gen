/**
 * Adaptateur Currents API — agregateur de presse.
 *
 * Currents ne PRODUIT pas d'information : il agrege des articles publies
 * ailleurs et rend, pour chacun, l'URL de l'editeur d'origine. C'est cette URL
 * qui est citee, jamais celle de Currents — sans quoi l'article citerait un
 * intermediaire au lieu de la source, ce que EP-001 interdit.
 *
 * Consequence utile : le tier est derive du domaine de l'EDITEUR par le
 * registre. Un article du Monde et un billet d'un domaine inconnu passent par
 * ce meme code et ressortent avec des tiers differents.
 *
 * Contraintes MESUREES sur l'API reelle le 2026-09-10, non documentees dans
 * les pages consultees (rendues en JavaScript, donc vides pour un client HTTP) :
 *
 *  - la clef s'envoie en en-tete `Authorization` ; le parametre `apiKey` en
 *    URL est l'ancienne methode, et la mettre en URL la ferait archiver dans
 *    le journal d'audit (§9.4) ;
 *  - `start_date` doit etre en RFC 3339 ;
 *  - l'intervalle de dates est plafonne : -6 jours passe, -7 jours rend un
 *    HTTP 400 `{"date_range":"Max range is 7 days"}`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { currentsAdapter } from "../src/sources/currents.js";

const CLEF = "clef-de-test-jamais-reelle";
const QUERY = { topic: "inflation zone euro", since: "2026-09-08T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (o: Record<string, unknown> = {}) => ({
  id: "ac4062d1-5fbb-4784-bf1d-6b50f5f643a0",
  title: "L'inflation ralentit en zone euro",
  description: "Les prix progressent moins vite qu'au trimestre precedent.",
  url: "https://www.lemonde.fr/economie/article/2026/09/09/inflation.html",
  author: "Le Monde",
  image: "None",
  language: "fr",
  category: ["economy"],
  published: "2026-09-09 22:35:27 +0000",
  ...o,
});

function stub(charge: unknown, ok = true, status = 200) {
  // Les parametres sont declares : sans eux, TypeScript infere des appels vides
  // et `mock.calls[0][0]` devient inatteignable — or c'est precisement l'URL
  // interrogee que les tests de securite doivent inspecter.
  const faux = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
    ok,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(charge),
  }));
  vi.stubGlobal("fetch", faux);
  return faux;
}

const adaptateur = () => currentsAdapter({ apiKey: CLEF });

describe("Currents — correspondance vers une observation", () => {
  it("cite l'URL de l'EDITEUR, pas celle de Currents", async () => {
    stub({ status: "ok", news: [item()] });
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toBe(
      "https://www.lemonde.fr/economie/article/2026/09/09/inflation.html",
    );
    expect(r.observations[0]?.url).not.toContain("currentsapi");
  });

  it("convertit la date « YYYY-MM-DD HH:MM:SS +0000 » en ISO", async () => {
    stub({ status: "ok", news: [item()] });
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]?.date_published).toBe("2026-09-09T22:35:27.000Z");
  });

  it("ne declare AUCUN tier : c'est la passerelle qui le derive du domaine", async () => {
    stub({ status: "ok", news: [item()] });
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations[0]).not.toHaveProperty("tier");
  });

  it("accole la mention de presse a chaque resume quand elle est fournie", async () => {
    // Comme pour les flux RSS de presse : la mention voyage avec le texte
    // jusqu'a la claim, donc jusqu'a l'article. L'Analyste doit voir qu'il lit
    // une reprise editorialisee AVANT de typer sa claim en `fait`.
    stub({ status: "ok", news: [item()] });
    const a = currentsAdapter({ apiKey: CLEF, caveat: "Source de presse (tier 3)." });
    const r = await a.fetch(QUERY);
    expect(r.observations[0]?.resume).toContain("Source de presse (tier 3).");
  });

  it("ecarte une entree sans URL exploitable plutot que d'inventer", async () => {
    stub({ status: "ok", news: [item({ url: "" }), item()] });
    const r = await adaptateur().fetch(QUERY);
    expect(r.observations).toHaveLength(1);
  });
});

describe("Currents — la clef ne doit jamais atteindre le journal", () => {
  it("envoie la clef en en-tete Authorization", async () => {
    const faux = stub({ status: "ok", news: [item()] });
    await adaptateur().fetch(QUERY);
    const init = faux.mock.calls[0]?.[1] as unknown as {
      headers?: Record<string, string>;
    };
    expect(init?.headers?.["authorization"]).toBe(`Bearer ${CLEF}`);
  });

  it("n'ecrit JAMAIS la clef dans l'URL interrogee", async () => {
    // §9.4 : `requestedUrl` est archive tel quel. Une clef en parametre de
    // requete serait donc versionnee. C'est la faute qui avait failli publier
    // la clef FRED.
    const faux = stub({ status: "ok", news: [item()] });
    const r = await adaptateur().fetch(QUERY);
    expect(r.requestedUrl).not.toContain(CLEF);
    expect(r.requestedUrl).not.toContain("apiKey");
    expect(String(faux.mock.calls[0]?.[0])).not.toContain(CLEF);
  });
});

describe("Currents — plafond de 7 jours sur l'intervalle", () => {
  it("borne start_date a 6 jours meme si la fenetre demandee est plus large", async () => {
    // MESURE : -6 jours rend HTTP 200, -7 jours rend HTTP 400. La fenetre de
    // fraicheur du pipeline etant de 30 jours, passer `since` tel quel
    // ferait echouer CHAQUE collecte.
    const faux = stub({ status: "ok", news: [item()] });
    await adaptateur().fetch({ topic: "inflation", since: "2026-01-01T00:00:00Z" });
    const url = new URL(String(faux.mock.calls[0]?.[0]));
    const debut = Date.parse(url.searchParams.get("start_date") ?? "");
    expect(Number.isNaN(debut)).toBe(false);
    const jours = (Date.now() - debut) / 86_400_000;
    expect(jours).toBeLessThan(7);
  });

  it("respecte une fenetre plus courte que le plafond", async () => {
    const faux = stub({ status: "ok", news: [item()] });
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await adaptateur().fetch({ topic: "inflation", since });
    const url = new URL(String(faux.mock.calls[0]?.[0]));
    expect(Date.parse(url.searchParams.get("start_date") ?? "")).toBe(
      Date.parse(since),
    );
  });
});

describe("Currents — echecs", () => {
  it("echoue explicitement sur un HTTP non 200", async () => {
    stub({ status: "429", msg: "quota" }, false, 429);
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/429/);
  });

  it("echoue quand la charge annonce une erreur malgre un HTTP 200", async () => {
    stub({ status: "error", msg: "Invalid API key" });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow(/Invalid API key/);
  });

  it("echoue quand la forme attendue est absente, au lieu de rendre du vide", async () => {
    stub({ status: "ok" });
    await expect(adaptateur().fetch(QUERY)).rejects.toThrow();
  });
});

describe("Currents — la requete envoyee", () => {
  it("n'envoie PAS le sujet entier, mais des termes joints par OU", async () => {
    // Regression du 2026-09-10 : le sujet complet etait envoye tel quel, les
    // deux API font un ET, et douze appels ont rendu ZERO observation sans la
    // moindre erreur. Un echec muet est le plus couteux : tout parait marcher.
    const faux = stub({ status: "ok", news: [item()] });
    const sujet = "inflation annuelle en zone euro : dernier releve publie par Eurostat";
    await adaptateur().fetch({ topic: sujet, since: QUERY.since });
    const q = new URL(String(faux.mock.calls[0]?.[0])).searchParams.get("keywords") ?? "";
    expect(q).not.toBe(sujet);
    expect(q).not.toContain(" OR ");
    expect(q.split(" ")).toHaveLength(2);
    expect(q).toContain("inflation");
  });
});
