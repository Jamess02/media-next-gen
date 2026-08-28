/**
 * Adaptateur REEL — FRED, Federal Reserve Bank of St. Louis (tier 1).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement).
 *
 * SEULE SOURCE DU LOT QUI EXIGE UNE CLEF, ET ELLE TRANSITE PAR L'URL :
 *
 *   https://api.stlouisfed.org/fred/series/observations?series_id=X&api_key=<CLEF>
 *
 * C'est precisement le cas qui a motive `audit/redaction.ts`. Le §9.4 impose de
 * journaliser l'URL exacte, et le journal est versionne : sans caviardage,
 * brancher FRED publierait la clef. Deux chemins sont couverts — l'URL
 * enregistree ET les messages d'erreur, qui la reprennent.
 *
 * La clef est lue depuis l'environnement, jamais ecrite en dur ni passee en
 * argument de ligne de commande (elle apparaitrait dans l'historique du shell
 * et dans la liste des processus).
 *
 * PARTICULARITES DE LA SOURCE
 *
 *  - Les valeurs manquantes valent la chaine "." et non `null` : une conversion
 *    numerique naive les transformerait en 0, ce qui fabriquerait une donnee.
 *  - FRED revise ses series. `realtime_start` indique le millesime interroge ;
 *    le §5.2 demande de reperer les revisions, donc il est remonte.
 */

import { SourceFetchError, buildUrl, fetchJson, formatMeasure } from "./http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT = "https://api.stlouisfed.org/fred/series/observations";
const SOURCE_NAME = "FRED (Fed de St. Louis)";

interface FredObservation {
  date?: string;
  value?: string;
  realtime_start?: string;
}

interface FredPayload {
  observations?: FredObservation[];
  realtime_start?: string;
}

export interface FredAdapterOptions {
  /** Identifiant de serie (ex : "FEDFUNDS", "DGS10", "CPIAUCSL"). */
  seriesId: string;
  /** Libelle lisible, pour le resume. */
  label: string;
  /** Clef d'API FRED. Lue depuis l'environnement par le catalogue. */
  apiKey: string;
  /** Nombre d'observations les plus recentes. */
  limit?: number;
}

export function fredAdapter(options: FredAdapterOptions): SourceAdapter {
  const limit = options.limit ?? 6;

  return {
    id: `fred:${options.seriesId}`,
    describes: `${options.label} (FRED, serie ${options.seriesId})`,

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      const requestedUrl = buildUrl(API_ROOT, {
        series_id: options.seriesId,
        api_key: options.apiKey,
        file_type: "json",
        sort_order: "desc",
        limit,
      });

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });
      const payload = raw as FredPayload;
      const rows = payload.observations;

      if (!Array.isArray(rows)) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `reponse inattendue pour la serie ${options.seriesId}`,
        );
      }

      // FRED code l'absence de donnee par "." — jamais par null. Un
      // `Number(".")` donnerait NaN, et un `parseFloat` laxiste pourrait
      // laisser passer une valeur fabriquee.
      const parsed = rows.map((row) => ({
        date: row.date,
        value:
          typeof row.value === "string" && row.value !== "."
            ? Number(row.value)
            : null,
      }));

      const observed = parsed.filter(
        (r): r is { date: string; value: number } =>
          typeof r.date === "string" && r.value !== null && Number.isFinite(r.value),
      );
      const missing = parsed
        .filter((r) => r.value === null)
        .map((r) => r.date ?? "date inconnue");

      // `sort_order=desc` : la plus recente d'abord.
      const latest = observed[0];
      if (latest === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucune valeur renseignee sur les ${rows.length} observation(s) de ` +
            `${options.seriesId} (toutes marquees "." )`,
        );
      }

      const vintage = latest.date;
      const coverage =
        `${observed.length}/${rows.length} observations renseignees` +
        (missing.length > 0 ? ` (manquantes : ${missing.join(", ")})` : "");

      return {
        requestedUrl,
        raw,
        observations: [
          {
            source: SOURCE_NAME,
            url: `https://fred.stlouisfed.org/series/${options.seriesId}`,
            date_observed: new Date().toISOString(),
            date_published: toIsoDate(vintage),
            type: "donnee-macro",
            resume:
              `${options.label} — serie ${options.seriesId} : ` +
              `${formatMeasure(latest.value)} au ${latest.date}. ` +
              `Couverture : ${coverage}. ` +
              `Millesime interroge : ${payload.realtime_start ?? "non precise"} ` +
              `(FRED revise ses series ; une meme date peut porter une valeur ` +
              `differente selon le millesime).`,
          },
        ],
      };
    },
  };
}

/** FRED rend "2026-08-01" (date seule). Le §7 exige de l'ISO-8601 complet. */
function toIsoDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
