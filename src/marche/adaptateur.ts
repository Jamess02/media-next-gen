/**
 * Le PONT : un connecteur de marche devient un adaptateur de la passerelle.
 *
 * Dependances internes : `protocol/sources-de-marche.ts` (formule
 * d'attribution, emetteur d'un signal), `sources/http.ts` (SourceFetchError,
 * formatMeasure), `sources/types.ts` (contrat d'adaptateur), `garde-fous.ts`,
 * `instruments.ts`, `types.ts`. Aucune dependance npm.
 *
 * POURQUOI UN PONT, ET PAS UN CHEMIN PARALLELE
 *
 * La passerelle des sources impose deja ce qu'une donnee de marche doit subir
 * comme toute autre : journalisation de l'URL et de la reponse brute (§9.4),
 * tier derive du domaine (§4), caviardage, filtre d'injection. Un canal
 * direct vers les agents y echapperait. Le pont se contente d'ajouter ce qui
 * est propre au marche, pour TOUT connecteur present ou futur :
 *
 *  - la reference commune : minuit UTC du jour ;
 *  - les garde-fous sur chaque point — un connecteur ne peut pas les oublier ;
 *  - un resume qui dit l'unite, le perimetre, les reserves, et la formule
 *    d'attribution, DEMANDEE au registre plutot que recopiee : consigne et
 *    controle ne peuvent pas diverger.
 */

import {
  emetteurAttendu,
  formuleDAttribution,
  sourceDeMarche,
} from "../protocol/sources-de-marche.js";
import { SourceFetchError, formatMeasure } from "../sources/http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "../sources/types.js";
import { verifierPoint } from "./garde-fous.js";
import { normaliserSujet, type Instrument } from "./instruments.js";
import type { ConnecteurDeMarche, PointDeMarche, ReleveDeMarche } from "./types.js";

/** Une semaine : aucun article ne veut d'un chiffre de marche plus vieux. */
const AGE_MAX_PAR_DEFAUT_MS = 7 * 86_400_000;

export interface OptionsDuPont {
  /** Heure courante, injectable pour les tests. */
  maintenant?: () => Date;
  /** Age maximal d'une donnee avant qu'elle soit refusee comme perimee. */
  ageMaxMs?: number;
}

/** Minuit UTC du jour de `d` : la reference commune de tous les releves. */
export function minuitUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Ordre de grandeur d'un tres grand nombre, marque « ≈ » : c'est un arrondi
 * annonce, pas une precision inventee (EP-005). Il evite au redacteur de
 * convertir lui-meme « 1188117943.77 » — c'est a la conversion que les
 * erreurs d'un facteur mille se glissent.
 */
function ordreDeGrandeur(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) {
    const x = v / 1e9;
    return ` (≈ ${formatMeasure(x)} ${Math.abs(x) < 2 ? "milliard" : "milliards"})`;
  }
  if (a >= 1e6) {
    const x = v / 1e6;
    return ` (≈ ${formatMeasure(x)} ${Math.abs(x) < 2 ? "million" : "millions"})`;
  }
  return "";
}

const majuscule = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function perimetreEnClair(p: PointDeMarche): string {
  return p.perimetre.type === "plateforme-unique"
    ? `Perimetre : ${p.perimetre.plateforme} seule — ces chiffres ne valent que pour ` +
        `${p.perimetre.plateforme}, et ne disent rien des autres plateformes ni du marche mondial.`
    : `Perimetre : agregat — ${p.perimetre.methode}.`;
}

/** Resume lu par le Veilleur et l'Analyste. Tout ce qui s'y trouve vient du releve. */
function rendreResume(releve: ReleveDeMarche, instrument: Instrument): string {
  const p0 = releve.points[0] as PointDeMarche;
  const morceaux: string[] = [];

  if (p0.usage === "signal") {
    const e = emetteurAttendu(releve.url);
    morceaux.push(
      `SIGNAL DE PRE-VERIFICATION — NE PAS CITER. ${p0.source} relaie cette donnee ` +
        `sans en etre l'emetteur. Source a citer : ` +
        `${e === null ? "l'emetteur d'origine" : `${e.nom} (${e.domaine})`}, ou le ` +
        `chiffre doit etre verifie avant toute publication.`,
    );
  }

  morceaux.push(
    `${p0.source} — ${instrument.libelle} (${p0.instrument}). ` +
      releve.points
        .map((p) => `${majuscule(p.mesure)} : ${formatMeasure(p.valeur)} ${p.unite}${ordreDeGrandeur(p.valeur)}`)
        .join(" ; ") +
      ".",
  );
  morceaux.push(perimetreEnClair(p0));

  const registre = sourceDeMarche(releve.url);
  if (registre !== null && registre.usage === "citable") {
    morceaux.push(
      `A la publication, ecrire « ${formuleDAttribution(registre)} » : ${registre.raison}`,
    );
  }
  if (p0.reserves.length > 0) morceaux.push(`Reserves : ${p0.reserves.join(" ")}`);

  morceaux.push(
    `Horodatage de la donnee : ${p0.horodatageDonnee} ; releve le ${p0.horodatageRequete}` +
      (releve.depuisLeCache
        ? " (servi depuis le cache local : c'est la date de la requete d'origine)."
        : "."),
  );
  return morceaux.join(" ");
}

export function adaptateurDeMarche(
  connecteur: ConnecteurDeMarche,
  instrument: Instrument,
  options: OptionsDuPont = {},
): SourceAdapter {
  const maintenant = options.maintenant ?? (() => new Date());
  const ageMaxMs = options.ageMaxMs ?? AGE_MAX_PAR_DEFAUT_MS;

  return {
    id: `${connecteur.id}:${instrument.id}`,
    describes: `${connecteur.nom} — ${instrument.libelle}`,

    pertinent: (query: SourceQuery) => instrument.motifs.test(normaliserSujet(query.topic)),

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      const t = maintenant();
      const releve = await connecteur.releve(instrument, minuitUtc(t));

      const p0 = releve.points[0];
      if (p0 === undefined) {
        throw new SourceFetchError(
          connecteur.nom,
          releve.url,
          "donnee indisponible — releve vide : le fournisseur n'a rendu aucun point",
        );
      }

      const motifs = releve.points
        .map((p) => verifierPoint(p, t, { ageMaxMs }))
        .filter((m): m is string => m !== null);
      if (motifs.length > 0) {
        throw new SourceFetchError(
          connecteur.nom,
          releve.url,
          `donnee aberrante ecartee — ${motifs.join(" ; ")}`,
        );
      }

      const signal = p0.usage === "signal";
      return {
        requestedUrl: releve.url,
        // L'archive dit d'ou vient la reponse : le journal date sa propre
        // ecriture, pas la requete — sans ce champ, un releve servi depuis le
        // cache passerait pour une observation du jour.
        raw: {
          depuisLeCache: releve.depuisLeCache,
          horodatageRequete: p0.horodatageRequete,
          reponse: releve.brut,
        },
        observations: [
          {
            source: signal ? `${p0.source} (signal)` : p0.source,
            url: releve.url,
            date_observed: p0.horodatageRequete,
            date_published: p0.horodatageDonnee,
            type: signal ? "signal-de-marche" : "donnee-de-marche",
            resume: rendreResume(releve, instrument),
          },
        ],
      };
    },
  };
}
