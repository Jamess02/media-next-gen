/**
 * SECURITE — interactions avec les API externes.
 *
 * Ecrits AVANT le code qui les fait passer (TDD). Chacun correspond a une
 * faille constatee par lecture du code, pas a une precaution theorique :
 *
 *  1. FUITE DE SECRET. La clef FRED voyage dans l'URL. Le journal d'audit la
 *     caviarde ; le message d'erreur d'un adaptateur en echec, lui, remonte
 *     jusqu'aux incertitudes declarees de l'article — donc au site public ET
 *     au depot Git, ou `articles/` est versionne. FRED a deja rendu un 502
 *     pendant une collecte reelle : le cas n'est pas hypothetique.
 *
 *  2. SSRF PAR REDIRECTION. `fetch` suit les redirections par defaut. Une
 *     source compromise ou un redirecteur ouvert peut donc faire interroger
 *     169.254.169.254 (metadonnees cloud) ou 127.0.0.1:5173 (le studio, qui
 *     declenche des appels factures) par notre propre infrastructure.
 *     `protocol/url.ts` refuse deja ces hotes pour les URLs CITEES ; la couche
 *     de transport ne le faisait pas.
 *
 *  3. ABSENCE DE PLAFOND DE TAILLE. `await response.text()` sur un corps de
 *     plusieurs gigaoctets epuise la memoire du processus. Une source lente ou
 *     hostile suffit a faire tomber le pipeline.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { SourceGateway } from "../src/sources/gateway.js";
import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  SourceFetchError,
  fetchJson,
} from "../src/sources/http.js";
import { rssAdapter } from "../src/sources/rss.js";
import type { SourceAdapter } from "../src/sources/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CLEF = "bbb1cad5dab9fe4e5766f4b6cd1cedc2";
const URL_AVEC_CLEF =
  `https://api.stlouisfed.org/fred/series/observations` +
  `?series_id=FEDFUNDS&api_key=${CLEF}&file_type=json`;

const QUERY = { topic: "inflation", since: "2026-01-01T00:00:00Z" };

/** Reponses reelles : `Response` fournit de vrais en-tetes et un vrai flux. */
function stubReponses(...reponses: Response[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reponses[Math.min(i++, reponses.length - 1)]),
  );
}

const redirection = (vers: string): Response =>
  new Response(null, { status: 302, headers: { location: vers } });

/* -------------------------------------------------------------------------
 * 1. Fuite de secret dans les messages d'erreur
 * ---------------------------------------------------------------------- */

describe("aucune clef d'API ne sort d'un message d'erreur", () => {
  it("caviarde la clef dans l'erreur d'une source en echec", async () => {
    stubReponses(new Response("upstream down", { status: 502 }));

    await expect(
      fetchJson(URL_AVEC_CLEF, { sourceName: "FRED" }),
    ).rejects.toSatisfy((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      return !message.includes(CLEF);
    });
  });

  it("caviarde aussi l'URL portee par l'exception elle-meme", async () => {
    // `requestedUrl` est lu par la passerelle : le caviardage doit porter sur
    // le champ, pas seulement sur le texte du message.
    stubReponses(new Response("nope", { status: 500 }));
    try {
      await fetchJson(URL_AVEC_CLEF, { sourceName: "FRED" });
      throw new Error("attendu : rejet");
    } catch (e) {
      expect(e).toBeInstanceOf(SourceFetchError);
      expect((e as SourceFetchError).requestedUrl).not.toContain(CLEF);
    }
  });

  it("LA PASSERELLE ne laisse aucune clef atteindre le rapport de collecte", async () => {
    // C'est le chemin qui mene a l'article : failures -> uncertainty_flags ->
    // markdown publie -> site -> depot Git.
    const adaptateurQuiFuit: SourceAdapter = {
      id: "fred:FEDFUNDS",
      describes: "Serie de test",
      async fetch() {
        throw new SourceFetchError("FRED", URL_AVEC_CLEF, "HTTP 502", 502);
      },
    };

    const audit = new AuditLog({ persist: false });
    const resultat = await new SourceGateway([adaptateurQuiFuit], audit).collect(
      QUERY,
      "veilleur",
    );

    expect(resultat.failures).toHaveLength(1);
    expect(JSON.stringify(resultat.failures)).not.toContain(CLEF);
  });

  it("conserve un message exploitable apres caviardage", async () => {
    // Un caviardage qui rendrait l'erreur illisible serait remplace par un
    // contournement a la premiere seance de mise au point.
    stubReponses(new Response("boom", { status: 502 }));
    try {
      await fetchJson(URL_AVEC_CLEF, { sourceName: "FRED" });
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("FRED");
      expect(message).toContain("502");
      expect(message).toContain("api.stlouisfed.org");
    }
  });
});

/* -------------------------------------------------------------------------
 * 2. SSRF par redirection
 * ---------------------------------------------------------------------- */

describe("les redirections ne sortent pas de l'Internet public", () => {
  const cibles = [
    ["metadonnees cloud", "http://169.254.169.254/latest/meta-data/"],
    ["boucle locale", "http://127.0.0.1:5173/api/publier"],
    ["localhost nomme", "http://localhost:5173/api/publier"],
    ["reseau prive", "http://192.168.1.10/admin"],
    ["boucle locale IPv6", "http://[::1]:5173/"],
  ] as const;

  for (const [nom, cible] of cibles) {
    it(`refuse une redirection vers ${nom}`, async () => {
      stubReponses(redirection(cible), new Response("{}", { status: 200 }));
      await expect(
        fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
      ).rejects.toThrow(/redirection refusee|hote non routable/i);
    });
  }

  it("refuse un changement de schema vers file:", async () => {
    stubReponses(redirection("file:///C:/Users/Utilisateur/Desktop/Media_next_gen/.env"));
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(/redirection refusee/i);
  });

  it("suit une redirection legitime vers un hote public", async () => {
    stubReponses(
      redirection("https://api2.exemple.test/data"),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).resolves.toEqual({ ok: true });
  });

  it("borne le nombre de sauts pour ne pas boucler", async () => {
    stubReponses(redirection("https://api.exemple.test/encore"));
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(new RegExp(`${MAX_REDIRECTS}`));
  });

  it("protege AUSSI l'adaptateur de flux, qui suivait les redirections", async () => {
    stubReponses(redirection("http://169.254.169.254/latest/meta-data/"));
    const adapter = rssAdapter({
      id: "test:flux",
      source: "Test",
      url: "https://exemple.test/rss.xml",
      describes: "Flux de test",
    });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(
      /redirection refusee|hote non routable/i,
    );
  });
});

/* -------------------------------------------------------------------------
 * 3. Plafond de taille de reponse
 * ---------------------------------------------------------------------- */

describe("une reponse demesuree est refusee, pas mise en memoire", () => {
  it("refuse un content-length superieur au plafond", async () => {
    stubReponses(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(/trop volumineuse/i);
  });

  it("refuse un corps qui depasse le plafond SANS content-length annonce", { timeout: 20_000 }, async () => {
    // Un serveur hostile ment ou omet l'en-tete : le comptage doit se faire a
    // la lecture, sinon le plafond ne protege que les serveurs honnetes.
    const gros = "x".repeat(MAX_RESPONSE_BYTES + 1024);
    const flux = new ReadableStream<Uint8Array>({
      start(controller) {
        const morceau = new TextEncoder().encode("x".repeat(64 * 1024));
        for (let envoye = 0; envoye < gros.length; envoye += morceau.length) {
          controller.enqueue(morceau);
        }
        controller.close();
      },
    });
    stubReponses(new Response(flux, { status: 200 }));

    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(/trop volumineuse/i);
  });

  it("laisse passer une reponse de taille normale", async () => {
    stubReponses(new Response(JSON.stringify({ valeur: 42 }), { status: 200 }));
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).resolves.toEqual({ valeur: 42 });
  });

  it("plafonne aussi les flux RSS", { timeout: 20_000 }, async () => {
    const flux = new ReadableStream<Uint8Array>({
      start(controller) {
        // Charge INOFFENSIVE : ce test prouve le plafond, pas la fragilite de
        // l analyse. Avec des <item> repetes, la regex d extraction part en
        // explosion combinatoire et tue le worker avant toute assertion —
        // constate en phase rouge, et c est une raison de plus d avoir un
        // plafond : il s applique AVANT que le texte n atteigne la regex.
        const morceau = new TextEncoder().encode("x".repeat(64 * 1024));
        for (let i = 0; i < 160; i += 1) controller.enqueue(morceau);
        controller.close();
      },
    });
    stubReponses(new Response(flux, { status: 200 }));

    const adapter = rssAdapter({
      id: "test:flux",
      source: "Test",
      url: "https://exemple.test/rss.xml",
      describes: "Flux de test",
    });
    await expect(adapter.fetch(QUERY)).rejects.toThrow(/trop volumineuse/i);
  });
});
