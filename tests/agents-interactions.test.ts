/**
 * AGENTS — verification de COMPORTEMENT, pas d'etat.
 *
 * Ecrits AVANT le code (TDD).
 *
 * CE QUE CE PROJET AVAIT DEJA, ET CE QU'IL N'AVAIT PAS
 *
 * La taxonomie des doublures distingue ce qui rend une reponse toute faite de
 * ce qui VERIFIE l'interaction. Wikipedia le dit nettement : « un vrai mock en
 * fait un peu plus [qu'un objet factice] : ses methodes contiennent des
 * assertions, il examine le contexte des appels, par exemple en testant les
 * donnees passees en argument ».
 *
 * Le projet possede :
 *  - des STUBS — `MockLlmClient` rend des reponses scriptees ;
 *  - des FAKES — `MOCK_ADAPTERS`, `AuditLog({persist:false})`, implementations
 *    simplifiees mais fonctionnelles ;
 *  - quelques SPIES ponctuels — `vi.fn()` sur `fetch`.
 *
 * Tout cela verifie l'ETAT : ce qui SORT du pipeline. Rien ne verifiait
 * l'INTERACTION : ce qui ENTRE dans le modele, dans quel ordre, combien de
 * fois, et ce qui n'est PAS appele.
 *
 * Or plusieurs clauses du protocole ne sont QUE des proprietes d'interaction :
 *
 *  - §9.1 « chaque agent recoit le protocole en prompt systeme ». `base.ts`
 *    affirme qu'aucun chemin de code n'y echappe. Personne ne l'avait verifie.
 *  - §5 definit une CHAINE ordonnee de six agents. Rien ne verifiait l'ordre.
 *  - un arret du gate doit empecher les etapes suivantes — c'est une question
 *    de justesse, et aussi de cout : chaque agent evite est un appel FACTURE
 *    qui n'a pas lieu.
 *
 * SUR LES OUTILS. Les references fournies sont Java (Mockito, PowerMock,
 * EasyMock) ou visent Jest. Ce projet est en TypeScript sous Vitest 4, sans
 * aucune dependance de mock : `vi.fn()` et une classe espion de vingt lignes
 * suffisent. Ajouter `ts-mockito` — dont l'ecosysteme est aujourd'hui eclate
 * entre quatre forks — introduirait une dependance pour ce qu'un enregistreur
 * fait deja.
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
import type { LlmClient, LlmRequest } from "../src/llm/types.js";
import { EditorialPipeline } from "../src/pipeline.js";
import type { SourceAdapter } from "../src/sources/types.js";

/**
 * ESPION : enveloppe un client reel et enregistre chaque appel.
 *
 * C'est la doublure qui manquait. Elle ne remplace pas le comportement — le
 * client sous-jacent repond normalement — elle OBSERVE. La distinction compte :
 * un stub qui repondrait a la place empecherait de verifier que la chaine
 * fonctionne vraiment, alors qu'ici on verifie l'interaction ET le resultat.
 */
class LlmSpy implements LlmClient {
  readonly appels: Array<LlmRequest<unknown>> = [];
  readonly modelId: string;

  constructor(private readonly interne: LlmClient) {
    this.modelId = interne.modelId;
  }

  async structured<T>(request: LlmRequest<T>): Promise<T> {
    this.appels.push(request as LlmRequest<unknown>);
    return this.interne.structured(request);
  }

  /** Sequence des agents appeles, dans l'ordre. */
  sequence(): string[] {
    return this.appels.map((a) => a.agent);
  }

  nombreDAppels(agent: string): number {
    return this.appels.filter((a) => a.agent === agent).length;
  }

  dernierAppel(agent: string): LlmRequest<unknown> | undefined {
    return this.appels.filter((a) => a.agent === agent).at(-1);
  }
}

const CLEF_FICTIVE = "gsk_CLEF_QUI_NE_DOIT_JAMAIS_ATTEINDRE_LE_MODELE";

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
  workDir = await mkdtemp(join(tmpdir(), "media-interactions-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function executer(overrides: Record<string, MockResponder> = {}) {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  const spy = new LlmSpy(
    new MockLlmClient({ audit, responders: { ...ADAPTIVE_RESPONDERS, ...overrides } }),
  );
  const resultat = await new EditorialPipeline({
    ctx: { llm: spy, audit },
    adapters: [adaptateur],
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(join(workDir, "changelog.md")),
    ),
  }).run("taux directeur");
  return { spy, resultat, audit };
}

/* -------------------------------------------------------------------------
 * §9.1 — ce qui ENTRE dans le modele
 * ---------------------------------------------------------------------- */

describe("§9.1 — le protocole accompagne CHAQUE appel", () => {
  it("aucun agent n'est appele sans le protocole integral", async () => {
    // `base.ts` affirme qu'« il n'y a pas de chemin de code qui appelle le
    // modele en sautant buildSystemPrompt ». C'est une propriete d'interaction :
    // elle ne se lit dans aucune sortie, seulement dans ce qui est envoye.
    const { spy } = await executer();
    expect(spy.appels.length).toBeGreaterThan(0);
    for (const appel of spy.appels) {
      expect(appel.protocol.length).toBeGreaterThan(200);
      expect(appel.protocol).toMatch(/Protocole [EÉ]ditorial/i);
    }
  });

  it("le protocole est IDENTIQUE d'un agent a l'autre", async () => {
    // C'est ce qui rend le cache de prompt possible cote Anthropic : un
    // prefixe qui varierait le rendrait inoperant, et couterait a chaque appel.
    const { spy } = await executer();
    const distincts = new Set(spy.appels.map((a) => a.protocol));
    expect(distincts.size).toBe(1);
  });

  it("les instructions de role, elles, DIFFERENT par agent", async () => {
    const { spy } = await executer();
    const parRole = new Map(spy.appels.map((a) => [a.agent, a.roleInstructions]));
    expect(new Set(parRole.values()).size).toBe(parRole.size);
  });

  it("chaque appel porte un message utilisateur en JSON (§9.2)", async () => {
    // « Le format d'echange entre agents est TOUJOURS le JSON du §7, jamais du
    // texte libre non structure. »
    const { spy } = await executer();
    for (const appel of spy.appels) {
      expect(() => JSON.parse(appel.user)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------
 * §5 — la chaine, son ordre et son cout
 * ---------------------------------------------------------------------- */

describe("§5 — la chaine de publication est ordonnee", () => {
  it("appelle les agents dans l'ordre du protocole", async () => {
    const { spy } = await executer();
    expect(spy.sequence()).toEqual([
      "veilleur",
      "analyste",
      "fact-checker",
      "redacteur",
      "redacteur-en-chef",
    ]);
  });

  it("n'appelle chaque agent qu'UNE fois quand rien ne coince", async () => {
    // Un appel de trop est un appel FACTURE de trop. Une boucle involontaire
    // ne se verrait dans aucune sortie : seule la comptabilisation la revele.
    const { spy } = await executer();
    for (const role of ["veilleur", "analyste", "redacteur", "redacteur-en-chef"]) {
      expect(spy.nombreDAppels(role)).toBe(1);
    }
  });

  it("l'Editeur n'est PAS un agent LLM", async () => {
    // Choix assume du §5.4 : le formatage doit etre reproductible. S'il
    // appelait un modele, deux generations du meme article differeraient et
    // l'empreinte de relecture sauterait.
    const { spy } = await executer();
    expect(spy.sequence()).not.toContain("editeur");
  });
});

describe("un arret coupe la chaine — et economise les appels", () => {
  it("n'appelle NI le Redacteur NI le redacteur en chef apres un gate ferme", async () => {
    // Verification de NON-appel : impossible a obtenir en observant les
    // sorties, puisqu'il n'y en a pas. C'est exactement ce que la verification
    // de comportement apporte.
    const { spy, resultat } = await executer({
      "fact-checker": (request) => {
        const p = JSON.parse(request.user) as {
          claims_candidates: Array<{ id: string; type: string }>;
        };
        return {
          verdicts: p.claims_candidates.map((c) => ({
            claim_id: c.id,
            verdict: "abaisse",
            adjusted_evidence_level: 1,
            adjusted_type: c.type,
            justification: "La source ne soutient pas l'affirmation.",
            reformulated_text: null,
          })),
          conflicts_found: [],
        };
      },
    });

    expect(resultat.status).toBe("halted");
    expect(spy.nombreDAppels("redacteur")).toBe(0);
    expect(spy.nombreDAppels("redacteur-en-chef")).toBe(0);
  });

  it("borne la reprise du fact-checker a DEUX passes (§9.3)", async () => {
    // « Une boucle non bornee finirait par affaiblir le texte jusqu'a ce qu'il
    // passe. » La borne est une propriete de comptage, rien d'autre.
    const { spy } = await executer({
      "fact-checker": (request) => {
        const p = JSON.parse(request.user) as {
          claims_candidates: Array<{ id: string; type: string }>;
        };
        return {
          verdicts: p.claims_candidates.map((c) => ({
            claim_id: c.id,
            verdict: "abaisse",
            adjusted_evidence_level: 1,
            adjusted_type: c.type,
            justification: "Insoutenable.",
            reformulated_text: null,
          })),
          conflicts_found: [],
        };
      },
    });
    expect(spy.nombreDAppels("fact-checker")).toBe(2);
  });

  it("la SECONDE passe seulement est annoncee comme reformulation", async () => {
    const { spy } = await executer({
      "fact-checker": (request) => {
        const p = JSON.parse(request.user) as {
          claims_candidates: Array<{ id: string; type: string }>;
        };
        return {
          verdicts: p.claims_candidates.map((c) => ({
            claim_id: c.id,
            verdict: "abaisse",
            adjusted_evidence_level: 1,
            adjusted_type: c.type,
            justification: "Insoutenable.",
            reformulated_text: null,
          })),
          conflicts_found: [],
        };
      },
    });

    const passes = spy.appels
      .filter((a) => a.agent === "fact-checker")
      .map((a) => "consigne_de_seconde_passe" in (JSON.parse(a.user) as object));
    expect(passes).toEqual([false, true]);
  });
});

/* -------------------------------------------------------------------------
 * Ce que chaque agent recoit — et ne recoit pas
 * ---------------------------------------------------------------------- */

describe("charge utile de chaque agent", () => {
  it("le Redacteur ne recoit AUCUN canal pour requalifier une claim", async () => {
    // Le §8 interdit de promouvoir une inference en fait. La garantie est
    // structurelle : le schema de sortie n'a pas de champ. Ici on verifie
    // l'autre moitie — ce qu'on lui donne en entree est marque immuable.
    const { spy } = await executer();
    const appel = spy.dernierAppel("redacteur");
    const charge = JSON.parse(appel?.user ?? "{}") as Record<string, unknown>;
    expect(charge["claims_validees_immuables"]).toBeDefined();
    expect(charge["claims"]).toBeUndefined();
  });

  it("le redacteur en chef recoit l'article COMPLET, claims comprises", async () => {
    // Il ne peut juger la coherence entre titre, corps et preuves que s'il voit
    // les trois.
    const { spy } = await executer();
    const charge = JSON.parse(spy.dernierAppel("redacteur-en-chef")?.user ?? "{}") as {
      title?: string;
      body?: string;
      claims?: unknown[];
    };
    expect(charge.title).toBeDefined();
    expect(charge.body).toBeDefined();
    expect(Array.isArray(charge.claims)).toBe(true);
  });

  it("le Veilleur recoit les evenements ET les indices de la passerelle", async () => {
    const { spy } = await executer();
    const charge = JSON.parse(spy.dernierAppel("veilleur")?.user ?? "{}") as Record<
      string,
      unknown
    >;
    expect(charge["evenements"]).toBeDefined();
    expect(charge["indices_pipeline"]).toBeDefined();
  });

  it("le redacteur en chef travaille a un effort SUPERIEUR aux autres", async () => {
    // Son controle est semantique et sans filet : c'est le seul a pouvoir
    // reperer une recommandation implicite qu'aucune regex n'attrape.
    const { spy } = await executer();
    const chef = spy.dernierAppel("redacteur-en-chef");
    const analyste = spy.dernierAppel("analyste");
    expect(chef?.effort).toBe("xhigh");
    expect(analyste?.effort).toBe("high");
  });
});

/* -------------------------------------------------------------------------
 * Ce qui ne doit JAMAIS atteindre le modele
 * ---------------------------------------------------------------------- */

describe("aucun secret ne part dans un prompt", () => {
  it("les clefs d'environnement n'apparaissent dans aucun appel", async () => {
    // Le pipeline lit `.env` au demarrage. Rien n'empeche structurellement une
    // clef de se retrouver dans un message d'erreur d'adaptateur, puis dans les
    // reserves de publication transmises au Redacteur.
    process.env["GROQ_API_KEY_TEST_FICTIF"] = CLEF_FICTIVE;
    try {
      const { spy } = await executer();
      const tout = spy.appels.map((a) => `${a.user}${a.system}`).join("\n");
      expect(tout).not.toContain(CLEF_FICTIVE);
    } finally {
      delete process.env["GROQ_API_KEY_TEST_FICTIF"];
    }
  });
});

/* -------------------------------------------------------------------------
 * §9.4 — chaque appel laisse une trace
 * ---------------------------------------------------------------------- */

describe("§9.4 — journalisation de chaque appel au modele", () => {
  it("autant d'entrees d'audit LLM que d'appels reellement emis", async () => {
    // Propriete de correspondance : compter les sorties ne suffirait pas, il
    // faut comparer deux compteurs d'INTERACTIONS.
    const { spy, audit } = await executer();
    const journalises = audit.entries().filter((e) => e.kind === "llm");
    expect(journalises).toHaveLength(spy.appels.length);
  });

  it("chaque entree nomme l'agent a l'origine de l'appel (EP-002)", async () => {
    const { spy, audit } = await executer();
    const agentsJournalises = audit
      .entries()
      .filter((e) => e.kind === "llm")
      .map((e) => e.agent);
    expect(agentsJournalises).toEqual(spy.sequence());
  });
});
