/**
 * `.env.example` doit decrire TOUTES les clefs que le code lit.
 *
 * POURQUOI CE TEST EXISTE. Constate le 2026-09-20 : trois clefs lues par le
 * code — Currents, NewsData, CoinGecko — n'y figuraient pas. Personne n'avait
 * menti ; le fichier avait simplement cesse de suivre, comme le font tous les
 * fichiers d'exemple qu'aucun controle ne tient.
 *
 * CE QUE CELA COUTE QUAND CELA DERIVE. Une source dont la clef n'est pas
 * documentee est une source que personne ne branche : elle est « simplement
 * declaree absente » a chaque collecte, sans erreur, sans trace, et le
 * catalogue paraIt complet alors qu'il ne l'est pas.
 *
 * CE TEST NE LIT AUCUNE VALEUR. Il compare des NOMS de variables : le `.env`
 * reel n'est jamais ouvert, et rien de secret ne peut transiter par lui.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RACINE = fileURLToPath(new URL("..", import.meta.url));

/** Tous les `.ts` de `src/`, en profondeur. */
function fichiersSource(dossier: string): string[] {
  return readdirSync(dossier).flatMap((entree) => {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) return fichiersSource(chemin);
    return chemin.endsWith(".ts") ? [chemin] : [];
  });
}

describe(".env.example", () => {
  const exemple = readFileSync(join(RACINE, ".env.example"), "utf8");

  /**
   * Les noms lus par le code. On ne retient que la forme `env["NOM"]` ou
   * `process.env["NOM"]` : c'est ainsi que le depot lit sa configuration, et
   * chercher plus large ramasserait les noms cites dans les commentaires.
   */
  const lues = new Set<string>();
  for (const fichier of fichiersSource(join(RACINE, "src"))) {
    const contenu = readFileSync(fichier, "utf8");
    for (const m of contenu.matchAll(/\benv\["([A-Z][A-Z0-9_]*)"\]/g)) {
      const nom = m[1];
      if (nom !== undefined) lues.add(nom);
    }
  }

  it("trouve bien des variables lues par le code", () => {
    // Garde-fou du test lui-meme : si l'extraction cassait, l'ensemble serait
    // vide et toutes les assertions suivantes passeraient sans rien verifier.
    expect(lues.size).toBeGreaterThan(5);
  });

  it("documente CHAQUE variable que le code lit", () => {
    const manquantes = [...lues].filter(
      (nom) => !new RegExp(`^${nom}=`, "m").test(exemple),
    );
    expect(manquantes, `absentes de .env.example : ${manquantes.join(", ")}`).toEqual([]);
  });

  it("ne contient AUCUNE valeur", () => {
    // Un exemple qui porterait une vraie clef la publierait : le fichier est
    // versionne, lui.
    const remplies = exemple
      .split(/\r?\n/)
      .filter((l) => /^[A-Z][A-Z0-9_]*=.+/.test(l.trim()))
      // `MEDIA_PROVIDER=mock` est une valeur par defaut, pas un secret.
      .filter((l) => !l.startsWith("MEDIA_PROVIDER="));
    expect(remplies, "une valeur figure dans .env.example").toEqual([]);
  });
});
