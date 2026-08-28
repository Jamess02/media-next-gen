/**
 * Acces HTTP commun aux adaptateurs de sources.
 *
 * Module feuille : aucun import interne, aucune dependance npm. `fetch` et
 * `AbortSignal.timeout` sont globaux depuis Node 18 — pas besoin d'axios ni de
 * p-timeout pour ce que fait ce fichier.
 *
 * Pourquoi centraliser : sans lui, chaque adaptateur redupliquerait le timeout,
 * la verification du statut et le parsing. Ces trois points sont exactement la
 * ou une source se comporte mal en silence :
 *
 *  - une API qui repond 200 avec un corps d'erreur (la Banque mondiale le fait) ;
 *  - une API qui ne repond jamais (sans timeout, le pipeline pend) ;
 *  - une API qui renvoie du HTML de maintenance a la place du JSON.
 *
 * Les messages d'erreur contiennent l'URL interrogee, ce qui est utile au
 * diagnostic ET sans risque : le journal d'audit caviarde les secrets des URLs
 * qu'il enregistre, y compris dans le champ `error` (voir audit/redaction.ts).
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export class SourceFetchError extends Error {
  constructor(
    readonly sourceName: string,
    readonly requestedUrl: string,
    detail: string,
    readonly status?: number,
  ) {
    super(`${sourceName} : ${detail} (${requestedUrl})`);
    this.name = "SourceFetchError";
  }
}

export interface FetchJsonOptions {
  /** Nom lisible de la source, pour des messages d'erreur exploitables. */
  sourceName: string;
  timeoutMs?: number;
}

/**
 * Interroge une API JSON. Rend la charge utile brute, non typee : c'est a
 * l'adaptateur de la valider, parce que lui seul connait la forme attendue.
 */
export async function fetchJson(
  url: string,
  options: FetchJsonOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        // Plusieurs APIs publiques (ReliefWeb, GDELT) exigent ou tracent un
        // agent identifiable. S'annoncer est aussi la moindre des politesses
        // envers un service gratuit.
        "user-agent": "media-next-gen (pipeline editorial)",
      },
    });
  } catch (error) {
    // Distinguer un timeout d'une panne reseau : les deux se corrigent
    // differemment, et le §5.2 demande de savoir pourquoi une source est muette.
    const cause = error instanceof Error ? error : new Error(String(error));
    const detail =
      cause.name === "TimeoutError" || cause.name === "AbortError"
        ? `pas de reponse en ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
        : `echec reseau — ${cause.message}`;
    throw new SourceFetchError(options.sourceName, url, detail);
  }

  if (!response.ok) {
    throw new SourceFetchError(
      options.sourceName,
      url,
      `HTTP ${response.status}`,
      response.status,
    );
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Une page de maintenance en HTTP 200 est un cas courant. Le message
    // reprend le debut du corps : sans lui, "JSON invalide" n'aide personne.
    throw new SourceFetchError(
      options.sourceName,
      url,
      `reponse non-JSON (${text.slice(0, 120).replace(/\s+/g, " ")}...)`,
      response.status,
    );
  }
}

/**
 * Construit une URL a partir de parametres. Les valeurs sont encodees, les
 * parametres `undefined` omis — ce qui evite les `&param=undefined` qui
 * partiraient sinon telles quelles dans le journal d'audit.
 */
export function buildUrl(
  base: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  return query.length > 0 ? `${base}?${query}` : base;
}

/**
 * EP-005 — "Pas d'illusion de precision."
 *
 * Les APIs rendent des flottants bruts (`2.46705543774613`). Ces decimales sont
 * un artefact de representation binaire, pas une mesure. Republier le nombre
 * tel quel affirmerait une precision qui n'existe pas.
 *
 * `toFixed` est ecarte : il figerait `3` en `3.00`, inventant des decimales
 * absentes — le defaut symetrique.
 */
export function formatMeasure(value: number, decimals = 2): string {
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor);
}
