/**
 * Configuration de la suite de tests.
 *
 * ELLE N'EXISTE QUE POUR UNE RAISON : empecher un test d'ecrire dans le cache
 * de PRODUCTION.
 *
 * Le 2026-09-19, une minute apres avoir branche le cache d'arXiv, la suite a
 * depose son flux bouchonne dans `.cache/sources`. Le vrai pipeline l'aurait
 * ensuite servi pendant une heure comme s'il venait de la source — un article
 * aurait cite une prepublication fabriquee par un test.
 *
 * La protection ne repose donc PAS sur la discipline de chaque test : la
 * variable est posee ici, pour toute la suite, et le dossier est vide avant
 * chaque execution.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const RACINE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    env: { SOURCES_CACHE_DIR: join(RACINE, ".cache", "tests-sources") },
    globalSetup: [join(RACINE, "tests", "global-setup.ts")],
  },
});
