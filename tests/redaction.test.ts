/**
 * Caviardage des secrets dans le journal versionne (§9.4).
 *
 * Le journal part sur un depot public : un test qui tombe ici signifie qu'une
 * clef d'API peut etre commitee. L'historique Git la conserverait meme apres
 * suppression du fichier.
 */

import { describe, expect, it } from "vitest";

import {
  REDACTED,
  isSecretParam,
  redactText,
  redactUrl,
} from "../src/audit/redaction.js";

describe("detection des parametres secrets", () => {
  it("reconnait les variantes d'ecriture d'une clef d'API", () => {
    for (const name of ["api_key", "API-KEY", "apiKey", "Api.Key"]) {
      expect(isSecretParam(name), name).toBe(true);
    }
  });

  it("reconnait les jetons et secrets par suffixe", () => {
    for (const name of ["access_token", "refresh_token", "client_secret"]) {
      expect(isSecretParam(name), name).toBe(true);
    }
  });

  it("reconnait `key` seul, employe par plusieurs APIs publiques", () => {
    expect(isSecretParam("key")).toBe(true);
  });

  it("ne caviarde pas les parametres anodins finissant par `key`", () => {
    // `key` n'est volontairement pas traite comme suffixe.
    for (const name of ["sort_key", "cache_key", "series_id", "format"]) {
      expect(isSecretParam(name), name).toBe(false);
    }
  });
});

describe("caviardage d'URL", () => {
  it("caviarde une clef FRED sans toucher au reste de l'URL", () => {
    // Cas reel : FRED transporte sa clef dans la chaine de requete.
    const { redacted, redactedParams } = redactUrl(
      "https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=abcd1234secret&file_type=json",
    );

    expect(redacted).toBe(
      `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${REDACTED}&file_type=json`,
    );
    expect(redacted).not.toMatch(/abcd1234secret/);
    expect(redactedParams).toEqual(["apikey"]);
  });

  it("preserve l'URL a l'octet pres quand elle ne contient aucun secret", () => {
    // §9.4 exige "l'URL exacte interrogee" : pas de reencodage parasite.
    const url =
      "https://api.worldbank.org/v2/country/EMU/indicator/FP.CPI.TOTL.ZG?format=json&per_page=5&date=2021:2026";
    const { redacted, redactedParams } = redactUrl(url);

    expect(redacted).toBe(url);
    expect(redactedParams).toHaveLength(0);
  });

  it("caviarde plusieurs secrets dans la meme URL", () => {
    const { redacted, redactedParams } = redactUrl(
      "https://example.org/x?token=aaa&page=2&client_secret=bbb",
    );

    expect(redacted).not.toMatch(/aaa/);
    expect(redacted).not.toMatch(/bbb/);
    expect(redacted).toMatch(/page=2/);
    expect(redactedParams.sort()).toEqual(["clientsecret", "token"]);
  });

  it("caviarde un mot de passe place dans l'autorite", () => {
    const { redacted, redactedParams } = redactUrl(
      "https://alice:motdepasse@example.org/data",
    );

    expect(redacted).toBe(`https://alice:${REDACTED}@example.org/data`);
    expect(redacted).not.toMatch(/motdepasse/);
    expect(redactedParams).toContain("userinfo:password");
  });

  it("ne confond pas un fragment avec la chaine de requete", () => {
    const url = "https://example.org/page#section?key=pas-un-parametre";
    expect(redactUrl(url).redacted).toBe(url);
  });

  it("conserve le nom du parametre caviarde", () => {
    // Savoir QUEL parametre portait le secret fait partie de la trace.
    expect(redactUrl("https://x.org/a?api_key=s").redacted).toMatch(/api_key=/);
  });
});

describe("caviardage dans un texte libre", () => {
  it("caviarde une URL contenue dans un message d'erreur", () => {
    // Sans ca, la clef transiterait par le champ `error` du journal en
    // contournant le caviardage de `target`.
    const { redacted } = redactText(
      "Banque mondiale : HTTP 503 sur https://api.example.org/v1?api_key=TOPSECRET&id=4",
    );

    expect(redacted).not.toMatch(/TOPSECRET/);
    expect(redacted).toMatch(/HTTP 503/);
    expect(redacted).toMatch(/id=4/);
  });

  it("laisse intact un texte sans URL", () => {
    const text = "HTTP 503 : service indisponible (simule)";
    expect(redactText(text).redacted).toBe(text);
  });

  it("traite plusieurs URLs dans le meme message", () => {
    const { redacted } = redactText(
      "echec sur https://a.org?token=AAA puis sur https://b.org?api_key=BBB",
    );
    expect(redacted).not.toMatch(/AAA/);
    expect(redacted).not.toMatch(/BBB/);
  });
});
