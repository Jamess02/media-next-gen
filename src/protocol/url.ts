/**
 * Validation des URLs citables.
 *
 * Module feuille : aucun import, aucune dependance npm.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * `z.url()` s'appuie sur le constructeur `URL`, qui accepte N'IMPORTE QUEL
 * schema. Ces quatre valeurs passaient donc la validation du §7 :
 *
 *   javascript:alert(document.cookie)
 *   data:text/html,<script>alert(1)</script>
 *   file:///C:/Users/.../.env
 *   http://169.254.169.254/latest/meta-data/
 *
 * Or l'Editeur rend chaque source en `[url](url)` dans le markdown publie. Le
 * jour ou ce markdown devient une page web — ce que le §5.4 prevoit — les deux
 * premieres deviennent du XSS sur les lecteurs. La troisieme exfiltre un
 * fichier local, la quatrieme pointe le service de metadonnees d'une instance
 * cloud.
 *
 * PRINCIPE : liste blanche, pas liste noire.
 *
 * On n'enumere pas les schemas dangereux — il en apparaitra d'autres. Seuls
 * `http` et `https` sont acceptes. Une source citable est une ressource qu'un
 * lecteur peut ouvrir dans son navigateur ; rien d'autre n'a de sens dans le
 * §2, ou le niveau 2 se definit comme "accessible par une URL verifiable".
 */

export type UrlRejection =
  | "malformee"
  | "schema-interdit"
  | "hote-absent"
  | "identifiants-integres"
  | "hote-non-routable";

export interface UrlCheck {
  ok: boolean;
  reason?: UrlRejection;
  detail?: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Hotes qui ne peuvent pas designer une source publique verifiable.
 * Une citation vers 127.0.0.1 ou vers le service de metadonnees d'un
 * fournisseur cloud n'est jamais une preuve : c'est soit une erreur, soit une
 * tentative de faire emettre une requete par l'infrastructure.
 */
function isNonRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 : boucle locale et adresses locales uniques / lien-local.
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return false;

  const parts = ipv4.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return true; // adresse invalide
  const [a = 0, b = 0] = parts;

  if (a === 0 || a === 127) return true; // ce reseau, boucle locale
  if (a === 10) return true; // prive
  if (a === 172 && b >= 16 && b <= 31) return true; // prive
  if (a === 192 && b === 168) return true; // prive
  if (a === 169 && b === 254) return true; // lien-local + metadonnees cloud
  if (a >= 224) return true; // multicast et reserve
  return false;
}

export function checkCitableUrl(value: string): UrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "malformee" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: "schema-interdit",
      detail: parsed.protocol.replace(":", ""),
    };
  }
  if (parsed.hostname.length === 0) {
    return { ok: false, reason: "hote-absent" };
  }
  // `https://alice:motdepasse@exemple.org` : des identifiants n'ont rien a
  // faire dans une source publiee, et seraient archives dans le journal.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: "identifiants-integres" };
  }
  if (isNonRoutableHost(parsed.hostname)) {
    return {
      ok: false,
      reason: "hote-non-routable",
      detail: parsed.hostname,
    };
  }
  return { ok: true };
}

export function isCitableUrl(value: string): boolean {
  return checkCitableUrl(value).ok;
}

const MESSAGES: Record<UrlRejection, string> = {
  malformee: "URL malformee",
  "schema-interdit":
    "schema non autorise — seuls http et https peuvent etre cites et rendus en lien",
  "hote-absent": "URL sans hote",
  "identifiants-integres":
    "URL contenant des identifiants (user:motdepasse@), jamais publiable",
  "hote-non-routable":
    "hote local, prive ou lien-local : ne designe aucune source publique verifiable",
};

export function explainUrlRejection(check: UrlCheck): string {
  if (check.ok) return "";
  const base = MESSAGES[check.reason ?? "malformee"];
  return check.detail === undefined ? base : `${base} (${check.detail})`;
}
