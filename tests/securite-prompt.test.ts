/**
 * Aucun secret ne doit atteindre un PROMPT envoye a un modele.
 *
 * NE D'UNE FUITE REELLE, retrouvee le 2026-09-11 en confrontant le projet a
 * l'article « Why Your AI Developer Tools Might Be Your Biggest Security Risk »
 * (The Hacker News, aout 2026), dont la menace n°5 est la recolte
 * d'identifiants dans ce que les outils d'IA manipulent.
 *
 * Cinq archives d'audit du 2026-09-09, 14h01-14h02, contiennent l'ancienne clef
 * FRED DANS LE CORPS DE LA REQUETE ENVOYEE AU MODELE (`messages[1].content`).
 * La clef a donc ete transmise en clair a un tiers — le fournisseur du modele —
 * avant d'etre revoquee. Elle arrivait par une URL de source porteuse de
 * `api_key=`, recopiee dans le texte transmis a l'agent.
 *
 * LE TROU. Les tests existants verifiaient que la clef n'apparaissait pas dans
 * les MESSAGES D'ERREUR. Aucun ne verifiait qu'elle n'atteignait pas le PROMPT.
 * Le mecanisme a ete repare depuis — la clef actuelle n'apparait dans aucune
 * archive — mais rien n'empechait qu'il revienne.
 *
 * FRED impose la clef en parametre d'URL : aucune authentification par en-tete
 * n'est offerte. Le caviardage est donc la seule barriere, et il doit etre
 * applique au seul endroit par lequel passe tout prompt.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Agent } from "../src/agents/base.js";
import { Editeur } from "../src/agents/editeur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { MOCK_RESPONDERS } from "../src/fixtures/mock-scenario.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import type { LlmRequest } from "../src/llm/types.js";
import { EditorialPipeline } from "../src/pipeline.js";
import { MOCK_ADAPTERS } from "../src/sources/mock-sources.js";
import type { SourceAdapter } from "../src/sources/types.js";

const SECRET = "clef-fictive-qui-ne-doit-jamais-sortir-0123"; // secret-autorise: valeur de test

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prompt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Agent minimal : il recopie son entree telle quelle dans le prompt. */
class Echo extends Agent<{ texte: string }, { ok: boolean }> {
  readonly role = "veilleur" as const;
  protected readonly instructions = "Repete.";
  protected readonly outputSchema = z.object({ ok: z.boolean() }).strict();
  protected readonly schemaName = "Echo";
  protected buildUserMessage(input: { texte: string }): string {
    return input.texte;
  }
}

describe("le socle des agents caviarde le prompt", () => {
  it("une clef en parametre d'URL n'atteint pas le modele", async () => {
    const vus: LlmRequest<unknown>[] = [];
    const audit = new AuditLog({ dir: join(dir, "audit") });
    const llm = new MockLlmClient({
      audit,
      responders: {
        veilleur: (req) => {
          vus.push(req);
          return { ok: true };
        },
      },
    });
    await new Echo({ llm, audit }).run({
      texte: `Source indisponible : https://api.stlouisfed.org/fred/series?series_id=X&api_key=${SECRET}`,
    });
    const envoye = JSON.stringify(vus);
    expect(envoye).not.toContain(SECRET);
    // Le caviardage laisse une trace : l'agent doit savoir qu'une valeur a ete
    // retiree, plutot que de croire l'URL complete.
    expect(envoye).toMatch(/CAVIARDE/);
  });

  it("laisse intact un texte sans secret", async () => {
    const vus: LlmRequest<unknown>[] = [];
    const audit = new AuditLog({ dir: join(dir, "audit") });
    const llm = new MockLlmClient({
      audit,
      responders: { veilleur: (req) => (vus.push(req), { ok: true }) },
    });
    await new Echo({ llm, audit }).run({ texte: "L'inflation atteint 2,47 % en 2025." });
    expect(vus[0]?.user).toContain("2,47 %");
  });
});

describe("bout en bout — le chemin reel de la fuite historique", () => {
  it("une URL porteuse de clef dans une SOURCE n'atteint aucun prompt", async () => {
    // Reproduit la fuite du 2026-09-09 : une observation dont le texte porte
    // une URL avec `api_key=`. Chaque requete envoyee au modele, par CHAQUE
    // agent, est inspectee.
    const piegee: SourceAdapter = {
      id: "piege:clef",
      describes: "Source dont le texte porte une URL a clef",
      fetch: async () => ({
        observations: [
          {
            source: "Institut de test",
            url: "https://institut.test/serie",
            date_observed: new Date().toISOString(),
            date_published: new Date(Date.now() - 86_400_000).toISOString(),
            type: "serie",
            resume:
              `Releve publie. Donnees brutes : https://api.stlouisfed.org/fred/series` +
              `/observations?series_id=FEDFUNDS&api_key=${SECRET}&file_type=json`,
          },
        ],
        raw: {},
        requestedUrl: "https://institut.test/serie",
      }),
    };

    const envoyes: string[] = [];
    const espion = (r: MockResponder): MockResponder => (req) => {
      envoyes.push(JSON.stringify({ system: req.system, user: req.user }));
      return r(req);
    };
    const responders = Object.fromEntries(
      Object.entries(MOCK_RESPONDERS).map(([k, r]) => [k, espion(r)]),
    );

    const audit = new AuditLog({ dir: join(dir, "audit") });
    const pipeline = new EditorialPipeline({
      ctx: { llm: new MockLlmClient({ audit, responders }), audit },
      adapters: [...MOCK_ADAPTERS, piegee],
      editeur: new Editeur(join(dir, "output"), new EditorialChangelog(join(dir, "c.md"))),
    });
    await pipeline.run("test");

    expect(envoyes.length, "aucun appel au modele : le test ne prouverait rien").toBeGreaterThan(0);
    for (const e of envoyes) expect(e).not.toContain(SECRET);
  });
});
