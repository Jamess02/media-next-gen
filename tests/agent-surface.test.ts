/**
 * Surface machine du site.
 *
 * Le §0 promet qu'un article puisse etre relu et conteste « par un humain ou
 * par un autre agent ». Ces tests portent sur la seconde moitie de la promesse :
 * ce qu'un agent tiers peut lire, et ce qu'il peut verifier.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentManifest,
  articlesSurface,
  canonicalJsonHash,
  integritySurface,
  sha256,
} from "../src/site/agent-surface.js";
import { buildSite } from "../src/site/build.js";
import type { ReviewRecord } from "../src/editorial/validation.js";
import { article, claim } from "./helpers.js";

const REVIEW: ReviewRecord = {
  article_id: "article-00000000-0000-4000-8000-000000000000",
  article_title: "Titre de test",
  reviewer: "Relecteur Test",
  reviewed_at: "2026-09-02T10:00:00Z",
  content_sha256: "a".repeat(64),
  note: "Sources verifiees.",
};

beforeEach(() => {
  process.env["MEDIA_SITE_URL"] = "https://exemple.test/media";
});

afterEach(() => {
  delete process.env["MEDIA_SITE_URL"];
});

describe("empreinte canonique", () => {
  it("exclut `generated`, qui change a chaque generation", () => {
    // Sans cette exclusion, l'empreinte varierait sans qu'aucun contenu utile
    // ait bouge, et ne pourrait plus signaler un vrai changement.
    const a = { generated: "2026-09-02T10:00:00Z", donnee: 1 };
    const b = { generated: "2026-09-03T18:30:00Z", donnee: 1 };
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
  });

  it("change des que le contenu change", () => {
    expect(canonicalJsonHash({ donnee: 1 })).not.toBe(canonicalJsonHash({ donnee: 2 }));
  });

  it("est insensible a l'ordre des clefs, a tous les niveaux", () => {
    const a = { x: 1, imbrique: { p: "a", q: [{ m: 1, n: 2 }] } };
    const b = { imbrique: { q: [{ n: 2, m: 1 }], p: "a" }, x: 1 };
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
  });
});

describe("manifeste d'agent", () => {
  const m = () => agentManifest([article()]);

  it("expose l'echelle de preuve du §2 et les types du §3", () => {
    const p = m()["proofPolicy"] as Record<string, unknown>;
    expect(p["claimKinds"]).toEqual(["fait", "estimation", "inférence", "scénario"]);
    expect((p["depthScale"] as unknown[]).length).toBe(5);
    expect((p["publicationFloor"] as Record<string, unknown>)["level"]).toBe(2);
    expect(p["structuralClaimCeiling"]).toBe(3);
  });

  it("declare la relecture humaine comme obligatoire", () => {
    const h = (m()["proofPolicy"] as Record<string, unknown>)["humanReview"] as Record<
      string,
      unknown
    >;
    expect(h["required"]).toBe(true);
    expect(String(h["rule"])).toMatch(/empreinte du contenu relu/);
  });

  it("publie ce qu'il ne faut PAS faire des donnees", () => {
    // Enoncer les interdits est plus utile que lister les permissions : c'est
    // ce qui manque quand un tiers reutilise un corpus de bonne foi.
    const interdits = (m()["prohibitedUse"] as string[]).join(" ");
    expect(interdits).toMatch(/inference ou un scenario en fait observe/);
    expect(interdits).toMatch(/EP-007/);
    expect(interdits).toMatch(/attestation de relecture ne correspond plus/);
  });

  it("declare la limite du controle EP-007", () => {
    // Ne pas laisser croire a une certification de neutralite.
    expect(String(m()["caveat"])).toMatch(/partiellement lexical/);
  });
});

describe("contrat §7 expose", () => {
  it("publie l'article INTEGRAL, pas un resume", () => {
    // Un resume rendrait l'article invérifiable : c'est le contrat complet qui
    // le rend contestable.
    const s = articlesSurface([article()], new Map());
    const a = (s["articles"] as Array<Record<string, unknown>>)[0];
    for (const champ of ["claims", "body", "editorial_notes", "changelog", "published_at"]) {
      expect(a, champ).toHaveProperty(champ);
    }
    const claims = a?.["claims"] as Array<Record<string, unknown>>;
    expect(claims[0]).toHaveProperty("evidence_level");
    expect(claims[0]).toHaveProperty("sources");
  });

  it("joint l'attestation de relecture quand elle existe", () => {
    const s = articlesSurface(
      [article()],
      new Map([["article-00000000-0000-4000-8000-000000000000", REVIEW]]),
    );
    const a = (s["articles"] as Array<Record<string, unknown>>)[0];
    expect(a?.["review"]).toMatchObject({
      reviewer: "Relecteur Test",
      content_sha256: "a".repeat(64),
    });
  });

  it("rend `review: null` en l'absence d'attestation", () => {
    const s = articlesSurface([article()], new Map());
    expect((s["articles"] as Array<Record<string, unknown>>)[0]?.["review"]).toBeNull();
  });
});

describe("surface d'integrite", () => {
  it("documente sa canonicalisation", () => {
    const i = integritySurface([
      { path: "/index.html", mediaType: "text/html", sha256: sha256("x") },
    ]);
    expect(JSON.stringify(i["canonicalization"])).toMatch(/recursivement/);
    expect(String(i["verification"])).toMatch(/republication non declaree/);
  });

  it("prefixe chaque surface de l'URL publique", () => {
    const i = integritySurface([
      { path: "/feed.xml", mediaType: "application/xml", sha256: sha256("x") },
    ]);
    const s = (i["surfaces"] as Array<Record<string, unknown>>)[0];
    expect(s?.["url"]).toBe("https://exemple.test/media/feed.xml");
  });
});

describe("generation complete", () => {
  let workDir: string;
  let outputDir: string;
  let siteDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "surface-"));
    outputDir = join(workDir, "articles");
    siteDir = join(workDir, "public");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(workDir, "protocole.md"), "# Protocole", "utf8");
    await writeFile(
      join(outputDir, `${article().id}.json`),
      JSON.stringify(article({ claims: [claim()] })),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const build = () =>
    buildSite({
      outputDir,
      siteDir,
      protocolPath: join(workDir, "protocole.md"),
      changelogPath: join(workDir, "changelog.md"),
      requireReview: false,
    });

  it("publie les trois surfaces machine", async () => {
    const r = await build();
    expect(r.pages).toContain("agents.json");
    expect(r.pages).toContain("api/articles.json");
    expect(r.pages).toContain("integrity.json");
  });

  it("couvre toutes les pages dans les empreintes, sauf integrity.json", async () => {
    await build();
    const i = JSON.parse(await readFile(join(siteDir, "integrity.json"), "utf8")) as {
      surfaces: Array<{ path: string }>;
    };
    const chemins = i.surfaces.map((s) => s.path);

    expect(chemins).toContain("/index.html");
    expect(chemins).toContain("/agents.json");
    expect(chemins).toContain("/feed.xml");
    // Une surface ne peut pas contenir sa propre empreinte.
    expect(chemins).not.toContain("/integrity.json");
  });

  it("produit des empreintes stables entre deux generations identiques", async () => {
    await build();
    const lire = async () =>
      (
        JSON.parse(await readFile(join(siteDir, "integrity.json"), "utf8")) as {
          surfaces: Array<{ path: string; sha256: string }>;
        }
      ).surfaces.find((s) => s.path === "/api/articles.json")?.sha256;

    const avant = await lire();
    await build();
    expect(await lire()).toBe(avant);
  });
});
