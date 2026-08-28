/**
 * Adaptateur REEL — API Banque mondiale (tier 1, sans clef d'API).
 *
 * Dependances : `http.ts` (fetch mutualise) et `types.ts` (contrat, import de
 * type uniquement). Aucun acces au journal d'audit ni au registre de tiers :
 * un adaptateur ne peut donc ni oublier de journaliser, ni s'auto-attribuer un
 * tier avantageux. Ces deux responsabilites appartiennent a la passerelle.
 *
 * Deux details que le protocole rend obligatoires et qu'un adaptateur naif
 * escamoterait :
 *
 *  - `lastupdated` de l'API devient `date_published`. §5.2 impose de reperer
 *    les delais de publication : sans cette date, on ne peut pas distinguer une
 *    donnee fraiche d'une serie figee depuis deux ans.
 *  - Les annees a valeur `null` sont comptees et signalees, jamais silencieusement
 *    ignorees. Une serie trouee presentee comme complete est une illusion de
 *    precision (EP-005).
 */

import { SourceFetchError, buildUrl, fetchJson, formatMeasure } from "./http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT = "https://api.worldbank.org/v2";
const SOURCE_NAME = "Banque mondiale";

/** Forme du payload Banque mondiale : [metadonnees, observations]. */
interface WorldBankMeta {
  page: number;
  pages: number;
  total: number;
  lastupdated?: string;
}

interface WorldBankPoint {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string;
  value: number | null;
}

export interface WorldBankAdapterOptions {
  /** Code ISO du pays ou de l'agregat (ex : "FR", "WLD", "EMU"). */
  country: string;
  /** Identifiant d'indicateur (ex : "FP.CPI.TOTL.ZG" = inflation annuelle). */
  indicator: string;
  /** Nombre d'annees a remonter. */
  years?: number;
}

export function worldBankAdapter(
  options: WorldBankAdapterOptions,
): SourceAdapter {
  const years = options.years ?? 5;

  return {
    id: `worldbank:${options.country}:${options.indicator}`,
    describes: `Serie annuelle ${options.indicator} pour ${options.country} (Banque mondiale)`,

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      const currentYear = new Date().getUTCFullYear();
      const requestedUrl = buildUrl(
        `${API_ROOT}/country/${encodeURIComponent(options.country)}` +
          `/indicator/${encodeURIComponent(options.indicator)}`,
        {
          format: "json",
          per_page: years,
          date: `${currentYear - years}:${currentYear}`,
        },
      );

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });

      // L'API repond 200 avec un objet d'erreur en cas d'indicateur inconnu :
      // on ne peut pas se fier au seul code HTTP.
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `reponse inattendue pour ${options.indicator} (indicateur ou pays inconnu ?)`,
        );
      }

      const meta = raw[0] as WorldBankMeta;
      const points = (raw[1] ?? []) as WorldBankPoint[];

      const observed = points.filter(
        (p): p is WorldBankPoint & { value: number } => p.value !== null,
      );
      const missingYears = points
        .filter((p) => p.value === null)
        .map((p) => p.date);

      // Les points arrivent du plus recent au plus ancien.
      const latest = observed[0];
      if (latest === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucune valeur non nulle pour ${options.indicator} sur ${options.country} ` +
            `(${points.length} annee(s) interrogee(s))`,
        );
      }

      const coverage =
        `${observed.length}/${points.length} annees renseignees` +
        (missingYears.length > 0
          ? ` (manquantes : ${missingYears.join(", ")})`
          : "");

      return {
        requestedUrl,
        raw,
        observations: [
          {
            source: SOURCE_NAME,
            // URL citable par le lecteur, distincte de l'URL d'API interrogee.
            url:
              `https://data.worldbank.org/indicator/${options.indicator}` +
              `?locations=${options.country}`,
            date_observed: new Date().toISOString(),
            date_published: toIsoDate(meta.lastupdated),
            type: "donnee-macro",
            resume:
              `${latest.indicator.value} — ${latest.country.value} : ` +
              `${formatMeasure(latest.value)} (${latest.date}). ` +
              `Couverture : ${coverage}. ` +
              `Serie mise a jour le ${meta.lastupdated ?? "date inconnue"}.`,
          },
        ],
      };
    },
  };
}

/**
 * La Banque mondiale rend "2026-07-13" (date seule). Le §7 exige de l'ISO-8601
 * complet : on normalise sans inventer d'heure precise autre que minuit UTC.
 */
function toIsoDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
