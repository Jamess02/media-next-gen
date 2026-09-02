/**
 * Gabarits HTML du site public.
 *
 * Dependances : `markdown.ts` et `styles.ts` (locaux), plus les constantes et
 * types du protocole. Aucune dependance npm : le site est du HTML statique.
 *
 * SOURCE DES DONNEES : le JSON du §7, pas le markdown publie. Claims, niveaux
 * de preuve, tiers et dates sont des donnees TYPEES — les afficher depuis le
 * contrat plutot que depuis un texte reanalyse supprime toute possibilite de
 * divergence entre ce que l'article affirme et ce que le pipeline a valide.
 * Seul le corps redige passe par le rendu markdown.
 */

import {
  EVIDENCE_LEVEL_LABELS,
  SOURCE_TIER_LABELS,
  type EvidenceLevel,
  type SourceTier,
} from "../protocol/constants.js";
import type { ReviewRecord } from "../editorial/validation.js";
import type { Article, Claim } from "../protocol/schema.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { STYLES } from "./styles.js";

export const SITE_NAME = "Media Next Gen";
export const SITE_TAGLINE =
  "Analyses geopolitiques et economiques produites par un pipeline multi-agents sous protocole editorial opposable.";

/**
 * URL publique du site, sans barre finale.
 *
 * Necessaire pour les liens ABSOLUS : un flux RSS et un sitemap ne peuvent pas
 * porter de chemins relatifs, un lecteur de flux ne sait pas d'ou ils viennent.
 * Reglable par MEDIA_SITE_URL ; le defaut vise GitHub Pages, ou le depot est
 * publie.
 */
export function siteUrl(): string {
  const brut =
    process.env["MEDIA_SITE_URL"]?.trim() ||
    "https://jamess02.github.io/media-next-gen";
  return brut.replace(/\/+$/, "");
}

interface PageOptions {
  title: string;
  /** Profondeur par rapport a la racine, pour les liens relatifs. */
  depth?: number;
  active?: "articles" | "protocole" | "changelog";
  body: string;
  /** Resume pour les moteurs et le partage. Defaut : l'accroche du site. */
  description?: string;
  /** Chemin absolu de la page, pour l'URL canonique et Open Graph. */
  path?: string;
}

export function page({
  title,
  depth = 0,
  active,
  body,
  description,
  path,
}: PageOptions): string {
  const root = depth === 0 ? "." : "..";
  const resume = description ?? SITE_TAGLINE;
  const canonique = path === undefined ? undefined : `${siteUrl()}${path}`;
  const nav = (
    [
      ["articles", `${root}/index.html`, "articles"],
      ["protocole", `${root}/protocole.html`, "protocole"],
      ["changelog", `${root}/changelog.html`, "corrections"],
    ] as const
  )
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${active === key ? ' class="actif"' : ""}>${label}</a>`,
    )
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(resume)}">
${canonique === undefined ? "" : `<link rel="canonical" href="${escapeHtml(canonique)}">`}
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(SITE_NAME)}" href="${root}/feed.xml">
<meta property="og:type" content="${path === "/" ? "website" : "article"}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(resume)}">
${canonique === undefined ? "" : `<meta property="og:url" content="${escapeHtml(canonique)}">`}
<meta name="twitter:card" content="summary">
<style>${STYLES}</style>
</head>
<body>
<div class="enveloppe">
<header class="site">
  <a class="titre" href="${root}/index.html">${escapeHtml(SITE_NAME)}</a>
  <div class="accroche">${escapeHtml(SITE_TAGLINE)}</div>
  <nav class="site">${nav}</nav>
</header>
${body}
<footer class="site">
  Chaque affirmation est typee, sourcee, datee et rattachee a son niveau de preuve.<br>
  Produit par un pipeline multi-agents sous Protocole Editorial v1.0.<br>
  Ne constitue ni un conseil d'investissement, ni une recommandation politique ou electorale (EP-007).
</footer>
</div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------
 * Badges — §2, §3, §4 rendus lisibles d'un coup d'oeil
 * ---------------------------------------------------------------------- */

export function badgeNiveau(level: EvidenceLevel): string {
  return (
    `<span class="badge niveau-${level}" title="§2 — ${escapeHtml(EVIDENCE_LEVEL_LABELS[level])}">` +
    `preuve ${level}/4</span>`
  );
}

export function badgeType(type: Claim["type"]): string {
  return `<span class="badge type" title="§3 — typologie des claims">${escapeHtml(type)}</span>`;
}

export function badgeTier(tier: SourceTier): string {
  return (
    `<span class="badge tier-${tier}" title="§4 — ${escapeHtml(SOURCE_TIER_LABELS[tier])}">` +
    `tier ${tier}</span>`
  );
}

/* -------------------------------------------------------------------------
 * Article
 * ---------------------------------------------------------------------- */

const jour = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? escapeHtml(iso)
    : d.toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
};

const horodatage = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toISOString();
};

function renderClaim(claim: Claim, index: number): string {
  const sources = claim.sources
    .map(
      (s) =>
        `<li>${badgeTier(s.tier)} <a href="${escapeHtml(s.url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(s.url)}</a>` +
        ` &middot; observe ${horodatage(s.date_observed)}` +
        (s.date_published === null
          ? " &middot; publication non datee par la source"
          : ` &middot; publie ${horodatage(s.date_published)}`) +
        `</li>`,
    )
    .join("");

  return `<section class="claim" id="${escapeHtml(claim.id)}">
  <div class="entete">
    <span class="cid">${escapeHtml(claim.id)}</span>
    ${badgeType(claim.type)}
    ${badgeNiveau(claim.evidence_level)}
  </div>
  <p class="texte">${escapeHtml(claim.text)}</p>
  <ul class="sources">${sources || "<li>aucune source</li>"}</ul>
</section>`;
}

/**
 * §0 / EP-002 — l'attestation de relecture, rendue visible au lecteur.
 *
 * Le circuit de relecture ne produit de redevabilite que si le nom de la
 * personne qui a engage sa responsabilite atteint le lecteur. Une attestation
 * qui reste dans un fichier JSON n'engage personne aux yeux du public.
 */
function renderReview(review: ReviewRecord | undefined): string {
  if (review === undefined) return "";
  return `<div class="relecture">
  <div class="section">relecture humaine</div>
  <p><strong>${escapeHtml(review.reviewer)}</strong> a relu et valide cet article le ${horodatage(review.reviewed_at)}.</p>
  ${review.note === null ? "" : `<p class="note">&laquo;&nbsp;${escapeHtml(review.note)}&nbsp;&raquo;</p>`}
  <p class="empreinte">Empreinte du contenu relu : <code>${escapeHtml(review.content_sha256.slice(0, 32))}&hellip;</code><br>
  Toute modification ulterieure de l'article invalide cette attestation et le retire du site.</p>
</div>`;
}

export function articlePage(
  article: Article,
  review?: ReviewRecord,
): string {
  const declares = new Set(article.claims.map((c) => c.id));
  const corps = renderMarkdown(article.body, {
    // Le §0 promet qu'une affirmation puisse etre relue et contestee : chaque
    // reference devient un lien vers sa preuve.
    claimAnchor: (id) => (declares.has(id) ? `#${encodeURIComponent(id)}` : undefined),
  });

  const flags = article.editorial_notes.uncertainty_flags;
  const avertissement =
    flags.length === 0
      ? ""
      : `<div class="avertissement">
  <div class="section">incertitudes declarees</div>
  <ul>${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
</div>`;

  const ecartees = article.editorial_notes.excluded_claims;
  const blocEcartees =
    ecartees.length === 0
      ? ""
      : `<div class="section">affirmations ecartees</div>
<p class="entree-resume">Envisagees puis rejetees par le fact-checker : elles ne figurent pas dans l'article. Listees pour que le lecteur sache ce qui n'a pas ete retenu.</p>
<ul class="ecartees">${ecartees.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`;

  const changelog =
    article.changelog.length === 0
      ? ""
      : `<div class="section">historique des corrections</div>
<ul class="ecartees">${article.changelog
          .map(
            (c) =>
              `<li><strong>${jour(c.date)}</strong> &middot; ${escapeHtml(c.type)} — ${escapeHtml(c.description)}</li>`,
          )
          .join("")}</ul>`;

  const body = `<article>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="dateline">
    publie ${horodatage(article.published_at)}
    ${article.revised_at === null ? "" : `&middot; <span class="revise">revise ${horodatage(article.revised_at)}</span>`}
    &middot; ${article.claims.length} claim(s) structurante(s)
  </div>
  ${avertissement}
  <div class="corps">${corps}</div>
  <div class="section">preuves</div>
  ${article.claims.map(renderClaim).join("")}
  ${renderReview(review)}
  ${blocEcartees}
  ${changelog}
</article>`;

  return page({
    title: `${article.title} — ${SITE_NAME}`,
    depth: 1,
    active: "articles",
    description: articleSummary(article),
    path: `/articles/${encodeURIComponent(article.id)}.html`,
    body,
  });
}

/** Premiere phrase utile du corps, debarrassee du balisage. */
export function articleSummary(article: Article, max = 240): string {
  const premier = article.body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const nu = premier
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return nu.length > max ? `${nu.slice(0, max)}…` : nu;
}

/* -------------------------------------------------------------------------
 * Index
 * ---------------------------------------------------------------------- */

export function indexPage(articles: readonly Article[]): string {
  if (articles.length === 0) {
    return page({
      title: SITE_NAME,
      active: "articles",
      body: `<div class="section">a la une</div>
<div class="vide">Aucun article publie.<br>Lancer le pipeline, puis regenerer le site avec <code>npm run site</code>.</div>`,
    });
  }

  const entrees = articles
    .map((a, i) => {
      const minLevel = Math.min(
        ...a.claims.map((c) => c.evidence_level),
      ) as EvidenceLevel;
      const types = [...new Set(a.claims.map((c) => c.type))];
      const resume = articleSummary(a);

      return `<li>
  <div class="entree-meta">
    <span class="numero">${String(i + 1).padStart(2, "0")}</span>
    <span>${jour(a.published_at)}</span>
    ${a.revised_at === null ? "" : '<span class="badge">revise</span>'}
    ${badgeNiveau(minLevel)}
    ${types.map(badgeType).join(" ")}
  </div>
  <a class="entree-titre" href="articles/${encodeURIComponent(a.id)}.html">${escapeHtml(a.title)}</a>
  <p class="entree-resume">${escapeHtml(resume)}</p>
  <a class="lire" href="articles/${encodeURIComponent(a.id)}.html">lire l'analyse</a>
</li>`;
    })
    .join("");

  return page({
    title: SITE_NAME,
    active: "articles",
    path: "/",
    body: `<div class="section">a la une</div>
<ol class="articles">${entrees}</ol>`,
  });
}

/** Page 404. Statique, sans dependance au serveur qui la sert. */
export function notFoundPage(): string {
  return page({
    title: `Page introuvable — ${SITE_NAME}`,
    path: "/404.html",
    body: `<div class="section">404</div>
<div class="vide">Cette page n'existe pas ou a ete retiree.<br>
Un article retire du site l'est generalement parce que son attestation de
relecture ne correspondait plus a son contenu.<br><br>
<a href="./index.html">Retour aux articles</a></div>`,
  });
}

/* -------------------------------------------------------------------------
 * Pages documentaires
 * ---------------------------------------------------------------------- */

export function documentPage(
  title: string,
  markdown: string,
  active: NonNullable<PageOptions["active"]>,
): string {
  return page({
    title: `${title} — ${SITE_NAME}`,
    active,
    body: `<article><div class="corps">${renderMarkdown(markdown)}</div></article>`,
  });
}
