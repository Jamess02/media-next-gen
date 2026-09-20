/**
 * Vagues d'articles — six sujets, toutes les quatre heures.
 *
 * Dependances : les types du pipeline et `constants.ts`. Aucune npm — un
 * `setTimeout` et une rotation d'index suffisent, et une bibliotheque de
 * planification ajouterait une syntaxe cron a apprendre pour un intervalle
 * fixe.
 *
 * CE QU'UNE VAGUE NE FAIT PAS, ET C'EST LE POINT CENTRAL
 *
 * Elle ne PUBLIE rien. Elle depose des brouillons dans `output/`. La regle du
 * projet est qu'aucun article ne parait sans relecture humaine nommee, et une
 * automatisation qui publierait la contournerait — l'attestation cesserait
 * alors de valoir quoi que ce soit, puisqu'elle certifierait un texte que
 * personne n'a lu.
 *
 * A raison de six brouillons toutes les quatre heures, cela fait trente-six
 * textes par jour a relire. C'est beaucoup, et c'est voulu ainsi : le goulot
 * est la relecture, pas la production. Mieux vaut qu'il se voie.
 *
 * COMPOSITION FIXE, PAS ALEATOIRE
 *
 * « Dans chaque vague il doit y avoir les deux types. » Tirer les modes au sort
 * produirait tot ou tard une vague entierement d'un cote : rare, donc
 * constatee tard, sur un lot deja produit. La composition est donc arretee ici
 * et verifiee par les tests.
 */

import type { ArticleMode } from "../protocol/constants.js";
import type { PipelineResult } from "../pipeline.js";

/** Six articles par vague. */
export const TAILLE_VAGUE = 6;

/** Quatre heures. */
export const INTERVALLE_VAGUE_MS = 4 * 60 * 60 * 1000;

export interface Theme {
  /** Domaine, pour verifier d'un coup d'oeil que la vague est variee. */
  domaine: string;
  sujet: string;
  mode: ArticleMode;
}

/**
 * Catalogue des themes.
 *
 * Chaque sujet est ADOSSE a des sources reellement branchees : un theme sans
 * source produirait six arrets en collecte et donnerait l'illusion d'un
 * pipeline defaillant alors que le materiau manque.
 *
 * Les sujets prospectifs sont formules comme des CONDITIONS observables — « si
 * X se maintient », « ce qu'impliquerait Y » — parce que le §3 exige qu'un
 * scenario porte sa condition, et qu'un sujet formule en prevision pousse le
 * modele a en produire une.
 */
/**
 * L'ORDRE DES CONSTATS EST UNE GARANTIE, PAS UNE PRESENTATION.
 *
 * Une vague prend quatre constats CONSECUTIFS dans cette liste, en tournant.
 * Si la geopolitique et l'evenementiel y etaient groupes, des vagues entieres
 * n'en porteraient aucun — c'est ce qui se passait, et ce que l'editeur a
 * constate le 2026-09-13. Ils sont donc INTERCALES, de sorte que toute fenetre
 * de quatre en contienne au moins deux. Un test le verifie sur trente vagues.
 *
 * LA TECHNOLOGIE, ajoutee le 2026-09-19, suit la meme regle et pour la meme
 * raison : ses quatre constats, d'abord ajoutes a la suite, ont produit une
 * vague entierement technologique et sans aucune geopolitique — le test l'a
 * vue. Ils sont espaces de quatre, donc au plus un par vague.
 *
 * Leur nombre compte aussi : dix-sept constats pour une fenetre de quatre, neuf
 * prospectifs pour une fenetre de deux. Des comptes premiers entre eux avec la
 * taille de la fenetre font defiler TOUTES les combinaisons ; avec huit
 * constats, la rotation ne produisait que deux vagues differentes.
 */
export const THEMES: readonly Theme[] = [
  // --- Constats : ce qui est etabli --------------------------------------
  {
    domaine: "geopolitique",
    sujet: "sanctions americaines : designations recentes et programmes concernes",
    mode: "constat",
  },
  {
    domaine: "risque naturel",
    sujet: "seismes de magnitude 6 et plus : releve recent et zones touchees",
    mode: "constat",
  },
  {
    domaine: "macro",
    sujet: "inflation annuelle en zone euro : dernier releve publie par Eurostat",
    mode: "constat",
  },
  {
    domaine: "technologie",
    sujet:
      "diffusion mesuree des modeles ouverts : ce que comptent reellement les telechargements du Hub, et ce qu'ils ne comptent pas",
    mode: "constat",
  },
  {
    domaine: "humanitaire",
    sujet:
      "alertes de catastrophe en cours : ce que le systeme GDACS classe et ce qu'il estime",
    mode: "constat",
  },
  {
    domaine: "geopolitique",
    sujet: "paix et securite : ce que les Nations unies ont publie ces derniers jours",
    mode: "constat",
  },
  {
    domaine: "banques centrales",
    sujet: "bilan de la Reserve federale : niveau de l'actif total",
    mode: "constat",
  },
  {
    domaine: "technologie",
    sujet:
      "versions publiees des outils d'intelligence artificielle : ce qui a ete livre, distingue de ce qui a ete annonce",
    mode: "constat",
  },
  {
    domaine: "risque naturel",
    sujet:
      "populations exposees par les dernieres alertes de catastrophe, et ce que l'estimation ne dit pas",
    mode: "constat",
  },
  {
    domaine: "geopolitique",
    sujet: "conflits et processus diplomatiques documentes par les Nations unies",
    mode: "constat",
  },
  {
    domaine: "macro",
    sujet: "croissance du PIB : dernieres donnees publiees pour la France et le monde",
    mode: "constat",
  },
  {
    domaine: "technologie",
    sujet:
      "correctifs recents d'OpenSSL : ce que la bibliotheque cryptographique la plus deployee a corrige, et sur quelles versions",
    mode: "constat",
  },
  {
    domaine: "humanitaire",
    sujet:
      "crises humanitaires : ce que l'ONU documente, et les reponses annoncees par les autorites",
    mode: "constat",
  },
  {
    domaine: "banques centrales",
    sujet: "taux directeur americain : dernier releve de la serie des fonds federaux",
    mode: "constat",
  },
  {
    domaine: "risque naturel",
    sujet:
      "seisme recent : magnitude relevee, niveau d'alerte, et ce qui a ete decide sur place",
    mode: "constat",
  },
  {
    domaine: "technologie",
    sujet:
      "prepublications recentes en apprentissage automatique : ce qui est depose, et ce qu'aucun comite de lecture n'a encore relu",
    mode: "constat",
  },
  {
    domaine: "institutions",
    sujet:
      "communiques recents des banques centrales : Reserve federale et Banque du Japon",
    mode: "constat",
  },


  // --- Prospectifs : conditions observables, jamais des previsions --------
  {
    domaine: "banques centrales",
    sujet:
      "ce qu'impliquerait un maintien du taux directeur americain au-dessus de 4 pour cent",
    mode: "prospectif",
  },
  {
    domaine: "geopolitique",
    sujet:
      "ce qu'impliquerait une poursuite du rythme actuel de designations de sanctions",
    mode: "prospectif",
  },
  {
    domaine: "macro",
    sujet:
      "consequences d'une inflation en zone euro qui resterait au niveau du dernier releve",
    mode: "prospectif",
  },
  {
    domaine: "risque naturel",
    sujet:
      "exposition economique si l'activite sismique observee se poursuivait au meme rythme",
    mode: "prospectif",
  },
  {
    domaine: "banques centrales",
    sujet:
      "trajectoire du bilan de la Reserve federale si le rythme observe se maintient",
    mode: "prospectif",
  },
  {
    domaine: "humanitaire",
    sujet:
      "ce que supposerait le maintien du niveau d'alerte actuel sur les zones deja touchees",
    mode: "prospectif",
  },
  {
    domaine: "macro",
    sujet:
      "ce qui suivrait si la croissance mondiale se maintenait au rythme du dernier releve",
    mode: "prospectif",
  },
  {
    domaine: "technologie",
    sujet:
      "ce qu'impliquerait le maintien du rythme actuel de publication des versions et des modeles ouverts",
    mode: "prospectif",
  },
  {
    domaine: "technologie",
    sujet:
      "ce que supposerait une diffusion durable au niveau de telechargements actuellement mesure",
    mode: "prospectif",
  },
];

const CONSTATS = THEMES.filter((t) => t.mode === "constat");
const PROSPECTIFS = THEMES.filter((t) => t.mode === "prospectif");

/** Repartition d'une vague : quatre constats, deux prospectifs. */
const PART_CONSTATS = 4;
const PART_PROSPECTIFS = TAILLE_VAGUE - PART_CONSTATS;

/**
 * Compose la vague numero `index`.
 *
 * DETERMINISTE : meme index, meme vague. Une vague reproductible se rejoue et
 * se compare ; un tirage aleatoire rendrait tout diagnostic impossible apres
 * coup, puisqu'on ne saurait plus ce qui avait ete demande.
 *
 * La rotation utilise le modulo, donc elle boucle proprement : le catalogue est
 * fini, et rendre des sujets vides au bout de quelques jours serait pire que
 * de les reprendre.
 */
export function composerVague(index: number): readonly Theme[] {
  const prendre = (source: readonly Theme[], combien: number, depart: number) =>
    Array.from({ length: combien }, (_, i) => {
      const t = source[(depart + i) % source.length];
      if (t === undefined) throw new Error("catalogue de themes vide");
      return t;
    });

  return [
    ...prendre(CONSTATS, PART_CONSTATS, index * PART_CONSTATS),
    ...prendre(PROSPECTIFS, PART_PROSPECTIFS, index * PART_PROSPECTIFS),
  ];
}

/* -------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------- */

export interface LigneDeVague {
  sujet: string;
  domaine: string;
  mode: ArticleMode;
  etat: "publie" | "arrete" | "erreur";
  /** Motif d'arret ou message d'erreur. Vide si publie. */
  motif: string;
  articleId?: string;
}

export interface RapportDeVague {
  index: number;
  publies: number;
  arretes: number;
  erreurs: readonly string[];
  lignes: readonly LigneDeVague[];
}

export interface ExecuterVagueOptions {
  index: number;
  /** Produit un article pour un sujet. Injecte, donc testable sans reseau. */
  executer: (sujet: Theme) => Promise<PipelineResult>;
  onProgres?: (fait: number, total: number, sujet: Theme) => void;
}

/**
 * Execute une vague, sujet par sujet.
 *
 * SEQUENTIEL et non parallele. Six pipelines simultanes multiplieraient par six
 * la charge par minute chez le fournisseur — ce qui, sur un palier gratuit,
 * garantit le rejet. Une vague lente qui aboutit vaut mieux qu'une vague rapide
 * qui echoue.
 *
 * AUCUN echec n'interrompt la vague. Le gate refuse regulierement des articles,
 * c'est son travail ; et un fournisseur qui tombe au milieu ne doit pas
 * emporter les sujets suivants.
 */
export async function executerVague(
  options: ExecuterVagueOptions,
): Promise<RapportDeVague> {
  const sujets = composerVague(options.index);
  const lignes: LigneDeVague[] = [];
  const erreurs: string[] = [];

  for (const [i, sujet] of sujets.entries()) {
    try {
      const r = await options.executer(sujet);
      if (r.status === "published") {
        lignes.push({
          sujet: sujet.sujet,
          domaine: sujet.domaine,
          mode: sujet.mode,
          etat: "publie",
          motif: "",
          articleId: r.article.id,
        });
      } else {
        lignes.push({
          sujet: sujet.sujet,
          domaine: sujet.domaine,
          mode: sujet.mode,
          etat: "arrete",
          motif: `${r.stage} — ${r.reason}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      erreurs.push(`${sujet.sujet} : ${message}`);
      lignes.push({
        sujet: sujet.sujet,
        domaine: sujet.domaine,
        mode: sujet.mode,
        etat: "erreur",
        motif: message,
      });
    }
    options.onProgres?.(i + 1, sujets.length, sujet);
  }

  return {
    index: options.index,
    publies: lignes.filter((l) => l.etat === "publie").length,
    arretes: lignes.filter((l) => l.etat === "arrete").length,
    erreurs,
    lignes,
  };
}
