/**
 * Tableau comparatif — les chiffres traites, classes par ordre decroissant.
 *
 * Ecrits AVANT le code (TDD).
 *
 * LE PIEGE, ET IL EST LE MEME QUE PARTOUT DANS CE PROJET. Un tableau ecrit par
 * le Redacteur serait un tableau invente : ce modele a deja produit un « niveau
 * le plus eleve depuis 2008 » que rien n'etablissait, et un « 6 737 204
 * (unites) » sans unite. Lui demander d'aligner des chiffres dans le bon ordre
 * ajouterait deux facons de se tromper — la valeur et le rang — a une sortie
 * qui a la forme de la rigueur.
 *
 * Le tableau est donc DERIVE des claims par du code : la valeur vient d'un
 * champ structure et verifie, le tri est fait par `sort`, et le modele n'a
 * aucun moyen d'influer sur l'ordre.
 *
 * EP-006 GOUVERNE LE RESTE. Aligner deux nombres dans un tableau AFFIRME leur
 * comparabilite. « PIB mondial 2,92 % » et « PIB francais 0,9 % » viennent de
 * deux institutions, avec deux methodes, et l'un est une estimation. Le
 * tableau doit donc porter la source, le type et le niveau de preuve de chaque
 * ligne — sinon il transforme une juxtaposition en classement.
 *
 * Et ranger des unites differentes n'est pas un classement, c'est une erreur :
 * 6 737 204 millions de dollars ne « bat » pas 2,92 %.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { ADAPTIVE_RESPONDERS } from "../src/fixtures/adaptive-responders.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import type { SourceAdapter } from "../src/sources/types.js";

import { Editeur, renderArticle } from "../src/agents/editeur.js";
import { rankedFigures } from "../src/protocol/figures.js";
import {
  detectUngroundedStructuredFigures,
  runEditorialGate,
} from "../src/protocol/rules.js";
import { articlePage } from "../src/site/templates.js";
import { PROSE_MINIMALE, article, claim } from "./helpers.js";

const source = (url: string) => ({
  url,
  tier: 1 as const,
  date_observed: "2026-09-09T09:00:00Z",
  date_published: "2026-09-08T10:00:00Z",
});

const avecChiffre = (
  id: string,
  label: string,
  value: number,
  extra: Record<string, unknown> = {},
) =>
  claim({
    id,
    text: `${label} : ${value} % en 2025.`,
    sources: [source(`https://exemple.test/${id}`)],
    figure: { label, value, unit: "%", as_of: "2025" },
    ...extra,
  });

const troisChiffres = () =>
  article({
    claims: [
      avecChiffre("claim-1", "PIB mondial", 2.92),
      avecChiffre("claim-2", "PIB francais", 0.9, { type: "estimation" as const }),
      avecChiffre("claim-3", "Inflation zone euro", 2.47),
    ],
    body: `Trois mesures [[claim-1]] [[claim-2]] [[claim-3]].${PROSE_MINIMALE}`,
  });

describe("classement decroissant, fait par du code", () => {
  it("ordonne les chiffres du plus grand au plus petit", () => {
    const rangs = rankedFigures(troisChiffres()).map((f) => f.value);
    expect(rangs).toEqual([2.92, 2.47, 0.9]);
  });

  it("ne depend PAS de l'ordre des claims", () => {
    // Le modele decide de l'ordre des claims ; il ne doit pas decider du rang.
    const a = troisChiffres();
    const inverse = article({ ...a, claims: [...a.claims].reverse() });
    expect(rankedFigures(inverse).map((f) => f.value)).toEqual([2.92, 2.47, 0.9]);
  });

  it("rattache chaque ligne a sa claim, son type et son niveau de preuve", () => {
    // Sans ces colonnes, le tableau juxtapose une donnee observee et une
    // estimation comme si elles avaient le meme statut.
    const ligne = rankedFigures(troisChiffres()).find(
      (f) => f.label === "PIB francais",
    );
    expect(ligne?.claimId).toBe("claim-2");
    expect(ligne?.type).toBe("estimation");
    expect(ligne?.evidenceLevel).toBe(3);
    expect(ligne?.sources[0]).toContain("exemple.test");
  });

  it("ignore les claims sans chiffre structure", () => {
    const a = article({
      claims: [avecChiffre("claim-1", "PIB mondial", 2.92), claim({ id: "claim-2" })],
      body: `Deux affirmations [[claim-1]] [[claim-2]].${PROSE_MINIMALE}`,
    });
    expect(rankedFigures(a)).toHaveLength(1);
  });

  it("ne rend AUCUN tableau sous deux chiffres : un classement d'un element n'en est pas un", () => {
    const a = article({
      claims: [avecChiffre("claim-1", "PIB mondial", 2.92)],
      body: `Une mesure [[claim-1]].${PROSE_MINIMALE}`,
    });
    expect(rankedFigures(a)).toHaveLength(1);
    expect(renderArticle(a)).not.toMatch(/\| *rang/i);
  });
});

describe("EP-006 — on ne range pas des unites differentes", () => {
  it("BLOQUE un article dont les chiffres n'ont pas la meme unite", () => {
    // 6 737 204 millions de dollars ne « bat » pas 2,92 %. Les aligner dans un
    // tableau affirmerait une comparabilite qui n'existe pas.
    const a = article({
      claims: [
        avecChiffre("claim-1", "PIB mondial", 2.92),
        claim({
          id: "claim-2",
          text: "Bilan de la Fed.",
          sources: [source("https://exemple.test/2")],
          figure: {
            label: "Actif total",
            value: 6737204,
            unit: "millions de dollars",
            as_of: "2026-09-02",
          },
        }),
      ],
      body: `Deux mesures [[claim-1]] [[claim-2]].${PROSE_MINIMALE}`,
    });

    const v = runEditorialGate(a).violations.find(
      (x) => x.rule === "FIGURE_UNIT_MISMATCH",
    );
    expect(v?.severity).toBe("blocking");
    expect(v?.message).toMatch(/unit/i);
  });

  it("laisse passer des chiffres de meme unite", () => {
    expect(runEditorialGate(troisChiffres()).passed).toBe(true);
  });

  it("laisse passer un article sans aucun chiffre structure", () => {
    expect(runEditorialGate(article()).passed).toBe(true);
  });
});

describe("un tableau ecrit a la main est signale", () => {
  it("avertit et renvoie vers le champ structure", () => {
    // Le rendu du site ne connait pas les tableaux markdown : ils sortiraient
    // en texte litteral. Et surtout, un tableau redige echappe au tri et a la
    // verification.
    const a = article({
      body:
        `| Pays | Croissance |\n| --- | --- |\n| Monde | 2,92 % |\n` +
        `| France | 0,9 % |\n\nSuite du texte [[claim-1]].`,
    });
    const v = runEditorialGate(a).violations.find(
      (x) => x.rule === "HANDWRITTEN_TABLE",
    );
    expect(v?.severity).toBe("warning");
    expect(v?.message).toMatch(/figure/i);
  });

  it("ne confond pas une barre verticale ordinaire avec un tableau", () => {
    const a = article({ body: `Un texte avec une barre | isolee [[claim-1]].` });
    expect(
      runEditorialGate(a).violations.map((v) => v.rule),
    ).not.toContain("HANDWRITTEN_TABLE");
  });
});

describe("§2 — le chiffre publie doit venir de la source", () => {
  it("signale une valeur absente des observations retenues", () => {
    // Le tableau est l element le plus autoritaire de la page : un chiffre
    // faux y pese plus lourd que dans une phrase, parce qu il a la forme
    // d une donnee verifiee.
    const v = detectUngroundedStructuredFigures(
      troisChiffres().claims,
      ["Le PIB mondial a cru de 2,92 % et l inflation atteint 2,47 %."],
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("0.9");
    expect(v[0]?.severity).toBe("warning");
  });

  it("ne dit rien quand toutes les valeurs figurent dans les sources", () => {
    expect(
      detectUngroundedStructuredFigures(troisChiffres().claims, [
        "PIB mondial 2,92 %, PIB francais 0,9 %, inflation 2,47 %.",
      ]),
    ).toHaveLength(0);
  });

  it("accepte l arrondi a la precision annoncee", () => {
    // "2,92" tire de 2.9183 est une reprise honnete, pas une invention.
    expect(
      detectUngroundedStructuredFigures(troisChiffres().claims, [
        "Croissance 2.9183, France 0.904, inflation 2.4712.",
      ]),
    ).toHaveLength(0);
  });

  it("se tait faute de materiau source, au lieu de tout signaler", () => {
    expect(detectUngroundedStructuredFigures(troisChiffres().claims, [])).toHaveLength(0);
  });
});
describe("rendu", () => {
  it("le markdown publie porte le tableau, dans l'ordre decroissant", () => {
    const md = renderArticle(troisChiffres());
    const table = md.slice(md.indexOf("PIB mondial"));
    expect(table.indexOf("PIB mondial")).toBeLessThan(table.indexOf("Inflation"));
    expect(table.indexOf("Inflation")).toBeLessThan(table.indexOf("PIB francais"));
  });

  it("le markdown affiche l'unite et la periode", () => {
    const md = renderArticle(troisChiffres());
    expect(md).toContain("2,92");
    expect(md).toContain("%");
    expect(md).toContain("2025");
  });

  it("la page HTML rend un vrai tableau accessible", () => {
    const html = articlePage(troisChiffres());
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<caption>/);
    expect(html).toMatch(/scope="col"/);
  });

  it("la page HTML montre le statut de chaque ligne", () => {
    // Une estimation et un fait ne se lisent pas de la meme facon : le tableau
    // doit le dire, sinon il les egalise.
    const html = articlePage(troisChiffres());
    expect(html).toContain("estimation");
    expect(html).toMatch(/preuve 3\/4/);
  });

  it("aucun tableau quand l'article ne porte pas de chiffres", () => {
    expect(articlePage(article())).not.toMatch(/<table/);
  });
});

/* -------------------------------------------------------------------------
 * Bout en bout — le chemin que le chiffre doit reellement parcourir
 *
 * Ce test manquait, et son absence a coute une execution reelle : le champ
 * `figure` etait dans le contrat §7 et dans les deux rendus, mais ni dans le
 * schema de sortie de l'Analyste — le modele ne POUVAIT donc pas l'emettre —
 * ni dans la reconstruction des claims par le fact-checker, qui les rebatit
 * champ par champ et laissait celui-la de cote.
 *
 * Deux maillons silencieux sur un chemin de cinq. Verifier les extremites ne
 * suffit pas quand la chaine recopie ses maillons.
 * ---------------------------------------------------------------------- */

describe("le chiffre survit a toute la chaine", () => {
  it("de l'Analyste jusqu'au markdown publie", async () => {
    const dossier = await mkdtemp(join(tmpdir(), "media-tableau-"));
    try {
      const audit = new AuditLog({ dir: join(dossier, "audit") });
      const adaptateur: SourceAdapter = {
        id: "test:mesures",
        describes: "Deux mesures",
        async fetch() {
          return {
            requestedUrl: "https://fred.stlouisfed.org/series/TEST",
            raw: {},
            observations: [
              {
                source: "FRED",
                url: "https://fred.stlouisfed.org/series/TEST",
                date_observed: "2026-09-09T09:00:00Z",
                date_published: "2026-09-08T10:00:00Z",
                type: "donnee-macro",
                resume: "Croissance mondiale 2,92 % et croissance francaise 0,9 % en 2025.",
              },
            ],
          };
        },
      };

      const analysteChiffre: MockResponder = (request) => {
        const p = JSON.parse(request.user) as {
          observations_retenues: Array<{
            url: string;
            tier: number;
            date_observed: string;
            date_published: string | null;
          }>;
        };
        const e = p.observations_retenues[0]!;
        const src = [
          {
            url: e.url,
            tier: e.tier,
            date_observed: e.date_observed,
            date_published: e.date_published,
          },
        ];
        return {
          candidates: [
            {
              id: "claim-1",
              type: "fait",
              text: "La croissance mondiale atteint 2,92 % en 2025.",
              proposed_evidence_level: 2,
              rationale: "Valeur publiee par la source.",
              sources: src,
              figure: { label: "PIB mondial", value: 2.92, unit: "%", as_of: "2025" },
            },
            {
              id: "claim-2",
              type: "fait",
              text: "La croissance francaise atteint 0,9 % en 2025.",
              proposed_evidence_level: 2,
              rationale: "Valeur publiee par la source.",
              sources: src,
              figure: { label: "PIB francais", value: 0.9, unit: "%", as_of: "2025" },
            },
          ],
          narrative_vs_data: "Aucune source secondaire retenue.",
          publication_caveats: [],
        };
      };

      const r = await new EditorialPipeline({
        ctx: {
          llm: new MockLlmClient({
            audit,
            responders: { ...ADAPTIVE_RESPONDERS, analyste: analysteChiffre },
          }),
          audit,
        },
        adapters: [adaptateur],
        editeur: new Editeur(
          join(dossier, "output"),
          new EditorialChangelog(join(dossier, "changelog.md")),
        ),
      }).run("croissance");

      expect(r.status).toBe("published");
      if (r.status !== "published") return;

      // 1. Le champ a traverse le fact-checker, qui rebatit les claims.
      expect(r.article.claims[0]?.figure?.value).toBe(2.92);
      expect(r.article.claims[1]?.figure?.value).toBe(0.9);

      // 2. Le tableau est dans le markdown, classe decroissant.
      const md = await readFile(r.markdownPath, "utf8");
      expect(md).toContain("Chiffres traites");
      expect(md.indexOf("PIB mondial")).toBeLessThan(md.indexOf("PIB francais"));
    } finally {
      await rm(dossier, { recursive: true, force: true });
    }
  });
});
