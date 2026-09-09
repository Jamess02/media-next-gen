/**
 * SECURITE — les deux serveurs locaux.
 *
 * Ecrits AVANT le code (TDD).
 *
 * POURQUOI CE N'EST PAS "juste du local". Ecouter sur 127.0.0.1 protege du
 * reseau, pas du NAVIGATEUR de l'utilisateur. Une page web ouverte dans un
 * autre onglet peut emettre des requetes vers la boucle locale :
 *
 *  - requete simple inter-origine : `<img src="http://127.0.0.1:5173/api/
 *    publier?provider=anthropic&sujet=...">` part sans pre-vol CORS. La page
 *    ne lit pas la reponse, mais le pipeline a demarre — donc des appels
 *    FACTURES et des fichiers ecrits ;
 *  - reattachement DNS (« DNS rebinding ») : un domaine controle par
 *    l'attaquant repointe vers 127.0.0.1 apres le chargement. Le navigateur
 *    considere alors la requete comme de meme origine, et la reponse devient
 *    lisible. C'est l'en-tete `Host` qui trahit l'attaque : il porte le
 *    domaine de l'attaquant, jamais 127.0.0.1.
 *
 * Le studio n'avait aucune de ces protections, ni meme de controle de methode.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startStudio } from "../src/studio/server.js";

let arreter: (() => Promise<void>) | undefined;

afterEach(async () => {
  await arreter?.();
  arreter = undefined;
});

/** Demarre le studio sur un port libre et rend son URL. */
async function studio(): Promise<{ base: string; jeton: string }> {
  const instance = await startStudio({ port: 0 });
  arreter = instance.close;

  // Le jeton est depose dans la page servie : seule une origine capable de la
  // LIRE peut appeler l'API. Une requete inter-origine aveugle ne le connait pas.
  const page = await fetch(`${instance.url}/`).then((r) => r.text());
  const jeton = /data-jeton="([^"]+)"/.exec(page)?.[1] ?? "";
  return { base: instance.url, jeton };
}

/**
 * Requete HTTP BRUTE.
 *
 * `fetch` refuse de definir l'en-tete `Host` : la specification en fait un
 * en-tete interdit, et undici le remplace par l'hote reel. Simuler un
 * reattachement DNS demande donc de descendre au client HTTP de Node.
 *
 * Ce n'est pas un contournement de test : dans l'attaque reelle, c'est le
 * NAVIGATEUR qui envoie le `Host` du domaine attaquant, precisement parce que
 * c'est ce domaine qu'il croit contacter.
 */
function requeteBrute(
  base: string,
  chemin: string,
  entetes: Record<string, string>,
): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: chemin,
        method: "GET",
        headers: entetes,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("studio — reattachement DNS", () => {
  it("refuse une requete dont l'en-tete Host n'est pas la boucle locale", async () => {
    const { base, jeton } = await studio();
    const code = await requeteBrute(base, `/api/etat?jeton=${jeton}`, {
      host: "attaquant.test",
    });
    expect(code).toBe(403);
  });

  it("accepte 127.0.0.1 et localhost", async () => {
    const { base, jeton } = await studio();
    const port = new URL(base).port;
    for (const hote of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const code = await requeteBrute(base, `/api/etat?jeton=${jeton}`, {
        host: hote,
      });
      expect(code).toBe(200);
    }
  });
});

describe("studio — requete inter-origine", () => {
  it("refuse une requete portant une origine etrangere", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(`${base}/api/etat?jeton=${jeton}`, {
      headers: { origin: "https://site-malveillant.test" },
    });
    expect(r.status).toBe(403);
  });

  it("refuse une requete sans jeton, meme bien formee par ailleurs", async () => {
    // C'est le cas de `<img src="...">` : l'attaquant declenche sans lire, et
    // ne peut pas deviner le jeton.
    const { base } = await studio();
    const r = await fetch(`${base}/api/etat`);
    expect(r.status).toBe(403);
  });

  it("refuse un jeton faux", async () => {
    const { base } = await studio();
    const r = await fetch(`${base}/api/etat?jeton=devine`);
    expect(r.status).toBe(403);
  });

  it("NE protege PAS la page elle-meme : elle doit rester ouvrable", async () => {
    // Exiger le jeton sur `/` rendrait le studio inutilisable : c'est la page
    // qui le distribue.
    const { base } = await studio();
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe("studio — declenchement du pipeline", () => {
  it("refuse une methode qui n'est pas prevue pour la route", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(`${base}/api/site?jeton=${jeton}`, { method: "DELETE" });
    expect(r.status).toBe(405);
  });

  it("le jeton change a chaque demarrage", async () => {
    // Un jeton fixe finirait dans une capture d'ecran ou un historique, et
    // vaudrait alors pour toutes les sessions suivantes.
    const a = await studio();
    await arreter?.();
    const b = await studio();
    expect(a.jeton).not.toBe(b.jeton);
    expect(a.jeton.length).toBeGreaterThanOrEqual(32);
  });
});
