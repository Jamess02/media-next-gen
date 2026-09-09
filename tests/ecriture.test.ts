/**
 * §5.3 — le corps doit etre REDIGE, et §3 — un scenario porte sa condition.
 *
 * Ces tests protegent quatre constats faits en production, pas des hypotheses :
 *
 *  - des corps de 107 a 137 mots ;
 *  - des corps entierement constitues du texte des claims colle sous ses
 *    propres references ;
 *  - deux articles sur cinq rediges en anglais, parce que les sources l'etaient ;
 *  - des claims decrivant le jeu de donnees ("la serie couvre 4 observations")
 *    au lieu de ce qu'il mesure.
 *
 * Chacun passait tous les controles existants. Le §7 etait respecte a la
 * lettre, et personne n'avait redige.
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
import {
  MAX_VERBATIM_CLAIM_SHARE,
  MIN_BODY_WORDS,
  PROSPECTIVE_DISCLAIMER,
} from "../src/protocol/constants.js";
import { runEditorialGate } from "../src/protocol/rules.js";
import type { SourceAdapter } from "../src/sources/types.js";
import { PROSE_MINIMALE, article, claim } from "./helpers.js";

const rules = (a: Parameters<typeof runEditorialGate>[0]) =>
  runEditorialGate(a).violations;
const ruleNames = (a: Parameters<typeof runEditorialGate>[0]) =>
  rules(a).map((v) => v.rule);

describe("§5.3 — plancher de longueur", () => {
  it("bloque un corps trop court", () => {
    const v = rules(article({ body: "Un constat. [[claim-1]]" })).find(
      (x) => x.rule === "BODY_TOO_THIN",
    );
    expect(v?.severity).toBe("blocking");
    expect(v?.message).toContain(String(MIN_BODY_WORDS));
  });

  it("ne compte pas les references de claims comme de la prose", () => {
    // Sinon il suffirait d'empiler [[claim-1]] pour franchir le plancher.
    const bourrage = Array.from({ length: 300 }, () => "[[claim-1]]").join(" ");
    expect(ruleNames(article({ body: bourrage }))).toContain("BODY_TOO_THIN");
  });

  it("laisse passer un corps redige", () => {
    expect(ruleNames(article())).not.toContain("BODY_TOO_THIN");
  });
});

describe("§5.3 — le corps n'est pas un collage de claims", () => {
  it("bloque un corps qui recopie le texte des claims", () => {
    // C'est LA forme exacte produite en production : la reference, puis la
    // claim mot pour mot, et rien d'autre.
    const c = claim();
    const colle = Array.from({ length: 6 }, () => `[[${c.id}]] ${c.text}`).join("\n\n");
    const v = rules(article({ claims: [c], body: colle })).find(
      (x) => x.rule === "BODY_IS_CLAIM_PASTE",
    );
    expect(v?.severity).toBe("blocking");
    expect(v?.message).toContain(String(Math.round(MAX_VERBATIM_CLAIM_SHARE * 100)));
  });

  it("tolere une citation de claim noyee dans un texte redige", () => {
    // Citer la preuve est legitime. C'est l'article REDUIT a ses claims qui ne
    // l'est pas — d'ou un ratio et non une interdiction.
    const c = claim();
    const a = article({
      claims: [c],
      body: `Voici ce qui est etabli : « ${c.text} » [[${c.id}]].${PROSE_MINIMALE}`,
    });
    expect(ruleNames(a)).not.toContain("BODY_IS_CLAIM_PASTE");
    expect(runEditorialGate(a).passed).toBe(true);
  });
});

describe("§5.3 — langue de redaction", () => {
  it("bloque une claim recopiee dans la langue de la source", () => {
    const anglais = claim({
      text:
        "OFAC added 36 entities to its sanctions list on 2026-09-08, and the " +
        "designations that were announced are subject to a blocking measure.",
    });
    const v = rules(article({ claims: [anglais] })).find(
      (x) => x.rule === "REDACTION_NOT_FRENCH",
    );
    expect(v?.severity).toBe("blocking");
    expect(v?.path).toBe("claims[0].text");
  });

  it("bloque un corps redige en anglais", () => {
    const corps = [
      "This article reports on the data that was published by the institutions",
      "that are listed below, and on what these figures do not tell us. The",
      "series that is used here has been revised, which is why the dates that",
      "are shown matter as much as the values that they carry. There are limits",
      "to what these numbers can support, and they are stated in the notes that",
      "follow. [[claim-1]] The sources that are cited have been checked, but they",
      "have not been cross-referenced with other providers, which would be a",
      "different exercise from the one that is presented here today.",
    ].join(" ");
    expect(ruleNames(article({ body: corps }))).toContain("REDACTION_NOT_FRENCH");
  });

  it("laisse passer du francais qui cite un titre anglais", () => {
    // Citer une source anglophone est legitime : la regle mesure une DENSITE,
    // pas une presence. Sans cela elle deviendrait une interdiction de citer.
    const a = article({
      body:
        `La serie « Assets: Total Assets » publiee par la Reserve federale sert ` +
        `de reference a cette lecture [[claim-1]].${PROSE_MINIMALE}`,
    });
    expect(ruleNames(a)).not.toContain("REDACTION_NOT_FRENCH");
  });

  it("ne se prononce pas sur un texte trop court pour etre mesure", () => {
    // Un titre de trois mots dont un est "the" afficherait 33 % : la densite
    // n'a pas de sens a cette echelle.
    expect(ruleNames(article({ title: "The Fed" }))).not.toContain(
      "REDACTION_NOT_FRENCH",
    );
  });
});

describe("§3 — un scenario porte sa condition", () => {
  const scenario = (text: string) =>
    claim({ id: "claim-1", type: "scénario", text, evidence_level: 2 });

  it("bloque un scenario sans condition : c'est une prevision", () => {
    const v = rules(
      article({
        claims: [scenario("La croissance ralentira au troisieme trimestre 2026.")],
      }),
    ).find((x) => x.rule === "SCENARIO_WITHOUT_CONDITION");
    expect(v?.severity).toBe("blocking");
  });

  it("accepte les differentes formes de conditionnalite", () => {
    for (const texte of [
      "Si le taux directeur reste au-dessus de 4 %, le cout du refinancement augmenterait.",
      "Tant que la serie reste incomplete, aucun solde annuel ne pourra etre etabli.",
      "A condition que les huit declarants manquants publient, le solde serait revise.",
      "En cas de revision a la baisse, la lecture presentee ici tomberait.",
    ]) {
      expect(ruleNames(article({ claims: [scenario(texte)] }))).not.toContain(
        "SCENARIO_WITHOUT_CONDITION",
      );
    }
  });

  it("ne s'applique qu'au type scénario", () => {
    expect(
      ruleNames(
        article({ claims: [claim({ text: "La croissance a ralenti en 2025." })] }),
      ),
    ).not.toContain("SCENARIO_WITHOUT_CONDITION");
  });
});

describe("superlatifs non soutenus", () => {
  it("signale un record que les claims n'etablissent pas", () => {
    // Phrase reellement produite : « le niveau de son bilan le plus eleve
    // depuis la crise financiere de 2008 ». Aucune claim ne comparait quoi que
    // ce soit a 2008 — c'est la phrase la plus memorable de l'article et la
    // seule adossee a rien.
    const a = article({
      body:
        `La Reserve federale affiche le niveau le plus eleve depuis la crise de ` +
        `2008 [[claim-1]].${PROSE_MINIMALE}`,
    });
    const v = rules(a).find((x) => x.rule === "UNSOURCED_SUPERLATIVE");
    expect(v?.severity).toBe("warning");
    expect(runEditorialGate(a).passed).toBe(true);
  });

  it("se tait quand une claim porte elle-meme le superlatif", () => {
    // Un emetteur annonce parfois lui-meme son record : la formulation est
    // alors sourcee, et la signaler serait du bruit.
    const a = article({
      claims: [
        claim({ text: "L'actif atteint son niveau record de 6 737 204 millions de dollars." }),
      ],
      body: `Le bilan atteint un niveau record [[claim-1]].${PROSE_MINIMALE}`,
    });
    expect(ruleNames(a)).not.toContain("UNSOURCED_SUPERLATIVE");
  });
});

describe("§5.4 — affirmations du corps non soutenues par les claims", () => {
  const chef = (passages: string[]): MockResponder => () => ({
    verdict: "publier",
    justification: "RAS.",
    implicit_recommendations: [],
    unsupported_assertions: passages,
    angle_issues: [],
    suggested_split: [],
  });

  it("REMONTE les passages au relecteur sans bloquer la publication", async () => {
    // Ce champ a d'abord ete un veto. Seize executions reelles plus tard :
    // zero article publie, et une bonne moitie des motifs visait des enonces
    // d'ABSENCE que le brief de redaction exige. Le modele ne tient pas la
    // distinction, donc le signal n'a pas force de loi — il va au relecteur.
    const r = await run("constat", {
      "redacteur-en-chef": chef([
        "le niveau le plus eleve depuis la crise financiere de 2008",
        "ce rapport mensuel de la Fed",
      ]),
    });

    expect(r.status).toBe("published");
    if (r.status !== "published") return;

    const signales = r.warnings.filter((w) => w.rule === "UNSUPPORTED_ASSERTION");
    expect(signales).toHaveLength(2);
    expect(signales[0]?.severity).toBe("warning");
    // Le passage litteral doit atteindre le relecteur : le resumer reviendrait
    // a lui demander de chercher dans le texte ce qu'on a deja trouve.
    expect(signales[0]?.message).toContain("depuis la crise financiere de 2008");
    // Et il doit savoir que le signalement peut etre faux.
    expect(signales[0]?.message).toMatch(/faux positif/);
  });

  it("n'ajoute aucun avertissement quand le chef n'a rien signale", async () => {
    const r = await run("constat", { "redacteur-en-chef": chef([]) });
    if (r.status !== "published") throw new Error("attendu : publie");
    expect(r.warnings.map((w) => w.rule)).not.toContain("UNSUPPORTED_ASSERTION");
  });

  it("EP-007 reste un veto, lui", async () => {
    // La difference tient au statut : EP-007 est une ligne rouge du protocole
    // ou le faux positif est le sens meme du refus. "Affirmation non soutenue"
    // est une question de degre.
    const r = await run("constat", {
      "redacteur-en-chef": () => ({
        verdict: "publier",
        justification: "RAS.",
        implicit_recommendations: ["Les investisseurs y trouveront leur compte."],
        unsupported_assertions: [],
        angle_issues: [],
        suggested_split: [],
      }),
    });
    expect(r.status).toBe("halted");
  });
});

describe("claims qui parlent du jeu de donnees", () => {
  it("signale sans bloquer", () => {
    // La fraicheur d'une serie EST parfois le sujet. Le distinguer demande un
    // jugement que ce filtre lexical n'a pas : il signale, l'humain tranche.
    const a = article({
      claims: [
        claim({ text: "La serie WALCL couvre 4 observations renseignees sur la periode." }),
      ],
    });
    const v = rules(a).find((x) => x.rule === "CLAIM_ABOUT_DATASET");
    expect(v?.severity).toBe("warning");
    expect(runEditorialGate(a).passed).toBe(true);
  });

  it("ne dit rien d'une claim qui porte sur le monde", () => {
    expect(ruleNames(article())).not.toContain("CLAIM_ABOUT_DATASET");
  });
});

/* -------------------------------------------------------------------------
 * Mode prospectif — bout en bout
 * ---------------------------------------------------------------------- */

const adaptateur: SourceAdapter = {
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
          date_observed: "2026-09-09T09:00:00Z",
          date_published: "2026-09-08T10:00:00Z",
          type: "donnee-macro",
          resume: "Le taux effectif s'etablit a 4,33 % au 1er juillet 2026.",
        },
      ],
    };
  },
};

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "media-prospectif-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function run(
  mode: "constat" | "prospectif",
  overrides: Record<string, MockResponder> = {},
) {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  return new EditorialPipeline({
    ctx: {
      llm: new MockLlmClient({
        audit,
        responders: { ...ADAPTIVE_RESPONDERS, ...overrides },
      }),
      audit,
    },
    adapters: [adaptateur],
    mode,
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(join(workDir, "changelog-editorial.md")),
    ),
  }).run("taux directeur");
}

/** Analyste qui rend un scenario correctement conditionne. */
const analysteProspectif: MockResponder = (request) => {
  const p = JSON.parse(request.user) as {
    observations_retenues: Array<{
      url: string;
      tier: number;
      date_observed: string;
      date_published: string | null;
    }>;
  };
  const e = p.observations_retenues[0]!;
  return {
    candidates: [
      {
        id: "claim-1",
        type: "scénario",
        text:
          "Si le taux effectif se maintient au-dessus de 4 % jusqu'a la fin 2026, " +
          "le cout de refinancement des emetteurs les plus exposes augmenterait.",
        proposed_evidence_level: 2,
        rationale: "Premisse sourcee ; la consequence reste conditionnelle.",
        sources: [
          {
            url: e.url,
            tier: e.tier,
            date_observed: e.date_observed,
            date_published: e.date_published,
          },
        ],
      },
    ],
    narrative_vs_data: "Aucune source secondaire retenue.",
    publication_caveats: ["Serie sujette a revision."],
  };
};

describe("mode prospectif", () => {
  it("publie un article bati sur un scenario conditionne", async () => {
    const r = await run("prospectif", { analyste: analysteProspectif });
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(r.article.claims[0]?.type).toBe("scénario");
  });

  it("declare au lecteur qu'il lit du conditionnel", async () => {
    // Pose par le pipeline, pas par le Redacteur : la nature de l'article ne
    // depend pas de ce qu'un modele a bien voulu ecrire.
    const r = await run("prospectif", { analyste: analysteProspectif });
    if (r.status !== "published") throw new Error("attendu : publie");
    expect(r.article.editorial_notes.uncertainty_flags).toContain(
      PROSPECTIVE_DISCLAIMER,
    );
  });

  it("ARRETE un article prospectif qui ne contient que des constats", async () => {
    // Annoncer une projection puis ne livrer que de l'etabli tromperait sur ce
    // que le lecteur a devant lui.
    const r = await run("prospectif");
    expect(r.status).toBe("halted");
    if (r.status !== "halted") return;
    expect(r.reason).toMatch(/aucune claim de type scénario/);
  });

  it("ne declare rien de prospectif en mode constat", async () => {
    const r = await run("constat");
    if (r.status !== "published") throw new Error("attendu : publie");
    expect(r.article.editorial_notes.uncertainty_flags).not.toContain(
      PROSPECTIVE_DISCLAIMER,
    );
  });
});
