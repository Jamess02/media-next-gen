/**
 * Couche HTTP mutualisee des adaptateurs.
 *
 * Ces trois cas sont exactement ceux ou une source se comporte mal EN SILENCE.
 * Sans eux, le pipeline publierait du vide ou pendrait indefiniment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SourceFetchError,
  buildUrl,
  fetchJson,
  formatMeasure,
} from "../src/sources/http.js";
import { stubFetch, stubFetchFailure } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPTIONS = { sourceName: "Source de test" };

describe("fetchJson", () => {
  it("rend la charge utile parsee", async () => {
    stubFetch({ ok: true, valeur: 42 });
    expect(await fetchJson("https://example.org/a", OPTIONS)).toEqual({
      ok: true,
      valeur: 42,
    });
  });

  it("echoue sur un statut non OK, en nommant la source", async () => {
    stubFetch(null, { ok: false, status: 503 });
    await expect(fetchJson("https://example.org/a", OPTIONS)).rejects.toThrow(
      /Source de test : HTTP 503/,
    );
  });

  it("echoue sur une page de maintenance servie en HTTP 200", async () => {
    // Cas courant et pernicieux : le statut est bon, le corps ne l'est pas.
    stubFetch(null, { asText: "<html><body>Service unavailable</body></html>" });
    await expect(fetchJson("https://example.org/a", OPTIONS)).rejects.toThrow(
      /reponse non-JSON/,
    );
  });

  it("distingue un timeout d'une panne reseau", async () => {
    // Les deux ne se corrigent pas de la meme facon, et le §5.2 demande de
    // savoir pourquoi une source est muette.
    stubFetchFailure("TimeoutError", "The operation was aborted");
    await expect(
      fetchJson("https://example.org/a", { ...OPTIONS, timeoutMs: 500 }),
    ).rejects.toThrow(/pas de reponse en 500 ms/);

    stubFetchFailure("TypeError", "getaddrinfo ENOTFOUND example.org");
    await expect(fetchJson("https://example.org/a", OPTIONS)).rejects.toThrow(
      /echec reseau/,
    );
  });

  it("expose l'URL interrogee sur l'erreur", async () => {
    stubFetch(null, { ok: false, status: 404 });
    try {
      await fetchJson("https://example.org/introuvable", OPTIONS);
      expect.unreachable("aurait du lever");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceFetchError);
      expect((error as SourceFetchError).requestedUrl).toBe(
        "https://example.org/introuvable",
      );
      expect((error as SourceFetchError).status).toBe(404);
    }
  });
});

describe("buildUrl", () => {
  it("encode les valeurs", () => {
    expect(buildUrl("https://x.org/a", { q: "a b&c" })).toBe(
      "https://x.org/a?q=a%20b%26c",
    );
  });

  it("omet les parametres undefined", () => {
    // Sinon un "&limit=undefined" partirait tel quel dans le journal d'audit.
    expect(buildUrl("https://x.org/a", { q: "1", limit: undefined })).toBe(
      "https://x.org/a?q=1",
    );
  });

  it("ne laisse pas de ? quand il n'y a aucun parametre", () => {
    expect(buildUrl("https://x.org/a", {})).toBe("https://x.org/a");
  });
});

describe("formatMeasure (EP-005)", () => {
  it("arrondit les flottants bruts des APIs", () => {
    expect(formatMeasure(2.46705543774613)).toBe("2.47");
  });

  it("n'invente pas de decimales sur un entier", () => {
    expect(formatMeasure(3)).toBe("3");
  });

  it("respecte la precision demandee", () => {
    expect(formatMeasure(6.44, 1)).toBe("6.4");
  });

  it("gere les negatifs", () => {
    expect(formatMeasure(-23.4567)).toBe("-23.46");
  });
});
