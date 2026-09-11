/**
 * Sonde de sante des sources de marche : `npm run dev -- marches`.
 *
 * Dependances : `types.ts` (types uniquement). Aucune dependance npm.
 *
 * Aucune source de marche n'est sur le chemin critique : indisponible, elle
 * laisse passer le pipeline et l'article porte la mention « source
 * indisponible ». La sonde permet de le SAVOIR sans lancer d'article — quel
 * fournisseur repond, lequel a change de schema, lequel nous a bannis — par
 * une requete legere chacun, sans aucun appel au modele.
 */

import type { ConnecteurDeMarche } from "./types.js";

export interface EtatDeConnecteur {
  id: string;
  nom: string;
  ok: boolean;
  detail: string;
}

/**
 * Sonde chaque connecteur. Une sonde qui LEVE est rapportee en echec : elle ne
 * doit pas masquer l'etat des autres, ce qui est precisement ce qu'on vient
 * lui demander.
 */
export async function santeDesMarches(
  connecteurs: readonly ConnecteurDeMarche[],
): Promise<EtatDeConnecteur[]> {
  return Promise.all(
    connecteurs.map(async (c) => {
      try {
        const etat = await c.sante();
        return { id: c.id, nom: c.nom, ok: etat.ok, detail: etat.detail };
      } catch (e) {
        return {
          id: c.id,
          nom: c.nom,
          ok: false,
          detail: `la sonde a leve : ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }),
  );
}

/** Rapport lisible : un etat par fournisseur, puis les sources non branchees. */
export function rapportDeSante(
  etats: readonly EtatDeConnecteur[],
  ecartes: ReadonlyArray<{ id: string; reason: string }>,
): string {
  const largeur = Math.max(20, ...etats.map((e) => e.nom.length + 2), ...ecartes.map((s) => s.id.length + 2));
  const lignes = [
    "Sources de marche — sonde de sante (une requete legere par fournisseur, aucun appel au modele)",
    "",
    ...etats.map((e) => `  ${e.nom.padEnd(largeur)}${e.ok ? "OK" : "INDISPONIBLE"} — ${e.detail}`),
    ...ecartes.map((s) => `  ${s.id.padEnd(largeur)}non branchee — ${s.reason}`),
    "",
    "Une source indisponible ne bloque pas le pipeline (mode degrade) : les articles " +
      "qui l'auraient utilisee portent la mention « source indisponible », avec son motif.",
  ];
  return lignes.join("\n");
}
