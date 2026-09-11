/**
 * L'Investigateur — format long, ecrit en deux passes (§5.3).
 *
 * Ce que ces tests protegent, dans l'ordre d'importance :
 *
 *  1. IL PEUT RENONCER. « L'agent doit pouvoir signaler quand une piste n'est
 *     pas assez solide plutot que de forcer un article. » Un agent qui rend
 *     toujours un texte finit par en fabriquer un ; le refus doit etre une
 *     sortie NORMALE du schema, pas une erreur.
 *  2. IL NE REQUALIFIE RIEN. Aucun de ses schemas ne porte de claim (§8) : la
 *     contrainte est structurelle, pas surveillee.
 *  3. SES DEUX PROMPTS disent des choses differentes. Celui du plan interdit
 *     d'ecrire des paragraphes ; celui du chapitre interdit d'ecrire le titre.
 *     Les confondre produirait soit un plan redige, soit des titres en double.
 */

import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import {
  INSTRUCTIONS_CHAPITRE,
  INSTRUCTIONS_PLAN,
  InvestigateurChapitre,
  InvestigateurPlan,
  PlanEnqueteSchema,
} from "../src/agents/investigateur.js";
import { MockLlmClient } from "../src/llm/mock-client.js";
import { claim } from "./helpers.js";

const ENTREE = {
  topic: "ecart persistant entre deux mesures officielles de l'inflation",
  claims: [claim()],
  criteres: ["sources-en-desaccord" as const],
  sourceMaterial: ["Eurostat : 2,0 %", "Banque mondiale : 2,47 %"],
  narrativeVsData: "la presse retient le chiffre le plus bas",
  publicationCaveats: [],
  requiredDisclaimer: null,
  requiredDisclosures: [],
};

const PLAN_VALIDE = {
  publiable: true,
  motif_de_refus: null,
  title: "Deux mesures, un ecart",
  resume_en_bref: "Le fait, ce qu'il engage, ce qui reste incertain.",
  chapitres: [
    { role: "etabli", titre: "Ce que les donnees etablissent", angle: "les chiffres" },
    { role: "contradictoire", titre: "Le versant rassurant", angle: "la lecture inverse" },
    { role: "echeances", titre: "A surveiller", angle: "ce qui trancherait" },
  ],
  glossaire: [{ terme: "IPCH", definition: "indice harmonise des prix" }],
  bibliographie: {
    primaires: ["Eurostat, serie prc_hicp_manr"],
    secondaires: [],
    hypotheses: [],
  },
  uncertainty_flags: ["l'ecart n'est pas explique par les sources retenues"],
};

function agentPlan(reponse: unknown) {
  const audit = new AuditLog();
  return new InvestigateurPlan({
    llm: new MockLlmClient({ audit, responders: { investigateur: () => reponse } }),
    audit,
  });
}

describe("schema du plan", () => {
  it("accepte un plan complet", () => {
    expect(PlanEnqueteSchema.safeParse(PLAN_VALIDE).success).toBe(true);
  });

  it("accepte un REFUS motive, sans titre ni chapitres", () => {
    const refus = {
      publiable: false,
      motif_de_refus: "deux sources d'un meme emetteur : aucun recoupement possible",
      title: null,
      resume_en_bref: null,
      chapitres: [],
      glossaire: [],
      bibliographie: { primaires: [], secondaires: [], hypotheses: [] },
      uncertainty_flags: [],
    };
    expect(PlanEnqueteSchema.safeParse(refus).success).toBe(true);
  });

  it("REFUSE un refus sans motif : renoncer doit s'expliquer", () => {
    const muet = {
      publiable: false,
      motif_de_refus: null,
      title: null,
      resume_en_bref: null,
      chapitres: [],
      glossaire: [],
      bibliographie: { primaires: [], secondaires: [], hypotheses: [] },
      uncertainty_flags: [],
    };
    expect(PlanEnqueteSchema.safeParse(muet).success).toBe(false);
  });

  it("REFUSE un plan publiable sans resume", () => {
    expect(
      PlanEnqueteSchema.safeParse({ ...PLAN_VALIDE, resume_en_bref: null }).success,
    ).toBe(false);
  });

  it("admet une rubrique bibliographique VIDE", () => {
    // Une enquete adossee uniquement a des sources primaires n'a rien a mettre
    // ailleurs. Exiger le contraire pousserait a inventer des references.
    expect(PlanEnqueteSchema.safeParse(PLAN_VALIDE).success).toBe(true);
  });

  it("n'expose AUCUN canal pour modifier une claim (§8)", () => {
    expect(
      PlanEnqueteSchema.safeParse({ ...PLAN_VALIDE, claims: [claim()] }).success,
    ).toBe(false);
  });
});

describe("les agents", () => {
  it("portent tous deux le role `investigateur`", () => {
    const audit = new AuditLog();
    const llm = new MockLlmClient({ audit, responders: {} });
    expect(new InvestigateurPlan({ llm, audit }).role).toBe("investigateur");
    expect(new InvestigateurChapitre({ llm, audit }).role).toBe("investigateur");
  });

  it("transmettent le refus sans le convertir en erreur", async () => {
    const r = await agentPlan({
      ...PLAN_VALIDE,
      publiable: false,
      motif_de_refus: "piste trop mince",
      title: null,
      resume_en_bref: null,
      chapitres: [],
    }).run(ENTREE);
    expect(r.publiable).toBe(false);
    expect(r.motif_de_refus).toMatch(/mince/);
  });

  it("rendent le plan tel que le modele l'a produit", async () => {
    const r = await agentPlan(PLAN_VALIDE).run(ENTREE);
    expect(r.chapitres).toHaveLength(3);
    expect(r.bibliographie.primaires).toHaveLength(1);
  });
});

describe("les deux prompts ne disent pas la meme chose", () => {
  it("le plan INTERDIT d'ecrire des paragraphes", () => {
    expect(INSTRUCTIONS_PLAN).toMatch(/n'ecris aucun paragraphe/i);
  });

  it("le chapitre INTERDIT d'ecrire son titre", () => {
    // Sinon le titre apparaitrait deux fois : celui du plan, pose par le code,
    // et celui que le modele aurait ecrit dans sa prose.
    expect(INSTRUCTIONS_CHAPITRE).toMatch(/n'ecris pas son titre/i);
  });

  it("le chapitre interdit de redire ce qui est deja ecrit", () => {
    expect(INSTRUCTIONS_CHAPITRE).toMatch(/redire|n'y reviens pas/i);
  });

  it("le chapitre prefere ecrire COURT plutot que delayer", () => {
    // Le risque propre au format long : atteindre 1500 mots en remplissant.
    expect(INSTRUCTIONS_CHAPITRE).toMatch(/delayer|creux/i);
  });

  it("les deux autorisent le renoncement ou rappellent le sourcage", () => {
    expect(INSTRUCTIONS_PLAN).toMatch(/publiable: false|renonc/i);
    expect(INSTRUCTIONS_CHAPITRE).toMatch(/claim-id/i);
  });

  it("les deux imposent un ton sobre", () => {
    for (const p of [INSTRUCTIONS_PLAN, INSTRUCTIONS_CHAPITRE]) {
      expect(p).toMatch(/sobre|sans sensationnalisme/i);
    }
  });
});
