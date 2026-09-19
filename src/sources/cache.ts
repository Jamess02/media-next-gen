/**
 * Cache de reponses : memoire, puis disque.
 *
 * Dependances : aucune npm. Node seulement (`crypto`, `fs/promises`, `path`).
 *
 * D'OU IL VIENT. Cette logique existait, PRIVEE dans `marche/acces.ts`. Les
 * sources technologiques en ont besoin a leur tour — a commencer par celles qui
 * plafonnent au jour, ou une reponse relue vaut un appel economise sur
 * vingt-cinq. Elle est donc EXTRAITE, pas recopiee : le depot a deja constate
 * deux fois qu'une seconde implementation diverge, et que c'est celle qu'aucun
 * test ne couvre qui laisse passer la faute.
 *
 * DEUX INVARIANTS, ET AUCUN N'EST DU CONFORT.
 *
 *  1. L'HORODATAGE D'ORIGINE SURVIT. Une reponse relue garde la date de la
 *     requete qui l'a obtenue. Sans cela, l'article daterait une observation du
 *     moment ou il la relit et pretendrait une fraicheur qu'elle n'a pas — ce
 *     que le §5.1 interdit, la date d'observation faisant partie de la preuve.
 *  2. L'URL EST REVERIFIEE A LA LECTURE. Le fichier est nomme par une empreinte
 *     TRONQUEE : une collision, ou un fichier deplace a la main, servirait
 *     sinon la reponse d'une autre requete sous l'identite de celle-ci.
 *
 * CE QU'IL NE FAIT PAS. Il ne decide pas de la duree de validite, ne valide
 * aucune forme et ne connait pas le reseau. L'appelant valide AVANT d'ecrire :
 * un schema casse servi pendant tout le delai masquerait la reparation du
 * fournisseur.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EntreeDeCache {
  url: string;
  /** Date de la requete qui a obtenu cette reponse. Jamais celle de la relecture. */
  horodatageRequete: string;
  /** Instant d'expiration, en millisecondes. */
  expireA: number;
  corps: unknown;
}

export interface OptionsCache {
  /** Identifiant du fournisseur : separe les caches sur le disque. */
  id: string;
  /** Racine du cache. `null` : memoire seule, aucun fichier ecrit. */
  dir?: string | null;
  /** Horloge injectable, pour eprouver l'expiration sans attendre. */
  horloge?: () => number;
}

export class CacheDeReponses {
  private readonly id: string;
  private readonly dir: string | null;
  private readonly horloge: () => number;
  private readonly memoire = new Map<string, EntreeDeCache>();

  constructor(options: OptionsCache) {
    this.id = options.id;
    this.dir = options.dir ?? null;
    this.horloge = options.horloge ?? (() => Date.now());
  }

  /** Chemin du fichier d'une url, ou `null` en memoire seule. */
  chemin(url: string): string | null {
    if (this.dir === null) return null;
    const empreinte = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return join(this.dir, `cache-${this.id}`, `${empreinte}.json`);
  }

  async lire(url: string): Promise<EntreeDeCache | null> {
    const t = this.horloge();

    const enMemoire = this.memoire.get(url);
    if (enMemoire !== undefined) return enMemoire.expireA > t ? enMemoire : null;

    const chemin = this.chemin(url);
    if (chemin === null) return null;

    try {
      const e = JSON.parse(await readFile(chemin, "utf8")) as EntreeDeCache;
      // L'url est reverifiee : une collision d'empreinte, ou un fichier
      // deplace a la main, ne doit pas servir la reponse d'une autre requete.
      if (e.url !== url || typeof e.expireA !== "number" || e.expireA <= t) return null;
      // Sans horodatage, l'entree ne prouve plus sa date : elle ne vaut rien.
      if (typeof e.horodatageRequete !== "string") return null;
      this.memoire.set(url, e);
      return e;
    } catch {
      // Fichier absent ou illisible : on redemande au fournisseur.
      return null;
    }
  }

  async ecrire(entree: EntreeDeCache): Promise<void> {
    this.memoire.set(entree.url, entree);
    const chemin = this.chemin(entree.url);
    if (chemin === null) return;

    // Ecriture atomique : un arret brutal ne laisse jamais un fichier a moitie
    // ecrit, que la lecture suivante prendrait pour du cache valide.
    await mkdir(dirname(chemin), { recursive: true });
    const provisoire = `${chemin}.${process.pid}.tmp`;
    await writeFile(provisoire, JSON.stringify(entree), "utf8");
    await rename(provisoire, chemin);
  }
}
