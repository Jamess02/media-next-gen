/**
 * Correctifs de securite.
 *
 * Chaque test correspond a une faille CONFIRMEE sur le code, pas a une
 * hypothese. Si l'un d'eux tombe, la faille est rouverte.
 */

import { describe, expect, it } from "vitest";

import { renderArticle } from "../src/agents/editeur.js";
import {
  escapeLinkTarget,
  escapeSourceText,
  neutralizeAuthoredMarkdown,
} from "../src/editorial/markdown.js";
import { ArticleSchema } from "../src/protocol/schema.js";
import { checkCitableUrl, isCitableUrl } from "../src/protocol/url.js";
import { article, claim } from "./helpers.js";

/* -------------------------------------------------------------------------
 * 1. Schemas d'URL
 * ---------------------------------------------------------------------- */

describe("URLs citables — liste blanche de schemas", () => {
  it("refuse javascript:, qui devient du XSS une fois rendu en lien", () => {
    expect(isCitableUrl("javascript:alert(document.cookie)")).toBe(false);
    expect(checkCitableUrl("javascript:alert(1)").reason).toBe("schema-interdit");
  });

  it("refuse data:, vecteur d'injection HTML", () => {
    expect(isCitableUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("refuse file:, qui pointe le disque du lecteur", () => {
    expect(isCitableUrl("file:///C:/Users/Utilisateur/.env")).toBe(false);
  });

  it("refuse le service de metadonnees cloud et les adresses privees", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/admin",
      "http://10.0.0.5/interne",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://localhost/x",
    ]) {
      expect(isCitableUrl(url), url).toBe(false);
    }
  });

  it("refuse une URL portant des identifiants", () => {
    expect(isCitableUrl("https://alice:motdepasse@exemple.org/a")).toBe(false);
    expect(checkCitableUrl("https://a:b@x.org").reason).toBe(
      "identifiants-integres",
    );
  });

  it("accepte les vraies sources du projet", () => {
    for (const url of [
      "https://fred.stlouisfed.org/series/FEDFUNDS",
      "https://api.worldbank.org/v2/country/EMU?format=json",
      "https://ec.europa.eu/eurostat/databrowser/view/prc_hicp_manr/default/table",
      "https://earthquake.usgs.gov/earthquakes/eventpage/us7000tcf3",
      "http://exemple.org/article",
    ]) {
      expect(isCitableUrl(url), url).toBe(true);
    }
  });

  it("bloque la claim au niveau du contrat §7, pas seulement du rendu", () => {
    const hostile = article({
      claims: [
        claim({
          sources: [
            {
              url: "javascript:alert(1)",
              tier: 1,
              date_observed: "2026-08-27T09:00:00Z",
              date_published: null,
            },
          ],
        }),
      ],
    });
    const parsed = ArticleSchema.safeParse(hostile);
    expect(parsed.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 2. Echappement du markdown
 * ---------------------------------------------------------------------- */

describe("texte de source — echappement", () => {
  it("neutralise un lien injecte depuis un resume", () => {
    const escaped = escapeSourceText(
      "Inflation stable [cliquez](javascript:vol()) fin.",
    );
    expect(escaped).toMatch(/\\\[/);
    expect(escaped).toMatch(/\\\]/);
  });

  it("neutralise le HTML brut", () => {
    const escaped = escapeSourceText('<img src=x onerror="vol()">');
    expect(escaped).not.toMatch(/<img/);
    expect(escaped).toMatch(/&lt;img/);
  });

  it("echappe l'antislash en premier, sans double traitement", () => {
    // Echapper l'antislash apres les autres re-echapperait ceux qu'on vient
    // d'introduire.
    expect(escapeSourceText("a\\b")).toBe("a\\\\b");
    expect(escapeSourceText("[x]")).toBe("\\[x\\]");
  });

  it("laisse un texte ordinaire lisible", () => {
    const text = "Taux directeur releve de 25 points de base le 12 aout 2026.";
    expect(escapeSourceText(text)).toBe(text);
  });
});

describe("cible de lien — encodage", () => {
  it("empeche de casser la syntaxe du lien avec une parenthese", () => {
    expect(escapeLinkTarget("https://x.org/a(b)c")).toBe(
      "https://x.org/a%28b%29c",
    );
  });

  it("encode les espaces", () => {
    expect(escapeLinkTarget("https://x.org/a b")).toBe("https://x.org/a%20b");
  });
});

describe("corps redige — neutralisation ciblee", () => {
  it("retire le HTML brut", () => {
    const out = neutralizeAuthoredMarkdown("Texte <script>vol()</script> fin.");
    expect(out).not.toMatch(/<script>/);
    expect(out).toMatch(/&lt;script&gt;/);
  });

  it("remplace une cible de lien a schema non autorise", () => {
    const out = neutralizeAuthoredMarkdown("Voir [ici](javascript:vol()).");
    expect(out).not.toMatch(/javascript:/);
    expect(out).toMatch(/lien-retire/);
    // Le texte du lien reste, pour que le lecteur voie qu'il y avait un lien.
    expect(out).toMatch(/\[ici\]/);
  });

  it("preserve les liens http(s) legitimes", () => {
    const md = "Source : [FRED](https://fred.stlouisfed.org/series/X).";
    expect(neutralizeAuthoredMarkdown(md)).toBe(md);
  });

  it("preserve la mise en forme et les references de claims", () => {
    const md = "Le **taux** passe a 4,50 % [[claim-1]].\n\n- point\n- autre";
    expect(neutralizeAuthoredMarkdown(md)).toBe(md);
  });

  it("neutralise une image de tracage", () => {
    const out = neutralizeAuthoredMarkdown("![x](javascript:pixel())");
    expect(out).not.toMatch(/javascript:/);
  });
});

/* -------------------------------------------------------------------------
 * 3. Rendu complet
 * ---------------------------------------------------------------------- */

describe("article publie — aucune injection ne survit au rendu", () => {
  it("neutralise une charge hostile placee dans le texte d'une claim", () => {
    const rendered = renderArticle(
      article({
        title: "Titre <script>alert(1)</script>",
        claims: [
          claim({
            text: 'Donnee <img src=x onerror="vol()"> et [lien](javascript:x).',
          }),
        ],
        editorial_notes: {
          uncertainty_flags: ["<iframe src=evil></iframe>"],
          excluded_claims: ["[clic](javascript:vol())"],
        },
      }),
    );

    expect(rendered).not.toMatch(/<script>/);
    expect(rendered).not.toMatch(/<img /);
    expect(rendered).not.toMatch(/<iframe/);

    // Nuance importante : `\[clic\](javascript:...)` PEUT figurer dans la
    // sortie sans danger — crochets echappes, un moteur markdown le rend en
    // texte litteral, pas en lien. Ce qu'il ne doit jamais y avoir, c'est un
    // `](` NON echappe suivi d'un schema dangereux : la, le lien est reel.
    expect(rendered).not.toMatch(/(?<!\\)\]\(\s*javascript:/i);
    expect(rendered).not.toMatch(/(?<!\\)\]\(\s*data:/i);
  });

  it("le texte hostile ressort inerte, mais visible du lecteur", () => {
    // On neutralise, on ne censure pas : le lecteur doit pouvoir constater ce
    // que la source contenait. C'est la logique du §0 — relire et contester.
    const rendered = renderArticle(
      article({ claims: [claim({ text: "Donnee [piege](javascript:x)." })] }),
    );
    expect(rendered).toMatch(/piege/);
  });

  it("laisse un article normal parfaitement lisible", () => {
    const rendered = renderArticle(article());
    expect(rendered).toMatch(/# Titre de test/);
    expect(rendered).toMatch(/\*\*Niveau de preuve\*\* : 3/);
    expect(rendered).toMatch(/https:\/\/fred\.stlouisfed\.org/);
  });
});
