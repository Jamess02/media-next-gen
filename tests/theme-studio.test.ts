/**
 * Mode sombre du STUDIO — la meme mecanique que le site.
 *
 * CE QUI EXISTAIT : une palette sombre, mais uniquement sous
 * `@media (prefers-color-scheme: dark)`. Elle suivait le systeme, sans choix
 * possible. Sur une machine reglee en clair, l'editeur ne la voyait jamais.
 *
 * LE PIEGE, deja rencontre sur le site. Ajouter un bouton par-dessus une regle
 * `@media` non gardee ne marche pas : sur une machine en sombre, choisir
 * « clair » n'aurait aucun effet, la media query continuant de gagner. D'ou les
 * trois selecteurs que ces tests verrouillent.
 *
 * LE PIEGE PROPRE AU STUDIO. L'apercu d'article est un cadre en `sandbox` sans
 * scripts : le script de theme du site ne s'y execute pas. Sans transmission
 * explicite, l'editeur en sombre relirait un article en clair, et la page
 * relue ne serait plus celle que verra un lecteur ayant fait le meme choix.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { STUDIO_PAGE } from "../src/studio/page.js";
import { startStudio } from "../src/studio/server.js";
import { article, claim } from "./helpers.js";

const TOKENS = [
  "--encre",
  "--papier",
  "--gris",
  "--gris-clair",
  "--trait",
  "--doux",
  "--accent",
  "--fort",
  "--moyen",
  "--faible",
] as const;

/** Contenu du premier bloc dont le selecteur correspond. */
function bloc(selecteur: string): string {
  const i = STUDIO_PAGE.indexOf(selecteur);
  if (i < 0) return "";
  const debut = STUDIO_PAGE.indexOf("{", i);
  const fin = STUDIO_PAGE.indexOf("}", debut);
  return STUDIO_PAGE.slice(debut, fin);
}

describe("studio — les trois etats du theme", () => {
  it("le sombre EXPLICITE redefinit tous les tokens", () => {
    const b = bloc(':root[data-theme="dark"]');
    for (const t of TOKENS) expect(b, t).toContain(t);
  });

  it("la media query systeme est GARDEE contre un choix clair explicite", () => {
    // Sans cette garde, choisir « clair » sur une machine en sombre ne ferait
    // rien : la media query continuerait de gagner.
    expect(STUDIO_PAGE).toContain(':root:not([data-theme="light"])');
  });

  it("aucune couleur n'utilise un token INEXISTANT", () => {
    // Le bloc de relecture utilisait `var(--fond)`, qui n'existe pas dans le
    // studio : le fond retombait sur « transparent » sans que rien ne le dise.
    const utilises = [...STUDIO_PAGE.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]);
    const definis = new Set([...STUDIO_PAGE.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
    for (const u of new Set(utilises)) expect(definis, `${u} utilise mais jamais defini`).toContain(u);
  });

  it("declare color-scheme, pour que les champs natifs suivent", () => {
    expect(STUDIO_PAGE).toMatch(/color-scheme\s*:/);
  });
});

describe("studio — la bascule", () => {
  it("porte un bouton de theme", () => {
    expect(STUDIO_PAGE).toContain('id="theme-bascule"');
  });

  it("applique le theme dans le HEAD, avant le premier rendu", () => {
    // Applique apres le rendu, il produirait un flash blanc a chaque ouverture.
    const head = STUDIO_PAGE.slice(0, STUDIO_PAGE.indexOf("</head>"));
    expect(head).toMatch(/localStorage/);
    expect(head).toMatch(/data-theme/);
  });

  it("survit a un localStorage indisponible", () => {
    // En navigation privee, localStorage LEVE au lieu de rendre null : sans
    // try/catch, le studio ne s'afficherait pas du tout.
    const head = STUDIO_PAGE.slice(0, STUDIO_PAGE.indexOf("</head>"));
    expect(head).toMatch(/try\s*\{/);
  });

  it("partage le choix avec le site : meme clef de stockage", () => {
    // Le site et le studio sont servis sur la meme machine ; un choix fait
    // dans l'un doit valoir dans l'autre plutot que d'etre refait.
    expect(STUDIO_PAGE).toMatch(/localStorage\.getItem\("theme"\)/);
  });
});

/* -------------------------------------------------------------------------
 * Transmission du theme a l'apercu
 * ---------------------------------------------------------------------- */

let arreter: (() => Promise<void>) | undefined;
let racine: string | undefined;

afterEach(async () => {
  await arreter?.();
  arreter = undefined;
  if (racine !== undefined) await rm(racine, { recursive: true, force: true });
  racine = undefined;
});

async function studio(): Promise<{ base: string; jeton: string; id: string }> {
  racine = await mkdtemp(join(tmpdir(), "studio-theme-"));
  const brouillons = join(racine, "output");
  await mkdir(brouillons, { recursive: true });
  await mkdir(join(racine, "articles"), { recursive: true });
  const a = article({ claims: [claim()] });
  await writeFile(join(brouillons, `${a.id}.json`), JSON.stringify(a), "utf8");
  const instance = await startStudio({
    port: 0,
    draftDir: brouillons,
    publishedDir: join(racine, "articles"),
    changelogPath: join(racine, "changelog.md"),
  });
  arreter = instance.close;
  const page = await fetch(`${instance.url}/`).then((r) => r.text());
  return { base: instance.url, jeton: /data-jeton="([^"]+)"/.exec(page)?.[1] ?? "", id: a.id };
}

describe("studio — l'apercu suit le theme choisi", () => {
  it("pose data-theme=\"dark\" quand le studio est en sombre", async () => {
    const { base, jeton, id } = await studio();
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}&theme=dark`).then((r) => r.text());
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
  });

  it("pose data-theme=\"light\" quand le studio est en clair", async () => {
    const { base, jeton, id } = await studio();
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}&theme=light`).then((r) => r.text());
    expect(html).toMatch(/<html[^>]*data-theme="light"/);
  });

  it("ne pose RIEN sans parametre : le systeme decide", async () => {
    const { base, jeton, id } = await studio();
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}`).then((r) => r.text());
    expect(html).not.toMatch(/<html[^>]*data-theme=/);
  });

  it("ignore une valeur de theme inconnue, sans l'injecter", async () => {
    // Le parametre est recopie dans le HTML : une valeur libre y ouvrirait une
    // injection d'attribut. Seules deux valeurs existent.
    const { base, jeton, id } = await studio();
    const piege = encodeURIComponent('dark" onload="alert(1)');
    const html = await fetch(`${base}/apercu?jeton=${jeton}&id=${id}&theme=${piege}`).then((r) => r.text());
    expect(html).not.toContain("onload");
    expect(html).not.toMatch(/<html[^>]*data-theme=/);
  });
});
