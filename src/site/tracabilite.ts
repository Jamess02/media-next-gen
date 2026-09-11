/**
 * Convention de tracabilite, et surfaces d'entree pour les machines.
 *
 * Dependances : `markdown.ts` (echappement HTML) et les types du protocole.
 * Aucune dependance npm.
 *
 * METHODE REPRISE, PAS SOURCE CITEE. l0g.fr publie une convention de citation
 * en trois regles et un ensemble de surfaces lisibles par machine. On en
 * reprend la METHODE. C'est le seul usage admis de ce site dans ce projet :
 * il n'est jamais cite comme source d'un fait.
 *
 * LES TROIS REGLES
 *
 *   CITER          nom, site, DATE DE CONSULTATION, lien permanent
 *   DATER          « Une valeur courante n'est pas une observation historique
 *                  retroactive »
 *   CONTEXTUALISER « Deux niveaux identiques ne sont pas comparables »
 *
 * POURQUOI CELA VOYAGE AVEC L'ARTICLE
 *
 * Un article sera repris. S'il ne dit pas COMMENT le citer, il sera cite de
 * travers : chiffre sans date, valeur sortie de son perimetre, lien vers
 * l'accueil au lieu de l'article. Une convention rangee dans une page « a
 * propos » ne protege rien, parce que celui qui reprend ne l'ouvre pas.
 */

import type { Article } from "../protocol/schema.js";
import { escapeHtml } from "./markdown.js";

/**
 * Bloc « comment citer cet article », rendu sur chaque page d'article.
 *
 * La date de CONSULTATION n'est pas fournie : le site ne la connait pas, elle
 * depend du moment de la reprise. Il la reclame explicitement — c'est la seule
 * des trois regles que le lecteur doit completer lui-meme.
 */
export function blocDeCitation(article: Article, base: string): string {
  const lien = `${base}/articles/${article.id}.html`;
  const titre = escapeHtml(article.title);
  const publie = article.published_at.slice(0, 10);

  return [
    `<section class="citation" aria-labelledby="citer">`,
    `<h2 id="citer">Comment citer cet article</h2>`,
    `<p class="regle"><strong>Citer.</strong> « ${titre} », publie le ${publie}, `,
    `consulte le <em>[date de votre consultation]</em>. Lien permanent : `,
    `<a href="${escapeHtml(lien)}">${escapeHtml(lien)}</a>.</p>`,
    `<p class="regle"><strong>Dater.</strong> Conserver la date du point publie. `,
    `Une valeur courante n'est pas une observation historique retroactive : `,
    `reprendre un chiffre sans sa date le rend invérifiable.</p>`,
    `<p class="regle"><strong>Contextualiser.</strong> Chaque chiffre porte sa `,
    `propre methode et son propre perimetre. Deux valeurs alignees dans un `,
    `tableau ne sont pas comparables pour autant : le type et le niveau de `,
    `preuve figurent a cote de chacune, et font partie de la citation.</p>`,
    `<p class="meta">Reutilisation libre avec attribution. Les sources citees `,
    `restent la propriete de leurs emetteurs.</p>`,
    `</section>`,
  ].join("");
}

/**
 * `llms.txt` — point d'entree compact pour les systemes automatises.
 *
 * Un agent qui arrive sur le site ne doit pas avoir a deviner ou sont les
 * donnees ni ce que le site refuse d'etre. Ce fichier le dit en un aller,
 * plutot que de laisser moissonner des pages HTML pour reconstituer ce qui est
 * deja publie en JSON.
 *
 * Il reste COURT a dessein : un point d'entree qui recopierait le site
 * cesserait d'en etre un.
 */
export function llmsTxt(articles: readonly Article[], base: string): string {
  return [
    "# Media Next Gen",
    "",
    "Pipeline editorial multi-agents (geopolitique, economie).",
    "Chaque affirmation publiee est typee, sourcee, datee et contestable.",
    "",
    "## Ce que ce site N'EST PAS",
    "",
    "Ni un conseil d'investissement, ni une recommandation politique ou",
    "electorale (EP-007). Les scenarios sont des hypotheses conditionnelles,",
    "jamais des previsions.",
    "",
    "## Surfaces lisibles par machine",
    "",
    `- ${base}/api/articles.json   articles, claims, sources, niveaux de preuve`,
    `- ${base}/agents.json         ce que le site expose, licence, limites`,
    `- ${base}/integrity.json      empreintes des pages publiees`,
    `- ${base}/status.json         fraicheur et etat de la derniere generation`,
    `- ${base}/feed.xml            fil de publication`,
    `- ${base}/sitemap.xml         plan du site`,
    "",
    "## Comment citer",
    "",
    "Titre, date de publication, date de consultation, lien permanent de",
    "l'article. Conserver la date du point publie : une valeur courante n'est",
    "pas une observation retroactive. Reutilisation libre avec attribution.",
    "",
    "## Etat",
    "",
    `${articles.length} article(s) relu(s) et publie(s).`,
    "Un article non relu par une personne nommee n'est jamais publie ici.",
    "",
  ].join("\n");
}

/**
 * `status.json` — fraicheur du site, verifiable sans le parcourir.
 *
 * Un site qui ne dit pas son age laisse croire qu'il est a jour. L'age du
 * contenu le plus recent est la mesure la plus honnete dont on dispose : elle
 * ne se degrade pas silencieusement, elle augmente.
 */
export function statusSurface(
  articles: readonly Article[],
  maintenant: Date,
): Record<string, unknown> {
  const dates = articles
    .map((a) => Date.parse(a.published_at))
    .filter((t) => !Number.isNaN(t));

  const plusRecent = dates.length === 0 ? null : Math.max(...dates);

  return {
    genere_le: maintenant.toISOString(),
    articles_publies: articles.length,
    plus_recent_le: plusRecent === null ? null : new Date(plusRecent).toISOString(),
    age_du_plus_recent_en_jours:
      plusRecent === null
        ? null
        : Math.floor((maintenant.getTime() - plusRecent) / 86_400_000),
    // Rappel porte par la surface elle-meme : ce compte ne recense QUE les
    // articles relus. Les brouillons n'y figurent pas, par construction.
    note:
      "Seuls les articles relus par une personne nommee sont comptes. " +
      "Les brouillons du pipeline ne sont pas publies.",
  };
}
