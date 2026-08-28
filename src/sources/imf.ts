/**
 * Adaptateur REEL — FMI, API DataMapper (tier 1, sans clef).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement). Comme tout
 * adaptateur, aucun acces au journal d'audit ni au registre de tiers.
 *
 * DIFFICULTE PROPRE A CETTE SOURCE, ET ELLE EST EDITORIALE
 *
 * Les series du World Economic Outlook melangent des valeurs OBSERVEES et des
 * PROJECTIONS, jusqu'a cinq ans dans le futur — et l'API ne dit pas lesquelles
 * sont lesquelles. Un adaptateur naif publierait donc la derniere valeur de la
 * serie comme un fait alors qu'il s'agit d'une prevision a six ans.
 *
 * Sous le §3, une projection est un `scénario`, jamais un `fait`. Cet
 * adaptateur separe donc les deux :
 *
 *  - l'observation retenue est la derniere annee STRICTEMENT anterieure a
 *    l'annee en cours ;
 *  - les annees suivantes sont comptees et annoncees comme projections dans le
 *    resume, pour que l'analyste ne puisse pas les confondre.
 *
 * Reserve declaree explicitement : meme la derniere annee "observee" du WEO
 * peut etre une estimation du FMI plutot qu'un chiffre definitif. L'API ne
 * permet pas de le savoir. Le resume le dit, plutot que de laisser croire a
 * une certitude que la source ne fournit pas (EP-003).
 */

import { SourceFetchError, buildUrl, fetchJson, formatMeasure } from "./http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT = "https://www.imf.org/external/datamapper/api/v1";
const SOURCE_NAME = "FMI (World Economic Outlook)";

/** `{ values: { <indicateur>: { <ISO3>: { <annee>: number } } } }`. */
interface ImfPayload {
  values?: Record<string, Record<string, Record<string, number>> | undefined>;
}

export interface ImfAdapterOptions {
  /** Code ISO-3 (ex : "FRA", "DEU", "USA"). */
  country: string;
  /** Indicateur DataMapper (ex : "NGDP_RPCH" = croissance du PIB reel). */
  indicator: string;
  /** Libelle lisible de l'indicateur, pour le resume. */
  label: string;
}

export function imfAdapter(options: ImfAdapterOptions): SourceAdapter {
  return {
    id: `imf:${options.country}:${options.indicator}`,
    describes: `${options.label} pour ${options.country} (FMI, WEO)`,

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      // Le filtre pays du chemin est actuellement ignore par l'API, qui rend
      // l'indicateur pour tous les pays (~120 Ko). On conserve malgre tout la
      // forme documentee de l'URL — c'est l'intention interrogee — et on
      // extrait le pays cote client.
      const requestedUrl = buildUrl(
        `${API_ROOT}/${encodeURIComponent(options.indicator)}` +
          `/${encodeURIComponent(options.country)}`,
        {},
      );

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });
      const payload = raw as ImfPayload;
      const series = payload.values?.[options.indicator]?.[options.country];

      if (series === undefined || Object.keys(series).length === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucune serie pour ${options.indicator} sur ${options.country} ` +
            `(code pays ISO-3 ou indicateur inconnu ?)`,
        );
      }

      const currentYear = new Date().getUTCFullYear();
      const years = Object.keys(series)
        .map(Number)
        .filter((y) => Number.isFinite(y))
        .sort((a, b) => a - b);

      const observedYears = years.filter((y) => y < currentYear);
      const projectedYears = years.filter((y) => y >= currentYear);
      const latestObserved = observedYears.at(-1);

      if (latestObserved === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `la serie ne contient que des projections (${years.at(0)}-${years.at(-1)}) : ` +
            `aucune valeur observee a publier`,
        );
      }

      const value = series[String(latestObserved)];
      if (value === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `valeur manquante pour l'annee ${latestObserved}`,
        );
      }

      const projectionNote =
        projectedYears.length > 0
          ? ` La serie contient egalement ${projectedYears.length} annee(s) de PROJECTIONS ` +
            `(${projectedYears.at(0)}-${projectedYears.at(-1)}), qui ne sont pas des donnees observees.`
          : "";

      return {
        requestedUrl,
        raw,
        observations: [
          {
            source: SOURCE_NAME,
            url: `https://www.imf.org/external/datamapper/${options.indicator}@WEO/${options.country}`,
            date_observed: new Date().toISOString(),
            // L'API DataMapper ne date pas la publication de la serie. On ne
            // fabrique pas une date : §8 interdit d'inventer comme de supprimer.
            date_published: null,
            type: "donnee-macro",
            resume:
              `${options.label} — ${options.country} : ${formatMeasure(value)} ` +
              `pour ${latestObserved}, derniere annee anterieure a l'annee en cours.` +
              projectionNote +
              ` Reserve : le WEO peut publier une estimation plutot qu'un chiffre ` +
              `definitif pour l'annee la plus recente, et l'API ne permet pas de ` +
              `distinguer les deux.`,
          },
        ],
      };
    },
  };
}
