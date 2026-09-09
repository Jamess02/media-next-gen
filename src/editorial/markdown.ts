/**
 * Neutralisation du markdown provenant de sources externes.
 *
 * Module feuille : aucun import, aucune dependance npm.
 *
 * MENACE TRAITEE
 *
 * Les resumes de sources, les drapeaux d'incertitude et les textes de claims
 * transitent verbatim jusqu'au markdown publie. Une source compromise — ou
 * simplement un titre d'article contenant des crochets — peut donc injecter
 * un lien, une image de traçage ou du HTML brut dans un article.
 *
 * Le rendu markdown du site transformera ces constructions en HTML reel. Le
 * §5.4 prevoit explicitement ce site : la faille est latente, pas theorique.
 *
 * DEUX TRAITEMENTS DISTINCTS, parce que les deux entrees n'ont pas le meme statut
 *
 *  - `escapeSourceText` : pour les champs de DONNEES (texte de claim, drapeaux,
 *    claims ecartees). Aucune mise en forme n'y est legitime : on echappe tout
 *    ce qui cree du balisage.
 *  - `neutralizeAuthoredMarkdown` : pour le CORPS, redige par le Redacteur et
 *    ou la mise en forme EST legitime. On y retire seulement le HTML brut et
 *    les cibles de lien a schema non autorise — tout echapper casserait
 *    l'article.
 *
 * Ce module reduit le rayon d'action ; il ne remplace pas un rendu sur avec
 * HTML desactive cote site. C'est une defense en profondeur, pas une garantie.
 */

/** Schemas autorises pour une cible de lien rendue. */
const SAFE_LINK_SCHEME = /^(?:https?:|#|\/|\.{1,2}\/)/i;

/**
 * Caracteres qui n'ont aucune apparence propre mais qui changent ce que l'oeil
 * lit.
 *
 * DEUX FAMILLES, un meme effet : le texte stocke dit une chose, le texte
 * affiche en dit une autre — et c'est l'affiche que le lecteur croit.
 *
 *  - forcage bidirectionnel (U+202A-U+202E, U+2066-U+2069, U+200E, U+200F) :
 *    inverse l'ordre d'affichage de ce qui suit. « -569 MUSD » peut s'afficher
 *    « DSUM 965- ». Sur un media dont la promesse est qu'une affirmation puisse
 *    etre relue et contestee, un texte qui ne se lit pas tel qu'il est ecrit
 *    ruine la promesse a la racine ;
 *  - largeur nulle (U+200B-U+200D, U+2060, U+FEFF) : glisses dans une URL
 *    AFFICHEE, ils la font ressembler a un domaine legitime alors que la cible
 *    du lien est ailleurs.
 *
 * L'echappement markdown ne les voit pas : ils ne produisent aucun balisage.
 * Ce sont les seuls caracteres que ce module RETIRE au lieu d'echapper — on ne
 * peut pas rendre inoffensif ce qui agit par sa seule presence.
 */
const CONTROLES_INVISIBLES = /[​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Retire ces caracteres EN LE DISANT.
 *
 * Les supprimer en silence modifierait un texte de source sans laisser de
 * trace, ce que le §8 refuse au meme titre qu'une date effacee. Le lecteur voit
 * qu'il manque quelque chose, et lequel.
 */
export function neutralizeInvisible(text: string): string {
  return text.replace(CONTROLES_INVISIBLES, (c) => {
    const point = c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
    return `[caractere invisible retire : U+${point}]`;
  });
}

/**
 * Echappe le balisage markdown dans un texte de donnee.
 *
 * Les caracteres invisibles sont retires EN PREMIER : les echapper n'aurait
 * aucun effet, puisqu'ils n'ont pas d'apparence a echapper.
 *
 * L'antislash vient ensuite : le traiter apres les autres re-echapperait les
 * antislashs qu'on vient d'introduire.
 */
export function escapeSourceText(text: string): string {
  return neutralizeInvisible(text)
    .replace(/\\/g, "\\\\")
    // Liens et images.
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    // HTML brut et autolinks.
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Code inline, qui peut masquer d'autres constructions.
    .replace(/`/g, "\\`");
}

/**
 * Encode une URL pour servir de cible de lien.
 *
 * Le schema est deja valide en amont (voir protocol/url.ts) ; ici on empeche
 * seulement de casser la syntaxe `[texte](cible)` avec une parenthese ou une
 * espace, ce qui permettrait de faire deborder du contenu hors du lien.
 */
export function escapeLinkTarget(url: string): string {
  return url
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/"/g, "%22")
    .replace(/\s/g, "%20");
}

/**
 * Nettoie un markdown redige par un agent, en preservant sa mise en forme.
 *
 * Deux passes seulement :
 *  1. le HTML brut est neutralise (`<` devient `&lt;`), ce qui elimine
 *     `<script>`, `<iframe>`, `<img onerror=...>` et les autolinks piegees ;
 *  2. toute cible de lien ou d'image dont le schema n'est pas autorise est
 *     remplacee, le texte du lien etant conserve pour que le lecteur voie
 *     qu'il y avait quelque chose.
 */
export function neutralizeAuthoredMarkdown(markdown: string): string {
  const withoutHtml = markdown.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return withoutHtml.replace(
    /(!?\[[^\]]*\])\(([^)]*)\)/g,
    (match, label: string, target: string) => {
      const trimmed = target.trim();
      if (SAFE_LINK_SCHEME.test(trimmed)) return match;
      return `${label}(lien-retire:schema-non-autorise)`;
    },
  );
}
