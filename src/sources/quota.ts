/**
 * QUOTA JOURNALIER d'une source, compte tenu sur disque.
 *
 * Dependances : aucune npm. Node seulement (`fs/promises`, `path`).
 *
 * CE QUE LE DEPOT SAVAIT DEJA FAIRE, ET CE QU'IL NE SAVAIT PAS. `marche/acces.ts`
 * espace les requetes, lit le poids consomme et coupe sur un 429 ou un 418 —
 * tout cela a l'echelle de la minute. Rien n'y compte les appels d'une JOURNEE,
 * et c'est precisement ce que plafonnent les sources technologiques : Alpha
 * Vantage aux environs de vingt-cinq appels par jour, Twelve Data aux environs
 * de huit cents. Les chiffres exacts sont releves de leur documentation au
 * moment de brancher chaque source, jamais devines ici.
 *
 * TROIS PROPRIETES, chacune tiree d'une facon de se tromper.
 *
 *  1. LE COMPTE SURVIT AU REDEMARRAGE. Un compteur en memoire transformerait
 *     « vingt-cinq appels par jour » en « vingt-cinq par execution » : six
 *     vagues quotidiennes suffiraient a griller le quota, et un depassement
 *     repete fait suspendre une clef.
 *  2. LA JOURNEE EST DECOUPEE EN UTC. Sur une machine a Paris, l'heure locale
 *     passe au jour suivant deux heures avant UTC : le compteur rouvrirait
 *     trop tot, alors que le fournisseur compte encore la veille.
 *  3. UN ETAT ILLISIBLE NE BLOQUE RIEN. Ce compteur protege une clef, il ne
 *     doit pas empecher une collecte parce qu'un fichier a ete tronque. On
 *     repart de zero — et l'on assume : c'est le seul choix qui ne transforme
 *     pas un incident de disque en panne editoriale.
 *
 * CE QU'IL NE FAIT PAS. Il ne connait ni le reseau, ni les reponses, ni les
 * codes d'erreur. Il compte ce qu'on lui dit d'avoir consomme. Un appelant qui
 * oublie de l'appeler n'est pas rattrape ici — c'est au module de source de ne
 * pas l'oublier, et a son test de le verifier.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Le compte vit avec le cache des sources, hors versionnement : il decrit
 * notre situation vis-a-vis d'un fournisseur, pas le code du projet.
 */
const DEFAULT_DIR = join(HERE, "..", "..", ".cache", "quotas");

export interface OptionsQuota {
  /** Identifiant court de la source. Nomme le fichier d'etat. */
  id: string;
  /** Appels autorises par journee UTC. */
  plafond: number;
  /** Racine des fichiers d'etat. Surchargeable pour les tests. */
  dir?: string;
  /** Horloge injectable, pour eprouver le passage d'un jour a l'autre. */
  horloge?: () => Date;
}

interface EtatQuota {
  /** Journee UTC au format AAAA-MM-JJ. */
  jour: string;
  consommes: number;
}

export class QuotaJournalier {
  private readonly id: string;
  private readonly plafond: number;
  private readonly dir: string;
  private readonly horloge: () => Date;

  constructor(options: OptionsQuota) {
    this.id = options.id;
    this.plafond = Math.max(0, options.plafond);
    this.dir = options.dir ?? DEFAULT_DIR;
    this.horloge = options.horloge ?? (() => new Date());
  }

  chemin(): string {
    return join(this.dir, `${this.id}.json`);
  }

  /** Journee courante, en UTC. */
  private jour(): string {
    return this.horloge().toISOString().slice(0, 10);
  }

  private async lire(): Promise<EtatQuota> {
    const jour = this.jour();
    try {
      const brut = JSON.parse(await readFile(this.chemin(), "utf8")) as Partial<EtatQuota>;
      // Un etat d'un autre jour ne se corrige pas : il se remplace. C'est le
      // passage a la journee suivante, pas une anomalie.
      if (brut.jour !== jour || typeof brut.consommes !== "number") {
        return { jour, consommes: 0 };
      }
      return { jour, consommes: Math.max(0, brut.consommes) };
    } catch {
      // Fichier absent — le cas ordinaire au premier appel — ou illisible.
      return { jour, consommes: 0 };
    }
  }

  /** Appels encore disponibles aujourd'hui. */
  async reste(): Promise<number> {
    const etat = await this.lire();
    return Math.max(0, this.plafond - etat.consommes);
  }

  /**
   * Reserve `combien` appels, ou REFUSE sans rien consommer.
   *
   * Le refus est total : une requete qui ne tient pas dans ce qui reste ne
   * consomme pas la difference. Autrement, un appel couteux viderait le quota
   * tout en echouant, et la source paraitrait epuisee sans avoir rien rendu.
   */
  async consommer(combien = 1): Promise<boolean> {
    if (combien <= 0) return true;

    const etat = await this.lire();
    if (etat.consommes + combien > this.plafond) return false;

    await this.ecrire({ jour: etat.jour, consommes: etat.consommes + combien });
    return true;
  }

  /** Ecriture atomique : un arret brutal ne laisse pas un compte a moitie ecrit. */
  private async ecrire(etat: EtatQuota): Promise<void> {
    const chemin = this.chemin();
    await mkdir(dirname(chemin), { recursive: true });
    const provisoire = `${chemin}.${process.pid}.tmp`;
    await writeFile(provisoire, JSON.stringify(etat), "utf8");
    await rename(provisoire, chemin);
  }
}
