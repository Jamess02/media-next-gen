/**
 * Cache de reponses, partage par les connecteurs de marche et les sources.
 *
 * Ecrits AVANT le code (TDD).
 *
 * D'OU IL VIENT. La logique existait deja, PRIVEE dans `marche/acces.ts` :
 * memoire plus disque, ecriture atomique, url reverifiee, horodatage d'origine
 * conserve. Les sources technologiques en ont besoin a leur tour — a commencer
 * par celles qui plafonnent au jour, ou une reponse relue vaut un appel
 * economise sur vingt-cinq.
 *
 * On EXTRAIT plutot que de recopier. Le depot a deja paye ce choix deux fois :
 * une seconde implementation de l'echappement HTML, ou du scellement du
 * journal, aurait diverge — et c'est celle qu'aucun test ne couvre qui laisse
 * passer la faute.
 *
 * DEUX INVARIANTS QUI NE SONT PAS DU CONFORT.
 *
 *  1. L'HORODATAGE D'ORIGINE SURVIT. Une reponse relue du cache garde la date
 *     de la requete qui l'a obtenue. Sans cela, l'article daterait une
 *     observation du moment ou il la relit, et pretendrait une fraicheur
 *     qu'elle n'a pas.
 *  2. L'URL EST REVERIFIEE A LA LECTURE. Le fichier est nomme par une empreinte
 *     tronquee : une collision, ou un fichier deplace a la main, servirait
 *     sinon la reponse d'une AUTRE requete sous l'identite de celle-ci.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CacheDeReponses } from "../src/sources/cache.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const URL_A = "https://exemple.test/a?x=1";
const URL_B = "https://exemple.test/b?x=2";

/** Horloge pilotee : l'expiration ne doit pas dependre du temps reel. */
function horlogeMobile(depart = 1_000_000) {
  let t = depart;
  return { maintenant: () => t, avancer: (ms: number) => (t += ms) };
}

const entree = (url: string, expireA: number, corps: unknown = { v: 1 }) => ({
  url,
  horodatageRequete: "2026-09-19T08:00:00.000Z",
  expireA,
  corps,
});

describe("lecture et ecriture", () => {
  it("relit ce qui vient d'etre ecrit", async () => {
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));

    const lu = await c.lire(URL_A);
    expect(lu?.corps).toEqual({ v: 1 });
  });

  it("CONSERVE l'horodatage de la requete d'origine", async () => {
    // Sans cela, l'article daterait l'observation du moment ou il la relit.
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));

    h.avancer(30_000);
    expect((await c.lire(URL_A))?.horodatageRequete).toBe("2026-09-19T08:00:00.000Z");
  });

  it("rend null une fois le delai passe", async () => {
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 1_000));

    h.avancer(1_001);
    expect(await c.lire(URL_A)).toBeNull();
  });

  it("rend null sur une entree expiree lue DEPUIS LE DISQUE", async () => {
    // Le test precedent passe par le cache memoire, qui a sa propre
    // verification : la branche disque n'y etait jamais eprouvee. Une mutation
    // supprimant le controle d'expiration cote fichier passait inapercue.
    const h = horlogeMobile();
    const ecrivain = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await ecrivain.ecrire(entree(URL_A, h.maintenant() + 1_000));

    h.avancer(1_001);
    const neuf = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    expect(await neuf.lire(URL_A)).toBeNull();
  });

  it("rend null pour une url jamais mise en cache", async () => {
    const c = new CacheDeReponses({ id: "test", dir });
    expect(await c.lire(URL_A)).toBeNull();
  });
});

describe("l'url est REVERIFIEE", () => {
  it("ne sert pas la reponse d'une autre requete", async () => {
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000, { a: true }));

    expect(await c.lire(URL_B)).toBeNull();
  });

  it("REFUSE un fichier dont l'url ne correspond pas a celle demandee", async () => {
    // Le test precedent ne prouvait rien : URL_B a une autre empreinte, donc
    // son fichier n'existe simplement pas. Ici on simule ce que le controle
    // existe pour attraper — une COLLISION d'empreinte tronquee, ou un fichier
    // deplace a la main : le contenu est valide, frais, mais repond a une
    // AUTRE requete. Le servir le ferait passer pour la reponse de celle-ci.
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    const chemin = c.chemin(URL_A) as string;
    await mkdir(join(chemin, ".."), { recursive: true });
    await writeFile(
      chemin,
      JSON.stringify(entree(URL_B, h.maintenant() + 60_000, { intrus: true })),
      "utf8",
    );

    expect(await c.lire(URL_A)).toBeNull();
  });
});

describe("persistance", () => {
  it("SURVIT au redemarrage", async () => {
    const h = horlogeMobile();
    const premier = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await premier.ecrire(entree(URL_A, h.maintenant() + 60_000, { v: 7 }));

    const second = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    expect((await second.lire(URL_A))?.corps).toEqual({ v: 7 });
  });

  it("ne melange PAS deux fournisseurs", async () => {
    const h = horlogeMobile();
    const a = new CacheDeReponses({ id: "alpha", dir, horloge: h.maintenant });
    const b = new CacheDeReponses({ id: "twelve", dir, horloge: h.maintenant });
    await a.ecrire(entree(URL_A, h.maintenant() + 60_000, { de: "alpha" }));

    expect(await b.lire(URL_A), "le cache d'un fournisseur a servi un autre").toBeNull();
  });

  it("MEMOIRE SEULE quand aucun repertoire n'est fourni", async () => {
    // Les tests unitaires ne doivent pas semer des fichiers, et une execution
    // jetable n'a pas a laisser d'etat derriere elle.
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir: null, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));

    expect((await c.lire(URL_A))?.corps).toEqual({ v: 1 });
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe("robustesse", () => {
  it("ignore un fichier illisible au lieu d'echouer", async () => {
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));
    await writeFile(c.chemin(URL_A) as string, "{ pas du json", "utf8");

    // Le cache memoire porterait encore la reponse : une instance neuve montre
    // ce que vaut le fichier seul.
    const neuf = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    expect(await neuf.lire(URL_A)).toBeNull();
  });

  it("ne laisse AUCUN fichier provisoire derriere lui", async () => {
    // L'ecriture est atomique : un arret brutal ne doit pas laisser un fichier
    // a moitie ecrit que la lecture suivante prendrait pour du cache.
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));

    const fichiers = await readdir(join(dir, "cache-test"));
    expect(fichiers.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(fichiers).toHaveLength(1);
  });

  it("rend null sur une entree sans horodatage : elle ne prouve plus sa date", async () => {
    const h = horlogeMobile();
    const c = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    await c.ecrire(entree(URL_A, h.maintenant() + 60_000));
    await writeFile(
      c.chemin(URL_A) as string,
      JSON.stringify({ url: URL_A, expireA: h.maintenant() + 60_000, corps: { v: 1 } }),
      "utf8",
    );

    const neuf = new CacheDeReponses({ id: "test", dir, horloge: h.maintenant });
    expect(await neuf.lire(URL_A)).toBeNull();
  });
});
