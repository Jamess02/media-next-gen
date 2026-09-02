/**
 * §4 / EP-002 — divulgation d'interet.
 *
 * Ce que ces tests protegent : une source qui a un interet financier dans ce
 * qu'elle commente ne peut PAS etre publiee sans que le lecteur le voie, en
 * gras, dans le corps. La consigne au Redacteur ne suffirait pas — c'est le
 * gate qui doit rendre l'omission impossible, et c'est ce qu'on verifie ici.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { ADAPTIVE_RESPONDERS } from "../src/fixtures/adaptive-responders.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import type { SourceAdapter } from "../src/sources/types.js";
import {
  DECLARED_INTERESTS,
  boldDisclosure,
  disclosureText,
  interestCaveat,
  interestForUrl,
  interestsForUrls,
  isDisclosedInBold,
  mentionsInterest,
} from "../src/protocol/interests.js";
import { runEditorialGate } from "../src/protocol/rules.js";
import { agentManifest, articlesSurface } from "../src/site/agent-surface.js";
import { articlePage } from "../src/site/templates.js";
import { classifySource } from "../src/sources/registry.js";
import { buildSourceCatalogue } from "../src/sources/catalogue.js";
import { article, claim } from "./helpers.js";

const CASTLE = DECLARED_INTERESTS.find((i) => i.domain === "castleisland.vc")!;
const GALAXY = DECLARED_INTERESTS.find((i) => i.domain === "galaxy.com")!;

/** Claim adossee a une primaire ET a la source a interet. */
const claimAvecInteret = (url: string) =>
  claim({
    sources: [
      {
        url: "https://fred.stlouisfed.org/series/TEST",
        tier: 1,
        date_observed: "2026-08-27T09:00:00Z",
        date_published: "2026-08-12T14:00:00Z",
      },
      {
        url,
        tier: 3,
        date_observed: "2026-08-27T09:00:00Z",
        date_published: "2026-08-20T14:00:00Z",
      },
    ],
  });

const rule = (a: Parameters<typeof runEditorialGate>[0]) =>
  runEditorialGate(a).violations.filter((v) => v.rule === "INTEREST_UNDISCLOSED");

describe("reconnaissance de la source", () => {
  it("reconnait le domaine et ses sous-domaines", () => {
    expect(interestForUrl("https://castleisland.vc/feed/")?.name).toBe(
      "Castle Island Ventures",
    );
    expect(interestForUrl("https://www.galaxy.com/insights/x")?.name).toBe(
      "Galaxy Digital",
    );
  });

  it("ne reconnait pas un domaine qui se contente de finir pareil", () => {
    // "notcastleisland.vc" n'est pas un sous-domaine de "castleisland.vc".
    expect(interestForUrl("https://notcastleisland.vc/a")).toBeNull();
  });

  it("rend null sur une source ordinaire ou une URL invalide", () => {
    expect(interestForUrl("https://fred.stlouisfed.org/series/X")).toBeNull();
    expect(interestForUrl("pas une url")).toBeNull();
  });

  it("dedoublonne un lot d'URLs", () => {
    const found = interestsForUrls([
      "https://castleisland.vc/a",
      "https://castleisland.vc/b",
      "https://fred.stlouisfed.org/c",
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.domain).toBe("castleisland.vc");
  });
});

describe("detection du gras", () => {
  it("accepte la mention exacte en gras", () => {
    expect(isDisclosedInBold(`Texte. ${boldDisclosure(CASTLE)} Suite.`, CASTLE)).toBe(
      true,
    );
  });

  it("accepte une phrase en gras plus longue qui la contient", () => {
    const corps = `**A noter : ${disclosureText(CASTLE)} Le lecteur en tiendra compte.**`;
    expect(isDisclosedInBold(corps, CASTLE)).toBe(true);
  });

  it("tolere les accents et la casse, qui ne changent pas le fond", () => {
    // Bloquer sur un accent transformerait une garantie editoriale en concours
    // de dictee — et la premiere reaction serait de desactiver la regle.
    const corps = `**DIVULGATION D'INTÉRÊT — Castle Island Ventures : fonds de capital-risque investi dans les entreprises du secteur qu'il commente.**`;
    expect(isDisclosedInBold(corps, CASTLE)).toBe(true);
  });

  it("REFUSE la mention presente mais pas en gras", () => {
    expect(isDisclosedInBold(`Texte. ${disclosureText(CASTLE)}`, CASTLE)).toBe(false);
  });

  it("REFUSE une mention coupee entre deux passages en gras", () => {
    // La repartir, c'est la diluer : exactement ce que la regle empeche.
    expect(
      isDisclosedInBold(
        "**Divulgation d'interet — Castle Island Ventures :** un **fonds de capital-risque**.",
        CASTLE,
      ),
    ).toBe(false);
  });

  it("nomme la source sous ses differentes formes", () => {
    expect(mentionsInterest("selon Castle Island, le marche...", CASTLE)).toBe(true);
    expect(mentionsInterest("d'apres Galaxy Research", GALAXY)).toBe(true);
    expect(mentionsInterest("la galaxie d'Andromede", GALAXY)).toBe(false);
  });
});

describe("regle bloquante INTEREST_UNDISCLOSED", () => {
  it("bloque une claim qui cite la source sans divulgation", () => {
    const v = rule(article({ claims: [claimAvecInteret("https://castleisland.vc/x")] }));
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("blocking");
    expect(v[0]?.clause).toBe("§4 / EP-002");
  });

  it("laisse passer des que la mention est en gras dans le corps", () => {
    const c = claimAvecInteret("https://castleisland.vc/x");
    const a = article({
      claims: [c],
      body: `Le fonds avance ceci [[${c.id}]]. ${boldDisclosure(CASTLE)}`,
    });
    expect(rule(a)).toHaveLength(0);
    expect(runEditorialGate(a).passed).toBe(true);
  });

  it("bloque quand la source est NOMMEE sans etre liee", () => {
    // Reprendre un chiffre « selon Galaxy » est un usage au meme titre : la
    // seule inspection des URLs le laisserait passer.
    const v = rule(
      article({ body: "Selon Galaxy Digital, le marche se contracte. [[claim-1]]" }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("Galaxy Digital");
  });

  it("bloque quand la source est nommee dans le titre", () => {
    expect(rule(article({ title: "Ce que dit Castle Island" }))).toHaveLength(1);
  });

  it("bloque quand la source est nommee dans le texte d'une claim", () => {
    expect(
      rule(article({ claims: [claim({ text: "Castle Island decrit un marche atone." })] })),
    ).toHaveLength(1);
  });

  it("exige une divulgation par source concernee", () => {
    const a = article({
      claims: [claimAvecInteret("https://castleisland.vc/x")],
      body: "Repris aussi par Galaxy Digital. [[claim-1]]",
    });
    expect(rule(a)).toHaveLength(2);
  });

  it("ne dit rien d'un article sans source a interet", () => {
    expect(rule(article())).toHaveLength(0);
  });

  it("donne la chaine exacte a inserer, gras compris", () => {
    // Le message n'est pas qu'un diagnostic : il porte le remede litteral, pour
    // que la correction ne soit pas une devinette de formulation.
    const v = rule(article({ claims: [claimAvecInteret("https://castleisland.vc/x")] }));
    expect(v[0]?.message).toContain(boldDisclosure(CASTLE));
  });
});

describe("cablage du catalogue", () => {
  it("classe les deux sources en tier 3 : l'interet n'est pas le tier", () => {
    expect(classifySource("https://castleisland.vc/a").tier).toBe(3);
    expect(classifySource("https://www.galaxy.com/a").tier).toBe(3);
  });

  it("classe la Reserve federale en tier 1", () => {
    expect(
      classifySource("https://www.federalreserve.gov/newsevents/pressreleases/a.htm").tier,
    ).toBe(1);
  });

  it("branche Castle Island avec sa mention d'interet des la collecte", () => {
    // La mention doit voyager avec l'observation : l'Analyste voit l'interet
    // avant de typer, pas seulement le Redacteur au moment d'ecrire.
    const { adapters } = buildSourceCatalogue({});
    const found = adapters.find((a) => a.id === "castleisland:feed");
    expect(found).toBeDefined();
    expect(interestCaveat(CASTLE)).toContain(disclosureText(CASTLE));
    expect(interestCaveat(CASTLE)).toMatch(/en gras/);
  });

  it("branche le fil de communiques de la Fed", () => {
    const { adapters } = buildSourceCatalogue({});
    expect(adapters.map((a) => a.id)).toContain("fed:press");
  });

  it("documente Galaxy comme ecartee, faute de flux", () => {
    const { skipped } = buildSourceCatalogue({});
    const g = skipped.find((s) => s.id === "galaxy:research");
    expect(g?.reason).toMatch(/404/);
    // L'interet reste declare meme sans adaptateur : une URL galaxy.com qui
    // atteindrait une claim par un autre chemin resterait couverte.
    expect(interestForUrl("https://www.galaxy.com/x")).not.toBeNull();
  });

  it("ajoute le bilan de la Fed quand la clef FRED est fournie", () => {
    const avec = buildSourceCatalogue({ FRED_API_KEY: "test" });
    expect(avec.adapters.map((a) => a.id)).toContain("fred:WALCL");
    const sans = buildSourceCatalogue({});
    expect(sans.adapters.map((a) => a.id)).not.toContain("fred:WALCL");
    expect(sans.skipped.map((s) => s.id)).toContain("fred:FEDFUNDS+WALCL");
  });
});

/* -------------------------------------------------------------------------
 * Bout en bout — la seule preuve qui compte
 *
 * Les tests unitaires montrent que la regle sait dire non. Ceux-ci montrent que
 * le pipeline s'y soumet : un Redacteur qui omet la mention ne publie pas, et
 * l'omission remonte a l'appelant avec le motif.
 * ---------------------------------------------------------------------- */

/** Adaptateur ne rendant qu'une observation Castle Island (tier 3 au registre). */
const castleIslandAdapter: SourceAdapter = {
  id: "castleisland:test",
  describes: "Note hebdomadaire (test)",
  async fetch() {
    return {
      requestedUrl: "https://castleisland.vc/feed/",
      raw: { __test: true },
      observations: [
        {
          source: "Castle Island Ventures",
          url: "https://castleisland.vc/note-de-test/",
          date_observed: "2026-09-02T09:00:00Z",
          date_published: "2026-09-01T10:00:00Z",
          type: "commentaire-acteur-du-marche",
          resume: `Le fonds decrit une contraction des volumes. ${interestCaveat(CASTLE)}`,
        },
      ],
    };
  },
};

/** Le Veilleur adaptatif ecarte tout tier 3 : ici on le force a retenir. */
const veilleurRetenant: MockResponder = () => ({
  retained: [
    {
      url: "https://castleisland.vc/note-de-test/",
      selection_reason:
        "Retenue pour le test : aucune source primaire ne documente ce segment.",
    },
  ],
  set_aside: [],
  freshness_assessment: "Publication du 2026-09-01, dans la fenetre utile.",
  primary_source_available: false,
});

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "media-interets-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runAvecRedacteur(redacteur: MockResponder) {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  const pipeline = new EditorialPipeline({
    ctx: {
      llm: new MockLlmClient({
        audit,
        responders: {
          ...ADAPTIVE_RESPONDERS,
          veilleur: veilleurRetenant,
          redacteur,
        },
      }),
      audit,
    },
    adapters: [castleIslandAdapter],
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(join(workDir, "changelog-editorial.md")),
    ),
  });
  return pipeline.run("actifs numeriques");
}

describe("pipeline — une source a interet ne passe pas sans sa mention", () => {
  it("ARRETE la publication quand le Redacteur omet la divulgation", async () => {
    const omettant: MockResponder = (request) => {
      const p = JSON.parse(request.user) as {
        claims_validees_immuables: Array<{ id: string; text: string }>;
      };
      return {
        title: "Contraction des volumes",
        body: p.claims_validees_immuables
          .map((c) => `${c.text} [[${c.id}]]`)
          .join("\n"),
        uncertainty_flags: [],
      };
    };

    const result = await runAvecRedacteur(omettant);
    expect(result.status).toBe("halted");
    if (result.status !== "halted") return;
    expect(result.stage).toBe("publication");
    expect(result.details.join(" ")).toMatch(/INTEREST_UNDISCLOSED/);
    expect(result.details.join(" ")).toContain("Castle Island Ventures");
  });

  it("publie des que la mention est reproduite en gras", async () => {
    const result = await runAvecRedacteur(ADAPTIVE_RESPONDERS["redacteur"]!);
    expect(result.status).toBe("published");
    if (result.status !== "published") return;

    // Dans le corps, la ou le lecteur lit l'affirmation.
    expect(isDisclosedInBold(result.article.body, CASTLE)).toBe(true);
    // Et dans le bandeau d'incertitudes, pose par le pipeline lui-meme : celle-
    // la ne depend d'aucun modele. Sans gras : ce champ est rendu en texte
    // echappe, les asterisques s'y afficheraient telles quelles.
    expect(result.article.editorial_notes.uncertainty_flags).toContain(
      disclosureText(CASTLE),
    );
    expect(result.article.editorial_notes.uncertainty_flags.join(" ")).not.toContain(
      "**",
    );
  });

  it("rend un bloc de divulgation en tete de la page publiee", async () => {
    // Le bloc est reconstruit depuis le registre : un article produit par une
    // version anterieure du pipeline le recevrait quand meme.
    const result = await runAvecRedacteur(ADAPTIVE_RESPONDERS["redacteur"]!);
    if (result.status !== "published") throw new Error("attendu : publie");

    const html = articlePage(result.article);
    expect(html).toMatch(/class="divulgation"/);
    expect(html).toMatch(/divulgation d'interet/i);
    expect(html).toContain("Castle Island Ventures");
    // Avant le corps : la mention change la facon de lire ce qui suit.
    expect(html.indexOf('class="divulgation"')).toBeLessThan(
      html.indexOf('class="corps"'),
    );
  });

  it("n'ajoute aucun bloc de divulgation sur un article ordinaire", () => {
    expect(articlePage(article())).not.toMatch(/class="divulgation"/);
  });

  it("transmet la divulgation aux agents tiers, pas seulement aux humains", () => {
    // Sans cela elle se perdrait a la premiere reutilisation : un agent qui
    // reprend la claim ne verrait qu'un tier 3 ordinaire.
    const manifeste = JSON.stringify(agentManifest([]));
    expect(manifeste).toContain("Castle Island Ventures");
    expect(manifeste).toContain("galaxy.com");
    expect(manifeste).toMatch(/en supprimant la divulgation/);

    const a = article({ claims: [claimAvecInteret("https://castleisland.vc/x")] });
    const surface = articlesSurface([a], new Map()) as {
      articles: Array<{ declared_interests: Array<{ name: string }> }>;
    };
    expect(surface.articles[0]?.declared_interests).toEqual([
      {
        name: "Castle Island Ventures",
        domain: "castleisland.vc",
        disclosure: disclosureText(CASTLE),
      },
    ]);
  });

  it("ne reclame rien quand aucune source a interet n'est retenue", async () => {
    // Garde-fou contre une regle trop large : elle ne doit pas se declencher
    // sur un article ordinaire, sinon elle finirait desactivee.
    const sansInteret: SourceAdapter = {
      id: "fred:test",
      describes: "Serie de test",
      async fetch() {
        return {
          requestedUrl: "https://fred.stlouisfed.org/series/TEST",
          raw: {},
          observations: [
            {
              source: "FRED",
              url: "https://fred.stlouisfed.org/series/TEST",
              date_observed: "2026-09-02T09:00:00Z",
              date_published: "2026-09-01T10:00:00Z",
              type: "donnee-macro",
              resume: "Le total de l'actif s'etablit a 6 730 912 millions de dollars.",
            },
          ],
        };
      },
    };

    const audit = new AuditLog({ dir: join(workDir, "audit") });
    const result = await new EditorialPipeline({
      ctx: { llm: new MockLlmClient({ audit, responders: ADAPTIVE_RESPONDERS }), audit },
      adapters: [sansInteret],
      editeur: new Editeur(
        join(workDir, "output"),
        new EditorialChangelog(join(workDir, "changelog-editorial.md")),
      ),
    }).run("bilan de la reserve federale");

    expect(result.status).toBe("published");
    if (result.status !== "published") return;
    expect(result.article.body).not.toMatch(/Divulgation d'interet/i);
  });
});
