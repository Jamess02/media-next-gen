/**
 * HTTPS — ou plutot : ou il compte, et ou il ne compte pas.
 *
 * Ecrits AVANT le code (TDD).
 *
 * LE CAS QUI N'EN EST PAS UN. Le serveur d'apercu sert en clair sur
 * 127.0.0.1, et c'est CORRECT. Les navigateurs traitent explicitement
 * `http://127.0.0.1` et `http://localhost` comme des contextes SURS : le
 * trafic ne quitte pas la machine, il n'y a pas de reseau a intercepter. Y
 * mettre un certificat auto-signe n'ajouterait aucune protection et
 * entrainerait a cliquer sur les avertissements de certificat — exactement
 * l'habitude qu'il ne faut pas prendre.
 *
 * LES TROIS CAS QUI EN SONT. HTTPS compte partout ou une donnee TRAVERSE un
 * reseau, et il y a trois de ces endroits :
 *
 *  1. L'URL PUBLIQUE du site, injectee dans le canonique, les metadonnees de
 *     partage, le flux RSS et le sitemap. `MEDIA_SITE_URL` etait accepte tel
 *     quel : une valeur en `http://` faisait basculer TOUTES ces adresses en
 *     clair d'un coup.
 *  2. LA COLLECTE. Interroger une source en clair, c'est laisser un tiers sur
 *     le chemin modifier la donnee AVANT qu'elle fonde une claim. Pour un
 *     media dont toute la promesse est la preuve, c'est disqualifiant : on
 *     publierait comme observe ce qu'un intermediaire a ecrit.
 *  3. LA CITATION. Une source citee en `http://` est verifiable mais
 *     alterable : ce que le lecteur controle n'est pas necessairement ce que
 *     nous avons observe. Le §2 promet une URL verifiable, pas seulement
 *     joignable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runEditorialGate } from "../src/protocol/rules.js";
import { fetchJson } from "../src/sources/http.js";
import { siteUrl } from "../src/site/templates.js";
import { article, claim } from "./helpers.js";

const ENV = process.env["MEDIA_SITE_URL"];
afterEach(() => {
  if (ENV === undefined) delete process.env["MEDIA_SITE_URL"];
  else process.env["MEDIA_SITE_URL"] = ENV;
  vi.unstubAllGlobals();
});

describe("URL publique du site", () => {
  it("est en https par defaut", () => {
    delete process.env["MEDIA_SITE_URL"];
    expect(siteUrl()).toMatch(/^https:\/\//);
  });

  it("REFUSE une URL publique en clair", () => {
    // Une seule variable mal renseignee ferait basculer le canonique, les
    // metadonnees de partage, le flux RSS et le sitemap en meme temps.
    process.env["MEDIA_SITE_URL"] = "http://media.exemple.fr";
    expect(() => siteUrl()).toThrow(/https/i);
  });

  it("tolere le clair sur la boucle locale, qui est un contexte sur", () => {
    // Utile pour verifier les URLs absolues sans deployer.
    process.env["MEDIA_SITE_URL"] = "http://127.0.0.1:4321";
    expect(siteUrl()).toBe("http://127.0.0.1:4321");
    process.env["MEDIA_SITE_URL"] = "http://localhost:4321";
    expect(siteUrl()).toBe("http://localhost:4321");
  });

  it("refuse une valeur qui n'est pas une URL", () => {
    process.env["MEDIA_SITE_URL"] = "media.exemple.fr";
    expect(() => siteUrl()).toThrow();
  });
});

describe("collecte : aucune source interrogee en clair", () => {
  it("refuse d'interroger une URL http", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(
      fetchJson("http://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(/clair|https/i);
  });

  it("n'emet meme pas la requete", async () => {
    // Le refus doit precede l'appel : une requete partie a deja expose la
    // donnee, meme si on jette la reponse ensuite.
    const espion = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", espion);
    await fetchJson("http://api.exemple.test/data", { sourceName: "Test" }).catch(
      () => undefined,
    );
    expect(espion).not.toHaveBeenCalled();
  });

  it("refuse une REDIRECTION qui retrograde vers http", async () => {
    // Le cas realiste : la source repond en https puis renvoie vers du clair.
    let appel = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        appel += 1;
        return appel === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "http://api.exemple.test/suite" },
            })
          : new Response("{}", { status: 200 });
      }),
    );
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).rejects.toThrow(/clair|https|redirection/i);
  });

  it("laisse passer https", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    await expect(
      fetchJson("https://api.exemple.test/data", { sourceName: "Test" }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("citation : une source en clair est signalee au relecteur", () => {
  const enClair = () =>
    article({
      claims: [
        claim({
          sources: [
            {
              url: "http://www.federalreserve.gov/feeds/H41.html",
              tier: 1,
              date_observed: "2026-09-09T09:00:00Z",
              date_published: null,
            },
          ],
        }),
      ],
    });

  it("signale sans bloquer", () => {
    // AVERTISSEMENT et non blocage : certaines archives publiques n'existent
    // qu'en clair, et les perdre appauvrirait la preuve plus que le risque ne
    // la menace. Le relecteur tranche.
    const v = runEditorialGate(enClair()).violations.find(
      (x) => x.rule === "INSECURE_SOURCE_URL",
    );
    expect(v?.severity).toBe("warning");
    expect(runEditorialGate(enClair()).passed).toBe(true);
  });

  it("ne dit rien d'une source en https", () => {
    expect(
      runEditorialGate(article()).violations.map((v) => v.rule),
    ).not.toContain("INSECURE_SOURCE_URL");
  });
});
