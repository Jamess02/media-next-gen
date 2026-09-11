/**
 * Interface de VALIDATION : l'endroit ou l'editeur atteste avoir relu.
 *
 * Le pipeline ne publie que des BROUILLONS. Le passage de `output/` a
 * `articles/` — le seul dossier dont le site public tire — est un acte humain
 * qui engage une personne nommee. La logique existait deja
 * (`validateArticle`), mais n'etait accessible qu'en ligne de commande.
 *
 * CE QUE CES TESTS PROTEGENT AVANT TOUT
 *
 * Le nom du relecteur vient de l'UTILISATEUR, jamais du serveur. Une valeur
 * par defaut, un « editeur » generique ou un nom devine transformerait
 * l'attestation en formalite : elle affirmerait qu'une personne a relu quand
 * personne ne l'a fait. Le §6 et l'attestation `ReviewRecord` n'ont de sens
 * que si ce champ est reellement rempli par quelqu'un.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startStudio } from "../src/studio/server.js";
import { article, claim } from "./helpers.js";

let arreter: (() => Promise<void>) | undefined;
let racine: string | undefined;

afterEach(async () => {
  await arreter?.();
  arreter = undefined;
  if (racine !== undefined) await rm(racine, { recursive: true, force: true });
  racine = undefined;
});

/** Studio sur un port libre, avec des repertoires jetables. */
async function studio(): Promise<{
  base: string;
  jeton: string;
  brouillons: string;
  publies: string;
  id: string;
}> {
  racine = await mkdtemp(join(tmpdir(), "studio-valid-"));
  const brouillons = join(racine, "output");
  const publies = join(racine, "articles");
  await mkdir(brouillons, { recursive: true });
  await mkdir(publies, { recursive: true });

  const a = article({ claims: [claim()] });
  await writeFile(join(brouillons, `${a.id}.json`), JSON.stringify(a), "utf8");
  await writeFile(join(brouillons, `${a.id}.md`), `# ${a.title}\n`, "utf8");

  const instance = await startStudio({
    port: 0,
    draftDir: brouillons,
    publishedDir: publies,
    changelogPath: join(racine, "changelog-editorial.md"),
  });
  arreter = instance.close;

  const page = await fetch(`${instance.url}/`).then((r) => r.text());
  const jeton = /data-jeton="([^"]+)"/.exec(page)?.[1] ?? "";
  return { base: instance.url, jeton, brouillons, publies, id: a.id };
}

const poster = (base: string, corps: unknown, jeton: string) =>
  fetch(`${base}/api/valider?jeton=${jeton}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corps),
  });

describe("studio — validation d'un article relu", () => {
  it("promeut le brouillon et ecrit l'attestation au nom donne", async () => {
    const { base, jeton, publies, id } = await studio();
    const r = await poster(base, { id, relecteur: "Camille Roux", note: "verifie" }, jeton);
    expect(r.status).toBe(200);

    const revue = JSON.parse(
      await readFile(join(publies, `${id}.review.json`), "utf8"),
    ) as { reviewer: string; note: string | null; content_sha256: string };
    expect(revue.reviewer).toBe("Camille Roux");
    expect(revue.note).toBe("verifie");
    expect(revue.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REFUSE une validation sans relecteur nomme", async () => {
    // Le coeur du dispositif : une relecture anonyme n'engage personne, et une
    // attestation qui n'engage personne ne vaut rien.
    const { base, jeton, id } = await studio();
    for (const relecteur of ["", "   "]) {
      const r = await poster(base, { id, relecteur }, jeton);
      expect(r.status, JSON.stringify(relecteur)).toBe(400);
    }
  });

  it("n'invente JAMAIS de relecteur par defaut", async () => {
    // Champ absent : le serveur doit refuser, pas combler.
    const { base, jeton, id } = await studio();
    const r = await poster(base, { id }, jeton);
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(/relecteur/i);
  });

  it("refuse un identifiant qui sortirait du repertoire", async () => {
    const { base, jeton } = await studio();
    const r = await poster(
      base,
      { id: "../../../etc/passwd", relecteur: "Camille Roux" },
      jeton,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("refuse un brouillon inexistant, sans creer d'attestation", async () => {
    const { base, jeton, publies } = await studio();
    const r = await poster(
      base,
      { id: "article-00000000-0000-4000-8000-999999999999", relecteur: "Camille Roux" },
      jeton,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    await expect(
      readFile(join(publies, "article-00000000-0000-4000-8000-999999999999.review.json")),
    ).rejects.toThrow();
  });
});

describe("studio — la route de validation est protegee comme les autres", () => {
  it("refuse GET : valider est une ECRITURE", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(`${base}/api/valider?jeton=${jeton}`);
    expect(r.status).toBe(405);
  });

  it("refuse une requete sans jeton", async () => {
    const { base, id } = await studio();
    const r = await fetch(`${base}/api/valider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, relecteur: "Camille Roux" }),
    });
    expect(r.status).toBe(403);
  });

  it("refuse une origine etrangere", async () => {
    const { base, jeton, id } = await studio();
    const r = await fetch(`${base}/api/valider?jeton=${jeton}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://exemple.test" },
      body: JSON.stringify({ id, relecteur: "Camille Roux" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("studio — lire l'article avant d'attester", () => {
  it("rend le texte du brouillon", async () => {
    // Attester sans pouvoir lire ferait du bouton un tampon. Le §6 demande une
    // relecture, pas un clic.
    const { base, jeton, id } = await studio();
    const r = await fetch(`${base}/api/article?jeton=${jeton}&id=${id}`);
    expect(r.status).toBe(200);
    expect((await r.json()) as { markdown: string }).toHaveProperty("markdown");
  });

  it("refuse un identifiant sortant du repertoire", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(
      `${base}/api/article?jeton=${jeton}&id=${encodeURIComponent("../../.env")}`,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("refuse sans jeton", async () => {
    const { base, id } = await studio();
    expect((await fetch(`${base}/api/article?id=${id}`)).status).toBe(403);
  });
});

describe("studio — l'etat distingue brouillons et articles valides", () => {
  it("marque un article comme non valide tant qu'il ne l'est pas", async () => {
    const { base, jeton, id } = await studio();
    const avant = (await fetch(`${base}/api/etat?jeton=${jeton}`).then((r) => r.json())) as {
      articles: Array<{ id: string; valide: boolean }>;
    };
    expect(avant.articles.find((a) => a.id === id)?.valide).toBe(false);
  });

  it("le marque valide, avec son relecteur, une fois l'attestation ecrite", async () => {
    const { base, jeton, id } = await studio();
    await poster(base, { id, relecteur: "Camille Roux" }, jeton);
    const apres = (await fetch(`${base}/api/etat?jeton=${jeton}`).then((r) => r.json())) as {
      articles: Array<{ id: string; valide: boolean; relecteur: string | null }>;
    };
    const a = apres.articles.find((x) => x.id === id);
    expect(a?.valide).toBe(true);
    expect(a?.relecteur).toBe("Camille Roux");
  });
});

describe("studio — l'apercu a la FORME du site", () => {
  /**
   * Demande de l'editeur : « dans leur etat actuel la relecture n'est pas
   * facile ». Le studio rendait le markdown BRUT — sans fiches de preuve, sans
   * tableau de chiffres, sans encart d'incertitudes, sans divulgation en gras.
   *
   * Or ces elements sont precisement ce qu'une relecture doit controler : ils
   * portent le niveau de preuve, le tier et la date de chaque source. Relire un
   * texte ampute de ses preuves, c'est attester de ce qu'on n'a pas vu.
   *
   * L'apercu emprunte donc le MEME gabarit que le site. Pas un gabarit
   * ressemblant : le meme, sans quoi les deux divergeraient a la premiere
   * evolution de l'un des deux.
   */
  it("rend une page HTML complete, pas du markdown", async () => {
    const { base, jeton, id } = await studio();
    const r = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toMatch(/<!doctype html>/i);
  });

  it("affiche les FICHES DE PREUVE, absentes de l'apercu markdown", async () => {
    const { base, jeton, id } = await studio();
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}`).then((r) => r.text());
    expect(html).toMatch(/preuves/i);
    expect(html).toMatch(/niveau|tier/i);
  });

  it("porte le bloc « comment citer », comme la page publiee", async () => {
    const { base, jeton, id } = await studio();
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}`).then((r) => r.text());
    expect(html).toMatch(/Comment citer cet article/i);
  });

  it("refuse sans jeton", async () => {
    const { base, id } = await studio();
    expect((await fetch(`${base}/apercu?id=${id}`)).status).toBe(403);
  });

  it("refuse un identifiant sortant du repertoire", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(`${base}/apercu?jeton=${jeton}&id=${encodeURIComponent("../../.env")}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("rend 404 pour un brouillon inexistant", async () => {
    const { base, jeton } = await studio();
    const r = await fetch(
      `${base}/apercu?jeton=${jeton}&id=article-00000000-0000-4000-8000-999999999999`,
    );
    expect(r.status).toBe(404);
  });
});
