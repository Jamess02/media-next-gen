/**
 * Adaptateur REEL — Eurostat, API de dissemination (tier 1, sans clef).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement).
 *
 * FORMAT : JSON-stat 2.0. Les valeurs arrivent a plat, indexees sur le produit
 * cartesien des dimensions declarees dans `id` / `size`. Avec plusieurs
 * dimensions non figees, l'index d'une valeur se calcule en ordre "row-major" —
 * une source d'erreur silencieuse classique : on lit une valeur, elle est
 * plausible, mais elle correspond a une autre combinaison que celle voulue.
 *
 * Choix : cet adaptateur EXIGE que la requete fige toutes les dimensions sauf
 * le temps, et le VERIFIE au lieu de le supposer. Si l'hypothese est fausse, il
 * echoue bruyamment. Publier un chiffre mal indexe serait pire que ne rien
 * publier — c'est tout l'esprit du §2.
 */

import { SourceFetchError, buildUrl, fetchJson, formatMeasure } from "./http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT =
  "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const SOURCE_NAME = "Eurostat";

interface JsonStatCategory {
  index?: Record<string, number>;
  label?: Record<string, string>;
}

interface JsonStatDimension {
  label?: string;
  category?: JsonStatCategory;
}

interface JsonStatDataset {
  label?: string;
  updated?: string;
  /** Index de valeur (sous forme de chaine) vers la mesure. Peut etre creux. */
  value?: Record<string, number | null>;
  id?: string[];
  size?: number[];
  dimension?: Record<string, JsonStatDimension>;
}

export interface EurostatAdapterOptions {
  /** Code du jeu de donnees (ex : "prc_hicp_manr" = IPCH, taux annuel). */
  dataset: string;
  /**
   * Filtres figeant les dimensions autres que le temps
   * (ex : `{ geo: "EA", coicop: "CP00" }`).
   */
  filters: Record<string, string>;
  /** Nombre de periodes les plus recentes a recuperer. */
  periods?: number;
  /** Libelle lisible, pour le resume. */
  label: string;
}

export function eurostatAdapter(
  options: EurostatAdapterOptions,
): SourceAdapter {
  const periods = options.periods ?? 6;
  const filterKey = Object.entries(options.filters)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  return {
    id: `eurostat:${options.dataset}:${filterKey}`,
    describes: `${options.label} (Eurostat, ${options.dataset})`,

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      const requestedUrl = buildUrl(
        `${API_ROOT}/${encodeURIComponent(options.dataset)}`,
        { format: "JSON", lastTimePeriod: periods, ...options.filters },
      );

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });
      const dataset = raw as JsonStatDataset;

      const dimensionIds = dataset.id ?? [];
      const sizes = dataset.size ?? [];
      const values = dataset.value ?? {};

      if (dimensionIds.length === 0 || dimensionIds.length !== sizes.length) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `reponse JSON-stat malformee pour ${options.dataset}`,
        );
      }

      // Verification de l'hypothese d'indexation : toute dimension autre que
      // `time` doit etre figee a une seule modalite. Sinon l'index a plat ne
      // correspond plus a la seule position temporelle.
      const notPinned = dimensionIds.filter(
        (id, i) => id !== "time" && (sizes[i] ?? 0) > 1,
      );
      if (notPinned.length > 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `dimensions non figees : ${notPinned.join(", ")}. Ajouter un filtre pour ` +
            `chacune, sinon l'index des valeurs ne peut pas etre interprete de facon fiable`,
        );
      }

      const timeIndex = dataset.dimension?.["time"]?.category?.index;
      if (timeIndex === undefined || Object.keys(timeIndex).length === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `dimension temporelle absente de la reponse`,
        );
      }

      // Periodes triees par index croissant : la derniere est la plus recente.
      const periodsByIndex = Object.entries(timeIndex).sort(
        ([, a], [, b]) => a - b,
      );

      const present = periodsByIndex.filter(([, index]) => {
        const v = values[String(index)];
        return typeof v === "number";
      });
      const missing = periodsByIndex
        .filter(([, index]) => typeof values[String(index)] !== "number")
        .map(([period]) => period);

      const latest = present.at(-1);
      if (latest === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucune valeur renseignee sur les ${periodsByIndex.length} periode(s) interrogee(s)`,
        );
      }

      const [latestPeriod, latestIndex] = latest;
      const value = values[String(latestIndex)] as number;

      const geoCode = options.filters["geo"];
      const geoLabel =
        geoCode === undefined
          ? undefined
          : dataset.dimension?.["geo"]?.category?.label?.[geoCode];

      const coverage =
        `${present.length}/${periodsByIndex.length} periodes renseignees` +
        (missing.length > 0 ? ` (manquantes : ${missing.join(", ")})` : "");

      return {
        requestedUrl,
        raw,
        observations: [
          {
            source: SOURCE_NAME,
            url: `https://ec.europa.eu/eurostat/databrowser/view/${options.dataset}/default/table`,
            date_observed: new Date().toISOString(),
            date_published: toIso(dataset.updated),
            type: "donnee-macro",
            resume:
              `${dataset.label ?? options.label}` +
              (geoLabel === undefined ? "" : ` — ${geoLabel}`) +
              ` : ${formatMeasure(value)} pour ${latestPeriod}. ` +
              `Couverture : ${coverage}. ` +
              `Jeu de donnees mis a jour le ${dataset.updated ?? "date inconnue"}.`,
          },
        ],
      };
    },
  };
}

/** Eurostat rend un ISO-8601 avec decalage ("2026-02-06T23:00:00+0100"). */
function toIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
