/**
 * Vide le cache des flux AVANT chaque execution de la suite.
 *
 * Sans cela, un test qui bouchonne `fetch` et met en cache sert, a l'execution
 * suivante, la reponse de la precedente : la requete ne part plus, et un test
 * qui mesure le reseau devient vert sans rien mesurer. Constate le 2026-09-19
 * sur les deux tests de debit et de cache d'arXiv.
 *
 * Le dossier est celui que `vitest.config.ts` impose par SOURCES_CACHE_DIR ; il
 * est recalcule ici plutot qu'importe, la configuration n'exportant rien.
 */
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default async function nettoyerLeCacheDesTests(): Promise<void> {
  const racine = dirname(dirname(fileURLToPath(import.meta.url)));
  await rm(join(racine, ".cache", "tests-sources"), { recursive: true, force: true });
}
