/**
 * Confinement des deux serveurs locaux au navigateur de la machine.
 *
 * Module feuille : aucun import, aucune dependance npm. Partage par l'apercu
 * (`site/serve.ts`) et le studio (`studio/server.ts`), qui ont le meme
 * probleme pour des enjeux differents — l'un peut DECLENCHER des appels
 * factures, l'autre peut LAISSER LIRE des brouillons que personne n'a relus.
 *
 * POURQUOI ECOUTER SUR 127.0.0.1 NE SUFFIT PAS
 *
 * Cela protege du reseau, pas du navigateur de l'utilisateur. Une page ouverte
 * dans un autre onglet peut emettre des requetes vers la boucle locale, et
 * deux techniques la servent :
 *
 *  - la requete simple inter-origine, qui part sans pre-vol CORS ;
 *  - le reattachement DNS, ou un domaine de l'attaquant repointe vers
 *    127.0.0.1 apres le chargement de sa page. Le navigateur croit alors etre
 *    en meme origine et laisse lire la reponse.
 *
 * L'en-tete `Host` est ce qui trahit le second : le navigateur y met le
 * domaine qu'il croit contacter, donc celui de l'attaquant, jamais la boucle
 * locale.
 */

const HOTES_ADMIS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Vrai si l'en-tete `Host` designe la boucle locale.
 *
 * Le port est ignore : c'est l'HOTE qui distingue une requete legitime d'un
 * reattachement, et les tests ouvrent des ports arbitraires.
 */
export function hoteLocal(host: string | undefined): boolean {
  if (host === undefined) return false;
  const sansPort = host.replace(/:\d+$/, "").toLowerCase();
  return HOTES_ADMIS.has(sansPort);
}

/**
 * Vrai si l'origine declaree est locale, ou absente.
 *
 * Une origine ABSENTE passe : les requetes de meme origine n'en portent pas
 * toujours, et `EventSource` n'en envoie jamais. C'est exactement pourquoi le
 * studio exige en plus un jeton — l'absence d'origine ne doit pas valoir
 * laissez-passer.
 */
export function origineAdmise(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return false;
  try {
    return hoteLocal(new URL(origin).host);
  } catch {
    return false;
  }
}
