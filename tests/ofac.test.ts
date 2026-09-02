/**
 * Adaptateur OFAC (tier 1, sanctions).
 *
 * Le test le plus important de ce fichier n'est pas fonctionnel : il verifie
 * que l'adaptateur NE PUBLIE PAS les identites designees. Ce pipeline a deja
 * produit, avec de vrais modeles, un chiffre partiel type `fait` et un taux
 * invente. Les memes mecanismes appliques a « X a ete sanctionne » ne
 * produiraient pas une erreur de chiffre mais une imputation nominative fausse.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ofacAdapter } from "../src/sources/ofac.js";

const QUERY = { topic: "sanctions", since: "2026-01-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Delta OFAC reduit, fidele au schema publie. */
const DELTA = `<?xml version="1.0" encoding="utf-8"?>
<sanctionsData xmlns="https://www.treasury.gov/ofac/DeltaFile/1.0">
  <publicationInfo>
    <datePublished>2026-08-28T00:00:00-04:00</datePublished>
    <publicationType>Standard Action</publicationType>
  </publicationInfo>
  <entities>
    <entity id="58482" action="add">
      <generalInfo>
        <entityType refId="600">Individual</entityType>
      </generalInfo>
      <sanctionsPrograms>
        <sanctionsProgram id="64116" refId="91167">IFSR</sanctionsProgram>
        <sanctionsProgram id="64112" refId="211">SDGT</sanctionsProgram>
      </sanctionsPrograms>
      <sanctionsTypes>
        <sanctionsType id="51159" refId="1705">Block</sanctionsType>
      </sanctionsTypes>
      <legalAuthorities>
        <legalAuthority id="50390" refId="1828">Executive Order 13224 (Terrorism)</legalAuthority>
      </legalAuthorities>
      <names>
        <name id="90481"><isPrimary>true</isPrimary>
          <translations><translation><formattedFullName>DUPONT, Jean-Michel</formattedFullName></translation></translations>
        </name>
      </names>
    </entity>
    <entity id="58483" action="remove">
      <generalInfo>
        <entityType refId="601">Entity</entityType>
      </generalInfo>
      <sanctionsPrograms>
        <sanctionsProgram id="1" refId="1">SDGT</sanctionsProgram>
      </sanctionsPrograms>
      <names>
        <name id="2"><isPrimary>true</isPrimary>
          <translations><translation><formattedFullName>SOCIETE ANONYME EXEMPLE</formattedFullName></translation></translations>
        </name>
      </names>
    </entity>
  </entities>
</sanctionsData>`;

function stub(corps: string, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, text: async () => corps })),
  );
}

describe("aucune identite publiee", () => {
  it("ne reprend AUCUN nom present dans le delta", async () => {
    // Une imputation nominative fausse n'est pas une erreur de chiffre, c'est
    // une diffamation. Le resume porte l'action, pas les personnes.
    stub(DELTA);
    const resume = (await ofacAdapter().fetch(QUERY)).observations[0]?.resume ?? "";

    expect(resume).not.toMatch(/DUPONT/);
    expect(resume).not.toMatch(/Jean-Michel/);
    expect(resume).not.toMatch(/SOCIETE ANONYME EXEMPLE/);
  });

  it("dit explicitement ou le lecteur trouve les identites", async () => {
    stub(DELTA);
    const o = (await ofacAdapter().fetch(QUERY)).observations[0];
    expect(o?.resume).toMatch(/identites designees ne sont pas reprises ici/);
    expect(o?.url).toBe("https://ofac.treasury.gov/recent-actions");
  });
});

describe("contenu de l'observation", () => {
  it("compte les entites par type d'action", async () => {
    stub(DELTA);
    const resume = (await ofacAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/2 entite\(s\) modifiee\(s\)/);
    expect(resume).toMatch(/add/);
    expect(resume).toMatch(/remove/);
  });

  it("agrege programmes, mesures et autorites legales", async () => {
    stub(DELTA);
    const resume = (await ofacAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    // SDGT apparait deux fois : le comptage doit le refleter.
    expect(resume).toMatch(/SDGT \(2\)/);
    expect(resume).toMatch(/IFSR/);
    expect(resume).toMatch(/Block/);
    expect(resume).toMatch(/Executive Order 13224/);
  });

  it("distingue individus et entites", async () => {
    stub(DELTA);
    const resume = (await ofacAdapter().fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/Individual/);
    expect(resume).toMatch(/Entity/);
  });

  it("normalise la date de publication en ISO-8601 (§7)", async () => {
    stub(DELTA);
    const o = (await ofacAdapter().fetch(QUERY)).observations[0];
    expect(o?.date_published).toBe("2026-08-28T04:00:00.000Z");
  });

  it("archive le document brut pour l'audit (§9.4)", async () => {
    stub(DELTA);
    const r = await ofacAdapter().fetch(QUERY);
    expect(String(r.raw)).toMatch(/sanctionsData/);
  });
});

describe("echecs", () => {
  it("echoue bruyamment si la structure attendue est absente", async () => {
    // Extraction etroite assumee : mieux vaut echouer que deviner.
    stub("<html><body>maintenance</body></html>");
    await expect(ofacAdapter().fetch(QUERY)).rejects.toThrow(
      /aucune date de publication/,
    );
  });

  it("echoue si la publication ne modifie aucune entite", async () => {
    stub(`<?xml version="1.0"?><sanctionsData>
      <publicationInfo><datePublished>2026-08-28T00:00:00-04:00</datePublished></publicationInfo>
      <entities/></sanctionsData>`);
    await expect(ofacAdapter().fetch(QUERY)).rejects.toThrow(/aucune entite modifiee/);
  });

  it("echoue sur un statut HTTP non OK", async () => {
    stub("", false, 503);
    await expect(ofacAdapter().fetch(QUERY)).rejects.toThrow(/HTTP 503/);
  });
});
