/**
 * SECURITE — client LLM face a un fournisseur hostile ou defaillant.
 *
 * Ecrits AVANT le code (TDD).
 *
 * LE MODELE DE MENACE. Le fournisseur est une dependance de confiance qu'on ne
 * controle pas : un palier gratuit, une cle partagee, une URL de base
 * surchargeable par variable d'environnement (`MEDIA_BASE_URL`). Trois choses
 * doivent tenir meme s'il se comporte mal :
 *
 *  1. AUCUNE CLEF DANS LES ERREURS. Le client construit un en-tete
 *     `Authorization: Bearer <clef>`. Un message d'erreur qui reprendrait la
 *     requete la publierait — et ces messages remontent au CLI, au studio, et
 *     jusqu'aux incertitudes declarees d'un article.
 *  2. PLAFOND DE TAILLE. `await response.text()` sans borne : un fournisseur
 *     qui repond des centaines de megaoctets epuise la memoire du processus.
 *     Meme faille que pour les sources, autre porte.
 *  3. PAS DE POLLUTION DE PROTOTYPE. La reponse est du JSON tiers, parsee puis
 *     manipulee. Un `__proto__` ne doit pas atteindre `Object.prototype`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit/audit-log.js";
import { OpenAiCompatibleLlmClient } from "../src/llm/openai-compatible-client.js";
import { MAX_LLM_RESPONSE_BYTES } from "../src/llm/openai-compatible-client.js";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CLEF = "gsk_UNE_CLEF_QUI_NE_DOIT_PAS_FUIR_0123456789";

const Schema = z.object({ valeur: z.string() }).strict();

function client(): OpenAiCompatibleLlmClient {
  return new OpenAiCompatibleLlmClient({
    providerName: "fournisseur-test",
    baseUrl: "https://api.fournisseur.test/v1",
    model: "modele-test",
    apiKey: CLEF,
    audit: new AuditLog({ persist: false }),
    enforcesSchema: true,
  });
}

const requete = () => ({
  agent: "analyste",
  schemaName: "Test",
  schema: Schema,
  protocol: "Protocole Editorial v1.0 (extrait de test)",
  roleInstructions: "Consignes de role, sans importance ici.",
  system: "protocole + consignes",
  user: "sujet",
});

function stub(reponse: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => reponse));
}

/** Reponse conforme au contrat OpenAI, contenu au choix. */
const completion = (contenu: string, finish = "stop"): unknown => ({
  choices: [{ finish_reason: finish, message: { content: contenu } }],
});

describe("aucune clef d'API ne sort du client", () => {
  it("ne cite pas la clef sur une erreur HTTP", async () => {
    stub(new Response("acces refuse", { status: 401 }));
    await expect(client().structured(requete())).rejects.toSatisfy(
      (e: unknown) => !String(e instanceof Error ? e.message : e).includes(CLEF),
    );
  });

  it("ne cite pas la clef sur une reponse non conforme", async () => {
    stub(new Response("<html>maintenance</html>", { status: 200 }));
    await expect(client().structured(requete())).rejects.toSatisfy(
      (e: unknown) => !String(e instanceof Error ? e.message : e).includes(CLEF),
    );
  });

  it("ne cite pas la clef sur un echec reseau", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connexion refusee vers Bearer ${CLEF}`);
      }),
    );
    await expect(client().structured(requete())).rejects.toSatisfy(
      (e: unknown) => !String(e instanceof Error ? e.message : e).includes(CLEF),
    );
  });
});

describe("plafond de taille de reponse", () => {
  it("refuse un corps demesure", async () => {
    const flux = new ReadableStream<Uint8Array>({
      start(controller) {
        const morceau = new TextEncoder().encode("x".repeat(64 * 1024));
        const tours = Math.ceil(MAX_LLM_RESPONSE_BYTES / morceau.length) + 2;
        for (let i = 0; i < tours; i += 1) controller.enqueue(morceau);
        controller.close();
      },
    });
    stub(new Response(flux, { status: 200 }));

    await expect(client().structured(requete())).rejects.toThrow(
      /trop volumineuse/i,
    );
  }, 20_000);

  it("laisse passer une reponse de taille normale", async () => {
    stub(
      new Response(JSON.stringify(completion(JSON.stringify({ valeur: "ok" }))), {
        status: 200,
      }),
    );
    await expect(client().structured(requete())).resolves.toEqual({
      valeur: "ok",
    });
  });
});

describe("charge utile hostile", () => {
  it("un __proto__ dans la reponse ne contamine pas Object.prototype", async () => {
    const charge = JSON.stringify({
      valeur: "ok",
      ["__proto__"]: { pollue_par_llm: "oui" },
    });
    stub(new Response(JSON.stringify(completion(charge)), { status: 200 }));

    // Le schema `.strict()` refuse le champ en trop : c'est le comportement
    // attendu. Ce qui compte ici est qu'aucun prototype n'ait bouge, que la
    // reponse soit acceptee ou non.
    await client()
      .structured(requete())
      .catch(() => undefined);

    expect(({} as Record<string, unknown>)["pollue_par_llm"]).toBeUndefined();
  });

  it("signale une reponse tronquee au lieu de la publier", async () => {
    // `finish_reason: "length"` signifie que le modele a ete coupe. Une sortie
    // partielle qui se trouverait valide au schema serait publiee comme si
    // elle etait complete.
    stub(
      new Response(
        JSON.stringify(completion(JSON.stringify({ valeur: "ok" }), "length")),
        { status: 200 },
      ),
    );
    await expect(client().structured(requete())).rejects.toThrow(/tronquee/i);
  });
});
