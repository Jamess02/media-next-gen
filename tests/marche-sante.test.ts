/**
 * Sonde de sante des sources de marche : `npm run dev -- marches`.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Aucune source de marche n'est sur le chemin critique : indisponible, elle
 * laisse passer le pipeline, et l'article porte la mention « source
 * indisponible ». Encore faut-il que l'editeur puisse SAVOIR, sans lancer un
 * article, laquelle repond, laquelle a change de schema, laquelle nous a
 * bannis. C'est le role de cette sonde — une requete legere par fournisseur,
 * aucun appel au modele.
 */

import { describe, expect, it } from "vitest";

import { rapportDeSante, santeDesMarches } from "../src/marche/sante.js";
import type { ConnecteurDeMarche, EtatDeSante } from "../src/marche/types.js";
import { connecteursDeMarche } from "../src/sources/catalogue.js";

const connecteur = (id: string, sante: () => Promise<EtatDeSante>): ConnecteurDeMarche => ({
  id,
  nom: id.toUpperCase(),
  couvre: () => false,
  releve: async () => {
    throw new Error("non utilise ici");
  },
  sante,
});

describe("santeDesMarches — chaque fournisseur sonde, aucun ne fait tomber les autres", () => {
  it("rend l'etat de chaque connecteur, dans l'ordre", async () => {
    const etats = await santeDesMarches([
      connecteur("a", async () => ({ ok: true, detail: "ping" })),
      connecteur("b", async () => ({ ok: false, detail: "HTTP 503" })),
    ]);
    expect(etats).toEqual([
      { id: "a", nom: "A", ok: true, detail: "ping" },
      { id: "b", nom: "B", ok: false, detail: "HTTP 503" },
    ]);
  });

  it("une sonde qui LEVE est rapportee en echec, sans interrompre les autres", async () => {
    const etats = await santeDesMarches([
      connecteur("a", async () => {
        throw new Error("boom");
      }),
      connecteur("b", async () => ({ ok: true, detail: "ok" })),
    ]);
    expect(etats[0]).toMatchObject({ ok: false });
    expect(etats[0]?.detail).toMatch(/boom/);
    expect(etats[1]?.ok).toBe(true);
  });
});

describe("rapportDeSante — lisible par l'editeur", () => {
  it("dit OK ou INDISPONIBLE, nomme les sources non branchees, et rappelle le mode degrade", () => {
    const r = rapportDeSante(
      [
        { id: "binance", nom: "Binance", ok: true, detail: "le ping repond" },
        { id: "yahoo", nom: "Yahoo Finance", ok: false, detail: "schema de reponse modifie" },
      ],
      [{ id: "coingecko:agregats", reason: "COINGECKO_API_KEY absente de l'environnement" }],
    );
    expect(r).toMatch(/Binance\s+OK/);
    expect(r).toMatch(/Yahoo Finance\s+INDISPONIBLE — schema de reponse modifie/);
    expect(r).toMatch(/non branchee.*COINGECKO_API_KEY absente/s);
    expect(r).toMatch(/mode degrade/i);
  });
});

describe("connecteursDeMarche — une seule facon de construire les connecteurs", () => {
  it("sans clef CoinGecko : Binance et Yahoo, et CoinGecko declare absent", () => {
    const { connecteurs, ecartes } = connecteursDeMarche({});
    expect(connecteurs.map((c) => c.id)).toEqual(["binance", "yahoo"]);
    expect(ecartes[0]?.reason).toMatch(/COINGECKO_API_KEY absente/);
  });

  it("avec la clef : les trois fournisseurs", () => {
    const { connecteurs, ecartes } = connecteursDeMarche({ COINGECKO_API_KEY: "CG-fictive" });
    expect(connecteurs.map((c) => c.id)).toEqual(["binance", "coingecko", "yahoo"]);
    expect(ecartes).toEqual([]);
  });
});
