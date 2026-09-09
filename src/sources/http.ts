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
 * TROIS PROTECTIONS, chacune ajoutee apres avoir constate la faille dans ce
 * fichier meme. Elles vivent ICI et non dans chaque adaptateur : une garantie
 * qu'un adaptateur peut oublier n'est pas une garantie.
 *
 * 1. CAVIARDAGE DES SECRETS DANS LES ERREURS. Le message contenait l'URL
 *    interrogee — utile au diagnostic, et suppose sans risque parce que le
 *    journal d'audit caviarde ce qu'il enregistre. C'etait faux : le message
 *    d'un adaptateur en echec remonte AUSSI dans `CollectionResult.failures`,
 *    puis dans les incertitudes declarees de l'article, donc dans le markdown
 *    publie, sur le site, et dans `articles/` qui est versionne. La clef FRED
 *    voyage dans l'URL et FRED a deja rendu un HTTP 502 pendant une collecte
 *    reelle : la clef serait partie sur un depot public. Le caviardage est donc
 *    applique a la CONSTRUCTION de l'erreur, pas au moment de la journaliser.
 *
 * 2. REDIRECTIONS VALIDEES SAUT PAR SAUT (SSRF). `fetch` les suit par defaut.
 *    Une source compromise ou un redirecteur ouvert pouvait donc faire
 *    interroger 169.254.169.254 ou 127.0.0.1:5173 — le studio, qui declenche
 *    des appels factures — par notre propre infrastructure. `protocol/url.ts`
 *    refusait deja ces hotes pour les URLs CITEES ; rien ne les refusait pour
 *    les URLs APPELEES.
 *
 * 3. PLAFOND DE TAILLE. `await response.text()` sur un corps demesure epuise la
 *    memoire. Verifie en test : un flux de 12 Mo de `<item>` repetes a tue le
 *    worker avant meme qu'une assertion s'execute — la regex d'extraction RSS
 *    part en explosion combinatoire. Le plafond s'applique AVANT que le texte
 *    n'atteigne l'analyse, ce qui protege les deux.
 */

import { redactText, redactUrl } from "../audit/redaction.js";
import { isCitableUrl } from "../protocol/url.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Plafond de corps de reponse, en octets.
 *
 * 8 Mo : large devant tout ce que le catalogue consomme reellement (le plus
 * gros mesure est le H.4.1 a 172 Ko ; la liste OFAC complete ferait 5,6 Mo mais
 * on n'utilise que les deltas a 11 Ko) et assez bas pour qu'un corps hostile ne
 * fasse pas tomber le processus.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Sauts de redirection autorises. Au-dela, c'est une boucle ou un piege. */
export const MAX_REDIRECTS = 3;

export class SourceFetchError extends Error {
  readonly sourceName: string;
  readonly requestedUrl: string;
  readonly status: number | undefined;

  constructor(
    sourceName: string,
    requestedUrl: string,
    detail: string,
    status?: number,
  ) {
    // Caviardage a la SOURCE. Le faire plus tard supposerait que tous les
    // consommateurs de cette erreur y pensent ; l'un d'eux ne le faisait pas,
    // et c'est celui qui publiait.
    const url = redactUrl(requestedUrl).redacted;
    const texte = redactText(detail).redacted;
    super(`${sourceName} : ${texte} (${url})`);
    this.name = "SourceFetchError";
    this.sourceName = sourceName;
    this.requestedUrl = url;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------
 * Acces reseau confine
 * ---------------------------------------------------------------------- */

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Interroge une URL en validant CHAQUE saut de redirection.
 *
 * `redirect: "manual"` est le coeur du dispositif : en mode `follow`, la
 * requete vers l'hote interne est deja partie quand on decouvre ou elle a
 * atterri. Ici chaque cible est verifiee AVANT d'etre appelee.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  sourceName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  let cible = url;

  for (let saut = 0; saut <= MAX_REDIRECTS; saut += 1) {
    if (!isCitableUrl(cible)) {
      throw new SourceFetchError(
        sourceName,
        cible,
        saut === 0
          ? "URL de source non appelable : schema interdit, identifiants integres ou hote non routable"
          : "redirection refusee : la cible n'est pas un hote public (hote non routable ou schema interdit)",
      );
    }

    // HTTPS EXIGE, et ce n'est pas une precaution generale.
    //
    // Interroger une source en clair, c'est laisser un tiers sur le chemin
    // modifier la donnee AVANT qu'elle fonde une claim. Pour un media dont
    // toute la promesse est la preuve, c'est disqualifiant : on publierait
    // comme observe ce qu'un intermediaire a ecrit, et le journal d'audit
    // archiverait fidelement la falsification.
    //
    // Le controle porte sur CHAQUE saut : le cas realiste n'est pas une source
    // en clair — le catalogue n'en contient aucune — mais une source en https
    // qui redirige vers du clair.
    if (!cible.toLowerCase().startsWith("https:")) {
      throw new SourceFetchError(
        sourceName,
        cible,
        saut === 0
          ? "source en clair refusee : une donnee collectee en http peut etre " +
            "alteree en transit, donc ne peut pas fonder une claim (§2)"
          : "redirection refusee : retrogradation vers du clair (http), la " +
            "donnee cessant d'etre protegee en transit",
      );
    }

    let reponse: Response;
    try {
      reponse = await fetch(cible, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const detail =
        cause.name === "TimeoutError" || cause.name === "AbortError"
          ? `pas de reponse en ${timeoutMs} ms`
          : `echec reseau — ${cause.message}`;
      throw new SourceFetchError(sourceName, cible, detail);
    }

    if (!REDIRECT_CODES.has(reponse.status)) return reponse;

    const location = reponse.headers?.get?.("location");
    if (location === null || location === undefined || location.length === 0) {
      throw new SourceFetchError(
        sourceName,
        cible,
        `redirection ${reponse.status} sans en-tete Location`,
        reponse.status,
      );
    }

    try {
      cible = new URL(location, cible).toString();
    } catch {
      throw new SourceFetchError(
        sourceName,
        cible,
        `redirection refusee : cible illisible (${location.slice(0, 80)})`,
      );
    }
  }

  throw new SourceFetchError(
    sourceName,
    url,
    `plus de ${MAX_REDIRECTS} redirections successives`,
  );
}

/**
 * Lit un corps de reponse en refusant de depasser le plafond.
 *
 * Deux controles, parce qu'un serveur hostile ment. `content-length` arrete la
 * lecture avant qu'elle commence quand il est annonce ; le comptage a la
 * lecture couvre le cas ou il est absent, faux, ou l'encodage segmente.
 *
 * Le repli sur `text()` sert les bouchons de test qui n'exposent pas de flux :
 * un test ne doit pas avoir a simuler tout `Response` pour verifier autre chose.
 */
export async function readBodyCapped(
  reponse: Response,
  sourceName: string,
  url: string,
): Promise<string> {
  const annonce = Number(reponse.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(annonce) && annonce > MAX_RESPONSE_BYTES) {
    throw new SourceFetchError(
      sourceName,
      url,
      `reponse trop volumineuse : ${annonce} octets annonces pour un plafond de ${MAX_RESPONSE_BYTES}`,
      reponse.status,
    );
  }

  const flux = reponse.body;
  if (flux === null || flux === undefined) return await reponse.text();

  const lecteur = flux.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await lecteur.cancel();
      throw new SourceFetchError(
        sourceName,
        url,
        `reponse trop volumineuse : plafond de ${MAX_RESPONSE_BYTES} octets depasse a la lecture`,
        reponse.status,
      );
    }
    morceaux.push(value);
  }

  const assemble = new Uint8Array(total);
  let position = 0;
  for (const morceau of morceaux) {
    assemble.set(morceau, position);
    position += morceau.byteLength;
  }
  return new TextDecoder().decode(assemble);
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
  // `safeFetch` porte le timeout, la validation des redirections et la
  // distinction timeout / panne reseau (§5.2 : savoir POURQUOI une source est
  // muette).
  const response = await safeFetch(
    url,
    {
      headers: {
        accept: "application/json",
        // Plusieurs APIs publiques (ReliefWeb, GDELT) exigent ou tracent un
        // agent identifiable. S'annoncer est aussi la moindre des politesses
        // envers un service gratuit.
        "user-agent": "media-next-gen (pipeline editorial)",
      },
    },
    options.sourceName,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new SourceFetchError(
      options.sourceName,
      url,
      `HTTP ${response.status}`,
      response.status,
    );
  }

  const text = await readBodyCapped(response, options.sourceName, url);
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
