/**
 * Routage vers l'Investigateur, et cadence de publication.
 *
 * DEUX EXIGENCES QUI NE PEUVENT PAS ETRE DES CONSIGNES DE PROMPT.
 *
 * 1. « Seuls les sujets qui repondent aux criteres d'enquete lui sont
 *    assignes. » Un prompt qui demande au modele de juger s'il doit enqueter
 *    fait juger le juge : il acceptera, parce que c'est ce qu'on lui propose.
 *    Le tri est donc fait AVANT l'appel au modele, par du code.
 *
 * 2. « Moins d'articles publies, mais un temps de recherche plus long. » Un
 *    prompt qui dit « prends ton temps » ne ralentit rien : le modele repond
 *    en quelques secondes et le pipeline enchaine. Seul un QUOTA tenu par
 *    l'orchestrateur produit une cadence reelle.
 */

import { describe, expect, it } from "vitest";

import {
  CRITERES_ENQUETE,
  QUOTA_ENQUETES_PAR_SEMAINE,
  type Investigation,
  enqueteAutorisee,
  enquetesDepuisArticles,
  evaluerSujet,
  prochaineFenetre,
} from "../src/planification/investigation.js";

/* -------------------------------------------------------------------------
 * Routage
 * ---------------------------------------------------------------------- */

describe("routage — quels sujets meritent une enquete", () => {
  it("retient un sujet dont les sources se CONTREDISENT", () => {
    const d = evaluerSujet({
      sujet: "ecart entre l'inflation mesuree par Eurostat et celle de la Banque mondiale",
      sourcesDisponibles: 6,
      emetteursDistincts: 3,
      sourcesEnDesaccord: true,
      mecanismeAExpliquer: false,
      zonesDombre: false,
    });
    expect(d.route).toBe("investigateur");
    expect(d.criteres).toContain("sources-en-desaccord");
  });

  it("retient un sujet dont le MECANISME demande a etre demonte", () => {
    const d = evaluerSujet({
      sujet: "comment le bilan d'une banque centrale agit sur le cout du credit",
      sourcesDisponibles: 5,
      emetteursDistincts: 3,
      sourcesEnDesaccord: false,
      mecanismeAExpliquer: true,
      zonesDombre: false,
    });
    expect(d.route).toBe("investigateur");
  });

  it("retient un sujet a fort enjeu comportant des ZONES D'OMBRE", () => {
    const d = evaluerSujet({
      sujet: "designations de sanctions : ce que les listes publiques ne disent pas",
      sourcesDisponibles: 5,
      emetteursDistincts: 4,
      sourcesEnDesaccord: false,
      mecanismeAExpliquer: false,
      zonesDombre: true,
    });
    expect(d.route).toBe("investigateur");
  });

  it("REFUSE un sujet qui ne remplit aucun critere", () => {
    // Le cas courant. Une breve n'a pas besoin de 2000 mots, et lui en donner
    // produirait du remplissage — exactement ce que BODY_IS_CLAIM_PASTE
    // sanctionne deja sur les formats courts.
    const d = evaluerSujet({
      sujet: "dernier releve du taux directeur",
      sourcesDisponibles: 4,
      emetteursDistincts: 2,
      sourcesEnDesaccord: false,
      mecanismeAExpliquer: false,
      zonesDombre: false,
    });
    expect(d.route).toBe("production-courante");
    expect(d.motif).toMatch(/aucun critere/i);
  });

  it("REFUSE meme un sujet qualifie si la matiere est trop mince", () => {
    // Une enquete de 1500 mots adossee a deux sources serait un commentaire
    // deguise. Le plancher de matiere prime sur les criteres : c'est la
    // condition qui rend l'enquete possible, pas celle qui la justifie.
    const d = evaluerSujet({
      sujet: "un mecanisme complexe mais mal documente",
      sourcesDisponibles: 2,
      emetteursDistincts: 1,
      sourcesEnDesaccord: true,
      mecanismeAExpliquer: true,
      zonesDombre: true,
    });
    expect(d.route).toBe("production-courante");
    expect(d.motif).toMatch(/matiere|source/i);
  });

  it("exige plusieurs EMETTEURS, pas seulement plusieurs documents", () => {
    // Six documents du meme emetteur ne se recoupent pas : ils se repetent.
    const d = evaluerSujet({
      sujet: "serie longue publiee par un seul institut",
      sourcesDisponibles: 8,
      emetteursDistincts: 1,
      sourcesEnDesaccord: false,
      mecanismeAExpliquer: true,
      zonesDombre: true,
    });
    expect(d.route).toBe("production-courante");
    expect(d.motif).toMatch(/emetteur/i);
  });

  it("expose ses criteres, pour qu'ils soient discutables", () => {
    expect(CRITERES_ENQUETE.length).toBeGreaterThanOrEqual(3);
  });
});

/* -------------------------------------------------------------------------
 * Cadence
 * ---------------------------------------------------------------------- */

const investigation = (o: Partial<Investigation> = {}): Investigation => ({
  sujet: "sujet",
  ouverte_le: "2026-09-01T00:00:00.000Z",
  statut: "publiee",
  article_id: "article-00000000-0000-4000-8000-000000000000",
  ...o,
});

describe("cadence — un quota, pas une consigne", () => {
  const maintenant = new Date("2026-09-10T12:00:00.000Z");

  it("autorise une enquete quand le quota de la fenetre n'est pas atteint", () => {
    const d = enqueteAutorisee([], maintenant);
    expect(d.autorisee).toBe(true);
  });

  it("REFUSE au-dela du quota hebdomadaire", () => {
    const passees = Array.from({ length: QUOTA_ENQUETES_PAR_SEMAINE }, () =>
      investigation({ ouverte_le: "2026-09-09T08:00:00.000Z" }),
    );
    const d = enqueteAutorisee(passees, maintenant);
    expect(d.autorisee).toBe(false);
    expect(d.motif).toMatch(/quota/i);
  });

  it("ne compte QUE la fenetre courante : une enquete ancienne ne bloque rien", () => {
    const vieilles = Array.from({ length: QUOTA_ENQUETES_PAR_SEMAINE + 3 }, () =>
      investigation({ ouverte_le: "2026-07-01T08:00:00.000Z" }),
    );
    expect(enqueteAutorisee(vieilles, maintenant).autorisee).toBe(true);
  });

  it("compte une enquete EN COURS comme consommant le quota", () => {
    // Sans cela, l'orchestrateur en ouvrirait autant qu'il veut tant qu'aucune
    // n'est publiee — le quota ne tiendrait qu'apres coup, donc jamais.
    const passees = Array.from({ length: QUOTA_ENQUETES_PAR_SEMAINE }, () =>
      investigation({
        ouverte_le: "2026-09-09T08:00:00.000Z",
        statut: "en-cours",
        article_id: null,
      }),
    );
    expect(enqueteAutorisee(passees, maintenant).autorisee).toBe(false);
  });

  it("ne compte PAS une piste abandonnee : elle n'a rien publie", () => {
    // « L'agent doit pouvoir signaler qu'une piste n'est pas assez solide. »
    // Si l'abandon consommait le quota, renoncer couterait aussi cher que
    // publier — et l'agent serait incite a forcer l'article.
    const abandonnees = Array.from({ length: QUOTA_ENQUETES_PAR_SEMAINE + 2 }, () =>
      investigation({
        ouverte_le: "2026-09-09T08:00:00.000Z",
        statut: "abandonnee",
        article_id: null,
      }),
    );
    expect(enqueteAutorisee(abandonnees, maintenant).autorisee).toBe(true);
  });

  it("dit QUAND la prochaine enquete sera possible", () => {
    // Un refus sans date rend la cadence opaque ; l'editeur doit pouvoir
    // planifier plutot que reessayer au hasard.
    const passees = Array.from({ length: QUOTA_ENQUETES_PAR_SEMAINE }, () =>
      investigation({ ouverte_le: "2026-09-09T08:00:00.000Z" }),
    );
    const d = enqueteAutorisee(passees, maintenant);
    expect(d.autorisee).toBe(false);
    expect(Date.parse(d.prochaineOuverture ?? "")).toBeGreaterThan(maintenant.getTime());
  });

  it("la cadence est BEAUCOUP plus lente que celle des vagues", () => {
    // Six articles toutes les quatre heures font 42 par semaine. Le quota
    // d'enquetes doit rester d'un autre ordre de grandeur, sans quoi la
    // distinction entre les deux formats ne serait qu'affichee.
    expect(QUOTA_ENQUETES_PAR_SEMAINE).toBeLessThanOrEqual(2);
  });

  it("borne la fenetre a sept jours", () => {
    const f = prochaineFenetre(maintenant);
    const jours = (Date.parse(f) - maintenant.getTime()) / 86_400_000;
    expect(jours).toBeGreaterThan(0);
    expect(jours).toBeLessThanOrEqual(7);
  });
});

describe("historique reconstitue depuis les brouillons", () => {
  it("ne retient QUE les articles en mode enquete", () => {
    const h = enquetesDepuisArticles([
      { id: "a1", mode: "enquete", published_at: "2026-09-09T00:00:00.000Z", title: "E" },
      { id: "a2", mode: "constat", published_at: "2026-09-09T00:00:00.000Z", title: "C" },
      { id: "a3", published_at: "2026-09-09T00:00:00.000Z", title: "sans mode" },
    ]);
    expect(h).toHaveLength(1);
    expect(h[0]?.article_id).toBe("a1");
  });

  it("les marque `publiee` : un brouillon existant est une enquete faite", () => {
    // Reconstituer l'historique depuis le CONTENU du dossier evite un fichier
    // d'etat separe, qui divergerait du reel des la premiere suppression
    // manuelle d'un brouillon.
    const h = enquetesDepuisArticles([
      { id: "a1", mode: "enquete", published_at: "2026-09-09T00:00:00.000Z", title: "E" },
    ]);
    expect(h[0]?.statut).toBe("publiee");
    expect(h[0]?.ouverte_le).toBe("2026-09-09T00:00:00.000Z");
  });
});
