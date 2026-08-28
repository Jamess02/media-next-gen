/**
 * Caviardage des secrets dans les URLs journalisees.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le §9.4 impose de journaliser "l'URL exacte interrogee", et `journal.jsonl`
 * est versionne : c'est la trace de preuve, elle doit survivre au projet.
 * Or plusieurs sources du §4 passent leur clef d'API DANS l'URL :
 *
 *   https://api.stlouisfed.org/fred/series?series_id=X&api_key=<CLEF>
 *
 * Sans caviardage, brancher FRED reviendrait a commiter sa clef. Dans un depot
 * public, elle serait lisible par tous — et le restera dans l'historique Git
 * meme apres suppression du fichier.
 *
 * CE QUE LE CAVIARDAGE PRESERVE
 *
 * L'URL reste exacte partout ailleurs : hote, chemin, ordre et encodage des
 * parametres sont conserves octet pour octet. Seule la VALEUR des parametres
 * reconnus comme secrets est remplacee. Le journal declare ensuite quels
 * parametres ont ete caviardes : une URL alteree en silence ne serait plus une
 * preuve, elle serait un artefact.
 *
 * ARBITRAGE ASSUME
 *
 * La detection est volontairement large. Caviarder par exces un parametre
 * anodin abime la lisibilite du journal ; laisser passer une clef la publie
 * definitivement. Le cout des deux erreurs n'est pas comparable.
 *
 * PORTEE
 *
 * Ce module protege `journal.jsonl` (versionne). Les archives brutes de
 * `audit/raw/` ne sont PAS caviardees — leur raison d'etre est la fidelite
 * integrale pour l'audit — et peuvent donc contenir des secrets. C'est pour
 * cela qu'elles restent exclues du versionnement (voir .gitignore).
 */

export const REDACTED = "***CAVIARDE***";

/**
 * Noms de parametres traites comme secrets. Compares apres normalisation
 * (minuscules, separateurs `-` `_` `.` retires), donc `api_key`, `API-KEY` et
 * `apiKey` correspondent tous a `apikey`.
 */
const SECRET_PARAM_NAMES: ReadonlySet<string> = new Set([
  "apikey",
  // `key` seul est la forme employee par plusieurs APIs publiques (Google
  // notamment) pour transporter la clef : on le traite comme secret.
  "key",
  "token",
  "auth",
  "authorization",
  "password",
  "passwd",
  "pwd",
  "secret",
  "credential",
  "credentials",
  "signature",
  "sig",
  "accesskey",
  "privatekey",
  "subscriptionkey",
  "appkey",
]);

/**
 * Suffixes declenchant le caviardage (`access_token`, `client_secret`...).
 *
 * `key` n'y figure PAS a dessein : en suffixe il attraperait `sort_key` ou
 * `cache_key`, qui n'ont rien de secret. Il reste couvert en nom exact.
 */
const SECRET_PARAM_SUFFIXES: readonly string[] = [
  "apikey",
  "token",
  "secret",
  "password",
];

function normalize(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Nom mal encode : on travaille sur la forme brute plutot que d'echouer.
  }
  return decoded.toLowerCase().replace(/[-_.]/g, "");
}

export function isSecretParam(name: string): boolean {
  const normalized = normalize(name);
  if (SECRET_PARAM_NAMES.has(normalized)) return true;
  return SECRET_PARAM_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export interface RedactionResult {
  /** URL caviardee, identique a l'originale hors valeurs secretes. */
  redacted: string;
  /** Noms des parametres caviardes. Vide si l'URL ne contenait aucun secret. */
  redactedParams: string[];
}

/**
 * Caviarde les identifiants d'une URL : parametres de requete secrets, et
 * mot de passe d'un eventuel `user:password@hote`.
 *
 * Volontairement fonde sur du traitement de chaine plutot que sur `new URL()` :
 * `URL` normalise et reencode, ce qui modifierait l'URL au-dela des seules
 * valeurs secretes. Le §9.4 demande l'URL exacte.
 */
export function redactUrl(url: string): RedactionResult {
  const found = new Set<string>();

  // 1. Identifiants dans l'autorite : https://user:motdepasse@hote/...
  let working = url.replace(
    /^(\w+:\/\/)([^/?#@]*)@/,
    (_match, scheme: string, userInfo: string) => {
      const separator = userInfo.indexOf(":");
      if (separator < 0) return `${scheme}${userInfo}@`;
      found.add("userinfo:password");
      return `${scheme}${userInfo.slice(0, separator)}:${REDACTED}@`;
    },
  );

  // 2. Parametres de requete. Le fragment est isole d'abord : ce qui suit un
  //    `#` n'appartient pas a la chaine de requete.
  const hashIndex = working.indexOf("#");
  const fragment = hashIndex >= 0 ? working.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? working.slice(0, hashIndex) : working;

  const queryIndex = base.indexOf("?");
  if (queryIndex < 0) {
    return { redacted: working, redactedParams: [...found] };
  }

  const head = base.slice(0, queryIndex + 1);
  const query = base.slice(queryIndex + 1);

  const parts = query.split("&").map((part) => {
    const equals = part.indexOf("=");
    if (equals < 0) return part;
    const name = part.slice(0, equals);
    if (!isSecretParam(name)) return part;
    found.add(normalize(name));
    // Le nom est conserve tel quel : savoir QUEL parametre portait le secret
    // fait partie de la trace.
    return `${name}=${REDACTED}`;
  });

  working = head + parts.join("&") + fragment;
  return { redacted: working, redactedParams: [...found] };
}

const URL_IN_TEXT = /\b\w+:\/\/[^\s"'<>)\]},]+/g;

/**
 * Caviarde les URLs contenues dans un texte libre.
 *
 * Indispensable pour les messages d'erreur : un adaptateur qui leve
 * `HTTP 503 sur https://api...?api_key=SECRET` ferait autrement transiter la
 * clef par le champ `error` du journal, contournant le caviardage de `target`.
 */
export function redactText(text: string): RedactionResult {
  const found = new Set<string>();
  const redacted = text.replace(URL_IN_TEXT, (url) => {
    const result = redactUrl(url);
    for (const param of result.redactedParams) found.add(param);
    return result.redacted;
  });
  return { redacted, redactedParams: [...found] };
}
