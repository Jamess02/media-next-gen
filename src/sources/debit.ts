/**
 * ESPACEMENT des requetes vers une meme source.
 *
 * Dependances : aucune, ni npm ni interne. Module pur, horloge injectable.
 *
 * POURQUOI. Plusieurs sources imposent un debit, et le formulent en conditions
 * d'usage plutot qu'en code de retour. arXiv, releve le 2026-09-19 : « no more
 * than one request every three seconds, and limit requests to a single
 * connection », et contourner la limite y est explicitement interdit. Un 429 ne
 * viendra pas nous avertir : on est simplement en faute.
 *
 * LE PROBLEME EST REEL. Une vague produit six articles, et la passerelle
 * interroge les sources de chacun. Sans espacement, six requetes partent quasi
 * simultanement — six fois la limite des la premiere vague. Le cache en absorbe
 * la plupart, mais seulement une fois la premiere reponse revenue : les appels
 * concurrents la precedent.
 *
 * IL SERIALISE, IL N'ATTEND PAS SEULEMENT. Deux appels lances en parallele qui
 * se contenteraient de consulter « le dernier depart » constateraient la meme
 * valeur et partiraient ensemble apres une meme pause : la limite serait
 * franchie poliment, mais franchie. Chaque appel passe donc par une file.
 *
 * CE QU'IL NE FAIT PAS. Ni disjoncteur, ni reprise, ni quota journalier — ce
 * dernier est tenu par `quota.ts`. La couche marche a son propre espacement,
 * imbrique avec le poids consomme et les pauses 418 ; le demeler tiendrait d'un
 * chantier a part, et cette primitive-ci tient en vingt lignes.
 */

/** L'heure et l'attente, injectables : un test n'attend jamais vraiment. */
export interface HorlogeDebit {
  maintenant(): number;
  attendre(ms: number): Promise<void>;
}

const HORLOGE_REELLE: HorlogeDebit = {
  maintenant: () => Date.now(),
  attendre: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface OptionsEspaceur {
  /** Intervalle minimal entre deux DEPARTS de requete. */
  intervalleMs: number;
  horloge?: HorlogeDebit;
}

export class Espaceur {
  private readonly intervalleMs: number;
  private readonly horloge: HorlogeDebit;
  private dernierDepart = Number.NEGATIVE_INFINITY;
  private file: Promise<unknown> = Promise.resolve();

  constructor(options: OptionsEspaceur) {
    this.intervalleMs = Math.max(0, options.intervalleMs);
    this.horloge = options.horloge ?? HORLOGE_REELLE;
  }

  /**
   * Fait passer un appel, apres l'attente necessaire.
   *
   * L'instant de depart est note AVANT l'appel et quel qu'en soit l'issue :
   * une requete partie est une requete partie, reussie ou non — le fournisseur
   * l'a comptee, l'espacement doit la compter aussi.
   *
   * Un echec ne ferme pas la file : sans cela, une source muette une fois
   * condamnerait toutes les requetes suivantes jusqu'au redemarrage.
   */
  async passer<T>(appel: () => Promise<T>): Promise<T> {
    const tour = this.file.then(async () => {
      const attente = this.dernierDepart + this.intervalleMs - this.horloge.maintenant();
      if (attente > 0) await this.horloge.attendre(attente);
      this.dernierDepart = this.horloge.maintenant();
      return appel();
    });

    // La file avance meme si l'appel echoue.
    this.file = tour.catch(() => undefined);
    return tour;
  }
}
