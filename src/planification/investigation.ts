/**
 * Routage et cadence de l'Investigateur (§5.3, format long).
 *
 * Dependances : aucune, ni npm ni interne. Module pur : il recoit un etat et
 * rend une decision. C'est ce qui permet de tester la cadence sans attendre
 * une semaine, et au studio comme au CLI de partager la meme regle.
 *
 * POURQUOI CE MODULE EXISTE PLUTOT QU'UN PROMPT
 *
 * Deux exigences du cahier des charges ne peuvent pas etre tenues par une
 * consigne adressee au modele :
 *
 *  1. LE TRI DES SUJETS. Demander au modele « ce sujet merite-t-il une
 *     enquete ? » revient a faire juger le juge : on lui propose un format, il
 *     l'accepte. Le tri se fait donc AVANT l'appel, sur des criteres
 *     observables — nombre d'emetteurs, desaccord entre sources, mecanisme a
 *     demonter, zones d'ombre.
 *
 *  2. LA CADENCE. « Prends ton temps » ne ralentit rien : le modele repond en
 *     quelques secondes et l'orchestrateur enchaine. Seul un QUOTA tenu par
 *     l'orchestrateur produit une cadence de publication reelle. C'est la meme
 *     logique que le reste du projet : une regle appliquee par du code testé
 *     est une contrainte, la meme regle confiee au modele est une suggestion.
 */

/* -------------------------------------------------------------------------
 * Routage
 * ---------------------------------------------------------------------- */

/**
 * Criteres d'eligibilite, exposes pour etre DISCUTABLES.
 *
 * Les enfouir dans une condition les rendrait invisibles a la relecture
 * editoriale. Un critere que personne ne peut citer ne peut pas etre conteste.
 */
export const CRITERES_ENQUETE = [
  {
    cle: "sources-en-desaccord",
    libelle:
      "Plusieurs sources se recoupent ou se CONTREDISENT : l'ecart est lui-meme le sujet.",
  },
  {
    cle: "mecanisme-a-demonter",
    libelle:
      "Un mecanisme complexe demande a etre explique, pas seulement constate.",
  },
  {
    cle: "zones-d-ombre",
    libelle:
      "Un enjeu geopolitique ou economique comporte des zones d'ombre documentables.",
  },
] as const;

export type CritereEnquete = (typeof CRITERES_ENQUETE)[number]["cle"];

/**
 * Matiere minimale. Une enquete de 1500 mots adossee a deux sources serait un
 * commentaire deguise en investigation.
 */
export const MIN_SOURCES_ENQUETE = 4;

/**
 * Emetteurs DISTINCTS, pas documents. Huit publications du meme institut ne se
 * recoupent pas : elles se repetent. Le recoupement suppose des origines
 * independantes.
 */
export const MIN_EMETTEURS_ENQUETE = 2;

export interface SignalementDeSujet {
  sujet: string;
  /** Observations disponibles apres collecte. */
  sourcesDisponibles: number;
  /** Emetteurs distincts parmi ces observations. */
  emetteursDistincts: number;
  sourcesEnDesaccord: boolean;
  mecanismeAExpliquer: boolean;
  zonesDombre: boolean;
}

export interface DecisionDeRoutage {
  route: "investigateur" | "production-courante";
  criteres: CritereEnquete[];
  /** Pourquoi ce routage. Toujours renseigne, y compris en cas d'acceptation. */
  motif: string;
}

/**
 * Decide si un sujet releve de l'enquete longue.
 *
 * L'ORDRE DES CONTROLES COMPTE. La matiere est verifiee AVANT les criteres :
 * un sujet peut cocher les trois criteres et rester intraitable faute de
 * documents. La condition de possibilite prime sur la justification.
 */
export function evaluerSujet(s: SignalementDeSujet): DecisionDeRoutage {
  if (s.sourcesDisponibles < MIN_SOURCES_ENQUETE) {
    return {
      route: "production-courante",
      criteres: [],
      motif:
        `matiere insuffisante : ${s.sourcesDisponibles} source(s) pour un ` +
        `plancher de ${MIN_SOURCES_ENQUETE}. Une enquete longue adossee a si ` +
        `peu serait un commentaire deguise.`,
    };
  }
  if (s.emetteursDistincts < MIN_EMETTEURS_ENQUETE) {
    return {
      route: "production-courante",
      criteres: [],
      motif:
        `un seul emetteur distinct : des documents d'une meme origine ne se ` +
        `recoupent pas, ils se repetent. Le recoupement exige au moins ` +
        `${MIN_EMETTEURS_ENQUETE} emetteurs.`,
    };
  }

  const criteres: CritereEnquete[] = [];
  if (s.sourcesEnDesaccord) criteres.push("sources-en-desaccord");
  if (s.mecanismeAExpliquer) criteres.push("mecanisme-a-demonter");
  if (s.zonesDombre) criteres.push("zones-d-ombre");

  if (criteres.length === 0) {
    return {
      route: "production-courante",
      criteres,
      motif:
        "aucun critere d'enquete rempli : le sujet se traite en format court. " +
        "Lui donner 1500 mots produirait du remplissage.",
    };
  }

  return {
    route: "investigateur",
    criteres,
    motif: `critere(s) remplis : ${criteres.join(", ")}.`,
  };
}

/* -------------------------------------------------------------------------
 * Cadence
 * ---------------------------------------------------------------------- */

/**
 * UNE enquete par semaine.
 *
 * A titre de comparaison, les vagues produisent six brouillons toutes les
 * quatre heures, soit quarante-deux par semaine. L'ecart d'ordre de grandeur
 * est le point : sans lui, la distinction entre les deux formats ne serait
 * qu'affichee.
 */
export const QUOTA_ENQUETES_PAR_SEMAINE = 1;

const SEMAINE_MS = 7 * 86_400_000;

export type StatutInvestigation = "en-cours" | "publiee" | "abandonnee";

export interface Investigation {
  sujet: string;
  /** Ouverture, ISO-8601. C'est elle qui situe l'enquete dans la fenetre. */
  ouverte_le: string;
  statut: StatutInvestigation;
  /** Renseigne une fois publiee ; `null` tant qu'elle ne l'est pas. */
  article_id: string | null;
}

export interface DecisionDeCadence {
  autorisee: boolean;
  motif: string;
  /** Quand une nouvelle enquete redeviendra possible. Absent si autorisee. */
  prochaineOuverture?: string;
}

/**
 * Reconstitue l'historique des enquetes depuis les articles deja produits.
 *
 * PAS DE FICHIER D'ETAT SEPARE, et c'est deliberé. Un journal tenu a part
 * divergerait du reel des la premiere suppression manuelle d'un brouillon, et
 * la cadence reposerait alors sur une comptabilite fausse. Les articles
 * portent deja leur mode et leur date : ils SONT l'historique.
 *
 * Un brouillon existant compte comme une enquete `publiee` — au sens de
 * « produite ». Le quota porte sur le travail engage, pas sur la mise en ligne,
 * qui depend d'une relecture humaine dont la date n'est pas la bonne mesure.
 */
export function enquetesDepuisArticles(
  articles: ReadonlyArray<{
    id: string;
    title?: string;
    mode?: string;
    published_at: string;
  }>,
): Investigation[] {
  return articles
    .filter((a) => a.mode === "enquete")
    .map((a) => ({
      sujet: a.title ?? a.id,
      ouverte_le: a.published_at,
      statut: "publiee" as const,
      article_id: a.id,
    }));
}

/** Fin de la fenetre glissante de sept jours. */
export function prochaineFenetre(maintenant: Date): string {
  return new Date(maintenant.getTime() + SEMAINE_MS).toISOString();
}

/**
 * Dit si une nouvelle enquete peut etre ouverte.
 *
 * DEUX CHOIX QUI FONT LA DIFFERENCE :
 *
 * Une enquete EN COURS consomme le quota. Sans cela, l'orchestrateur en
 * ouvrirait autant qu'il veut tant qu'aucune n'est publiee : le quota ne
 * s'appliquerait qu'apres coup, donc jamais.
 *
 * Une piste ABANDONNEE ne le consomme pas. Le cahier des charges demande que
 * l'agent puisse renoncer plutot que forcer un article ; si renoncer coutait
 * aussi cher que publier, il serait incite a publier.
 */
export function enqueteAutorisee(
  passees: readonly Investigation[],
  maintenant: Date,
): DecisionDeCadence {
  const debut = maintenant.getTime() - SEMAINE_MS;

  const comptees = passees.filter((i) => {
    if (i.statut === "abandonnee") return false;
    const t = Date.parse(i.ouverte_le);
    return !Number.isNaN(t) && t >= debut;
  });

  if (comptees.length < QUOTA_ENQUETES_PAR_SEMAINE) {
    return {
      autorisee: true,
      motif:
        `${comptees.length}/${QUOTA_ENQUETES_PAR_SEMAINE} enquete(s) sur la ` +
        `fenetre de sept jours.`,
    };
  }

  // La fenetre se libere quand la PLUS ANCIENNE des enquetes comptees en sort.
  const plusAncienne = Math.min(...comptees.map((i) => Date.parse(i.ouverte_le)));

  return {
    autorisee: false,
    motif:
      `quota atteint : ${comptees.length}/${QUOTA_ENQUETES_PAR_SEMAINE} sur ` +
      `sept jours glissants. Le format long se defend par sa rarete ; le ` +
      `relacher reviendrait a produire des enquetes de vagues.`,
    prochaineOuverture: new Date(plusAncienne + SEMAINE_MS).toISOString(),
  };
}
