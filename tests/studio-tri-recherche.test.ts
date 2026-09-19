/**
 * Studio — brouillons RANGES par thematique, et recherche sur tout le fonds.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Demande de l'editeur du 2026-09-19 : quarante et un brouillons attendent
 * relecture dans un seul tas, et rien ne permet de retrouver un article deja
 * produit.
 *
 * OU VIT QUOI. Le rangement est fait par le SERVEUR — il est donc verifiable
 * ici, sur des donnees reelles. La page ne fait qu'inserer un titre quand la
 * thematique change, et filtrer a la saisie. Mettre l'ordre dans le navigateur
 * l'aurait rendu invisible aux tests, et un ordre que personne ne verifie finit
 * par dependre de l'ordre de lecture du disque.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { STUDIO_PAGE } from "../src/studio/page.js";
import { startStudio } from "../src/studio/server.js";
import { NON_CLASSE, THEMATIQUES } from "../src/sources/thematiques.js";
import { article, claim } from "./helpers.js";

let arreter: (() => Promise<void>) | undefined;
let racine: string | undefined;

afterEach(async () => {
  await arreter?.();
  arreter = undefined;
  if (racine !== undefined) await rm(racine, { recursive: true, force: true });
  racine = undefined;
});

const src = (url: string) => ({
  url,
  tier: 1 as const,
  date_observed: "2026-09-10T09:00:00Z",
  date_published: "2026-09-09T10:00:00Z",
});

const URLS = {
  fred: "https://fred.stlouisfed.org/series/FEDFUNDS",
  usgs: "https://earthquake.usgs.gov/fdsnws/event/1/query",
  ofac: "https://ofac.treasury.gov/recent-actions",
  inconnu: "https://exemple.test/rien",
};

/** Un brouillon jetable, avec son emetteur et sa date. */
function brouillon(n: number, url: string, publie: string) {
  return article({
    id: `article-0000000${n}-0000-4000-8000-00000000000${n}`,
    title: `Brouillon ${n}`,
    published_at: publie,
    claims: [claim({ sources: [src(url)] })],
  });
}

interface EtatArticle {
  id: string;
  titre: string;
  publie: string;
  thematique: string;
}

async function studio(brouillons: ReturnType<typeof brouillon>[]) {
  racine = await mkdtemp(join(tmpdir(), "studio-tri-"));
  const dossier = join(racine, "output");
  await mkdir(dossier, { recursive: true });
  await mkdir(join(racine, "articles"), { recursive: true });

  for (const a of brouillons) {
    await writeFile(join(dossier, `${a.id}.json`), JSON.stringify(a), "utf8");
  }

  const instance = await startStudio({
    port: 0,
    draftDir: dossier,
    publishedDir: join(racine, "articles"),
    changelogPath: join(racine, "changelog-editorial.md"),
  });
  arreter = instance.close;

  const page = await fetch(`${instance.url}/`).then((r) => r.text());
  const jeton = /data-jeton="([^"]+)"/.exec(page)?.[1] ?? "";
  const etat = (await fetch(`${instance.url}/api/etat?jeton=${jeton}`).then((r) =>
    r.json(),
  )) as { articles: EtatArticle[] };
  return etat.articles;
}

/* -------------------------------------------------------------------------
 * Le serveur range
 * ---------------------------------------------------------------------- */

describe("studio — chaque brouillon porte sa thematique", () => {
  it("derive la thematique des emetteurs cites", async () => {
    const articles = await studio([
      brouillon(1, URLS.fred, "2026-09-10T08:00:00Z"),
      brouillon(2, URLS.usgs, "2026-09-11T08:00:00Z"),
      brouillon(3, URLS.ofac, "2026-09-12T08:00:00Z"),
    ]);

    const par = new Map(articles.map((a) => [a.titre, a.thematique]));
    expect(par.get("Brouillon 1")).toBe("banques centrales");
    expect(par.get("Brouillon 2")).toBe("risques naturels");
    expect(par.get("Brouillon 3")).toBe("geopolitique");
  });

  it("range une ENQUETE sous investigateur, malgre ses emetteurs", async () => {
    // Le serveur doit transmettre le MODE, pas seulement les urls. Sans lui,
    // une enquete sur la Fed retomberait dans « banques centrales » et se
    // perdrait parmi les breves — et seul le test unitaire resterait vert.
    const enquete = article({
      id: "article-00000009-0000-4000-8000-000000000009",
      title: "Enquete longue",
      published_at: "2026-09-12T08:00:00Z",
      mode: "enquete",
      claims: [claim({ sources: [src(URLS.fred)] })],
    });
    const articles = await studio([enquete]);
    expect(articles[0]?.thematique).toBe("investigateur");
  });

  it("marque « non classe » plutot que de deviner", async () => {
    const articles = await studio([brouillon(4, URLS.inconnu, "2026-09-10T08:00:00Z")]);
    expect(articles[0]?.thematique).toBe(NON_CLASSE);
  });
});

describe("studio — les brouillons sont GROUPES", () => {
  it("ne disperse jamais une thematique dans la liste", async () => {
    // Le point entier du rangement : un relecteur qui traite les seismes doit
    // les trouver a la suite, pas repartis entre deux articles de macro.
    const articles = await studio([
      brouillon(1, URLS.fred, "2026-09-10T08:00:00Z"),
      brouillon(2, URLS.usgs, "2026-09-11T08:00:00Z"),
      brouillon(3, URLS.fred, "2026-09-12T08:00:00Z"),
      brouillon(4, URLS.usgs, "2026-09-13T08:00:00Z"),
    ]);

    const vues = new Set<string>();
    let precedente = "";
    for (const a of articles) {
      if (a.thematique === precedente) continue;
      expect(vues, `thematique dispersee : ${a.thematique}`).not.toContain(a.thematique);
      vues.add(a.thematique);
      precedente = a.thematique;
    }
    expect(vues.size).toBe(2);
  });

  it("garde le PLUS RECENT en tete de chaque thematique", async () => {
    // L'ordre par date existait avant le rangement : il ne doit pas etre perdu
    // a l'interieur des groupes, sinon le relecteur commence par le plus vieux.
    const articles = await studio([
      brouillon(1, URLS.fred, "2026-09-10T08:00:00Z"),
      brouillon(2, URLS.fred, "2026-09-14T08:00:00Z"),
      brouillon(3, URLS.fred, "2026-09-12T08:00:00Z"),
    ]);
    expect(articles.map((a) => a.titre)).toEqual([
      "Brouillon 2",
      "Brouillon 3",
      "Brouillon 1",
    ]);
  });

  it("relegue « non classe » en DERNIER", async () => {
    // Ce qui n'a pas pu etre range ne doit pas ouvrir la liste : ce sont les
    // articles dont on sait le moins, pas ceux qu'il faut relire d'abord.
    const articles = await studio([
      brouillon(1, URLS.inconnu, "2026-09-14T08:00:00Z"),
      brouillon(2, URLS.fred, "2026-09-10T08:00:00Z"),
    ]);
    expect(articles.at(-1)?.thematique).toBe(NON_CLASSE);
  });

  it("suit un ordre de thematiques STABLE d'une lecture a l'autre", async () => {
    const jeu = [
      brouillon(1, URLS.usgs, "2026-09-10T08:00:00Z"),
      brouillon(2, URLS.fred, "2026-09-11T08:00:00Z"),
    ];
    const a = (await studio(jeu)).map((x) => x.thematique);
    await arreter?.();
    arreter = undefined;
    const b = (await studio(jeu)).map((x) => x.thematique);
    expect(a).toEqual(b);
    // Et cet ordre est celui DECLARE, non celui du disque.
    const rang = (t: string) => (THEMATIQUES as readonly string[]).indexOf(t);
    expect(rang(a[0] as string)).toBeLessThan(rang(a[1] as string));
  });
});

/* -------------------------------------------------------------------------
 * La page affiche et filtre
 * ---------------------------------------------------------------------- */

describe("studio — la barre de recherche", () => {
  it("porte un champ de recherche identifie", () => {
    expect(STUDIO_PAGE).toContain('id="recherche"');
  });

  it("cherche dans le TITRE et dans la THEMATIQUE", () => {
    // Chercher « seisme » doit ramener l'article ; chercher « risques
    // naturels » doit ramener le groupe entier.
    const bloc = STUDIO_PAGE.slice(STUDIO_PAGE.indexOf("function correspond"));
    expect(bloc).toMatch(/titre/);
    expect(bloc).toMatch(/thematique/);
  });

  it("annonce le nombre d'articles trouves", () => {
    // Un filtre qui ne dit pas combien il retient laisse croire a une liste
    // complete quand elle est tronquee par une recherche oubliee.
    expect(STUDIO_PAGE).toContain('id="compte-recherche"');
  });

  it("insere un TITRE de groupe a chaque changement de thematique", () => {
    expect(STUDIO_PAGE).toContain("groupe-thematique");
  });

  it("n'insere AUCUN contenu par innerHTML", () => {
    // Regle deja tenue par la page : tout passe par textContent, le contenu
    // venant du pipeline, donc indirectement de sources externes.
    expect(STUDIO_PAGE).not.toMatch(/\.innerHTML\s*=/);
  });
});
