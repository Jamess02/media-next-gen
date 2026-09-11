/**
 * Quels fichiers un controle de secrets doit-il regarder.
 *
 * Dependances : `node:child_process` pour interroger git. Aucune npm.
 *
 * FAILLE DU GARDE-FOU LUI-MEME, constatee le 2026-09-11.
 *
 * `npm run verifier-secrets` repondait « aucun secret » alors qu'une vraie
 * clef d'API se trouvait dans un fichier de test tout juste cree. Motif : il
 * scannait `git ls-files`, c'est-a-dire les fichiers DEJA SUIVIS. Un secret
 * ecrit dans un fichier neuf — exactement le cas d'un travail en cours —
 * restait invisible.
 *
 * Le hook de pre-commit, lui, l'a refusee : il analyse l'INDEX. Mais un
 * controle qui affirme « aucun secret » sans avoir regarde vaut MOINS que pas
 * de controle du tout, parce qu'il rassure. C'est la meme faute que celle qui
 * avait laisse fuiter la clef FRED : regarder au mauvais endroit, puis
 * conclure.
 *
 * CE QUI EST EXCLU, ET POURQUOI. Les fichiers ignores par git ne sont pas
 * destines a etre versionnes : `.env` et `audit/raw/` en font partie, et les
 * signaler produirait une alerte a chaque execution. Une alerte permanente
 * finit ignoree, et c'est la vraie qu'on manque alors.
 */

import { execFileSync } from "node:child_process";

const git = (args: string[]): string[] =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f.trim().length > 0);

/**
 * Fichiers suivis PLUS les nouveaux fichiers non ignores.
 *
 * Autrement dit : tout ce qui peut se retrouver dans un commit. `--exclude-standard`
 * applique `.gitignore`, `.git/info/exclude` et les exclusions globales — la
 * meme regle que celle qui decide ce que `git add -A` prendrait.
 */
export function fichiersAControler(): string[] {
  let suivis: string[] = [];
  let nouveaux: string[] = [];
  try {
    suivis = git(["ls-files"]);
    nouveaux = git(["ls-files", "--others", "--exclude-standard"]);
  } catch {
    // git indisponible : mieux vaut une liste vide qu'une liste partielle
    // silencieuse. L'appelant verifie qu'elle n'est pas vide.
    return [];
  }
  return [...new Set([...suivis, ...nouveaux])];
}
