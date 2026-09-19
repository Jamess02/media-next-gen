/**
 * Le SECRETAIRE DE REDACTION — celui qui depouille les relectures et les
 * repartit entre les agents concernes.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Demande de l'editeur du 2026-09-19, en reponse a une limite que la veille
 * avait laissee ouverte : les notes de relecture partaient TOUTES au Redacteur.
 * Or « chercher des informations supplementaires sur l'Afghanistan » ne
 * s'adresse pas a lui — il ecrit a partir de la matiere qu'on lui donne, il ne
 * va pas en chercher. Cette consigne-la tombait dans le vide.
 *
 * POURQUOI UN AGENT, ET NON UNE REGLE DE MOTS-CLES. Decider qu'une remarque
 * vise la collecte plutot que l'ecriture est un jugement editorial. Une table
 * de mots-cles se tromperait sur « il faudrait plus de sources sur le ton
 * employe », et une consigne mal aiguillee est pire qu'une consigne perdue :
 * elle arrive chez quelqu'un qui ne peut rien en faire, et occupe la place.
 *
 * LE GARDE-FOU EST DU CODE, PAS UNE CONSIGNE. Chaque consigne repartie doit
 * citer la note DONT ELLE VIENT, et le pipeline rejette celles dont l'origine
 * ne se retrouve dans aucune note transmise. Sans ce filtre, le secretaire
 * pourrait fabriquer une consigne que personne n'a ecrite et la faire passer
 * pour une demande de l'editeur.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENT_ROLES } from "../src/protocol/constants.js";
import {
  DESTINATAIRES_DE_CONSIGNE,
  INSTRUCTIONS_SECRETAIRE,
  SecretaireOutputSchema,
  filtrerConsignes,
} from "../src/agents/secretaire.js";

const NOTES = [
  "2026-09-19 — jemunzu : il serait bon de chercher des informations supplementaires notamment sur l'afghanistan",
  "2026-09-10 — jemunzu : parler des consequences des seismes et des actions mises en place par les gouvernements",
];

/* -------------------------------------------------------------------------
 * 1. Le contrat de sortie
 * ---------------------------------------------------------------------- */

describe("format de reponse du secretaire", () => {
  it("accepte une repartition bien formee", () => {
    const parsed = SecretaireOutputSchema.safeParse({
      consignes: [
        {
          destinataire: "veilleur",
          consigne: "chercher des sources couvrant l'Afghanistan",
          origine: NOTES[0],
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REFUSE un destinataire qui n'est pas un agent connu", () => {
    // Sans enumeration fermee, le secretaire inventerait des destinataires et
    // la consigne n'arriverait nulle part.
    const parsed = SecretaireOutputSchema.safeParse({
      consignes: [
        { destinataire: "documentaliste", consigne: "faire mieux", origine: NOTES[0] },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSE une consigne sans origine : elle doit venir d'une note", () => {
    const parsed = SecretaireOutputSchema.safeParse({
      consignes: [{ destinataire: "veilleur", consigne: "faire mieux", origine: "" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepte une repartition VIDE : une note peut ne concerner personne", () => {
    expect(SecretaireOutputSchema.safeParse({ consignes: [] }).success).toBe(true);
  });

  it("ne vise que des agents REELS du protocole", () => {
    // La liste des destinataires ne doit pas deriver de celle des roles : un
    // destinataire absent de AGENT_ROLES designerait un agent qui n'existe pas.
    for (const d of DESTINATAIRES_DE_CONSIGNE) {
      expect(AGENT_ROLES, `destinataire inconnu : ${d}`).toContain(d);
    }
  });

  it("ne declare QUE des agents reellement cables", async () => {
    // La garantie centrale. Declarer un destinataire que personne ne sert
    // recreerait le probleme que cet agent corrige : une consigne produite,
    // aiguillee, puis perdue — avec en prime l'apparence d'un traitement.
    const RACINE = fileURLToPath(new URL("..", import.meta.url));
    const FICHIER: Record<string, string> = {
      veilleur: "src/agents/veilleur.ts",
      analyste: "src/agents/analyste.ts",
      redacteur: "src/agents/redacteur.ts",
      investigateur: "src/agents/investigateur.ts",
    };

    for (const d of DESTINATAIRES_DE_CONSIGNE) {
      const fichier = FICHIER[d];
      expect(fichier, `aucun fichier connu pour le destinataire ${d}`).toBeDefined();
      const source = await readFile(join(RACINE, fichier as string), "utf8");
      expect(source, `${d} ne sait pas recevoir de consignes`).toMatch(
        /consignesDeRelecture/,
      );
    }
  });

  it("ne s'adresse PAS a lui-meme ni a l'editeur", () => {
    // Le secretaire ne se donne pas d'ordres, et l'editeur n'ecrit rien : il
    // applique le controle final. Une consigne pour eux serait perdue.
    expect(DESTINATAIRES_DE_CONSIGNE).not.toContain("secretaire-de-redaction");
    expect(DESTINATAIRES_DE_CONSIGNE).not.toContain("editeur");
  });
});

/* -------------------------------------------------------------------------
 * 2. Le filtre anti-invention
 * ---------------------------------------------------------------------- */

describe("filtre — une consigne vient TOUJOURS d'une note", () => {
  it("garde une consigne dont l'origine est une note transmise", () => {
    const gardees = filtrerConsignes(NOTES, {
      consignes: [
        {
          destinataire: "veilleur",
          consigne: "chercher des sources sur l'Afghanistan",
          origine: NOTES[0] as string,
        },
      ],
    });
    expect(gardees).toHaveLength(1);
    expect(gardees[0]?.destinataire).toBe("veilleur");
  });

  it("REJETTE une consigne dont l'origine ne vient d'aucune note", () => {
    // Le scenario a empecher : le secretaire fabrique une demande et la fait
    // passer pour une consigne de l'editeur. Le filtre est du code, pas une
    // recommandation dans un prompt.
    const gardees = filtrerConsignes(NOTES, {
      consignes: [
        {
          destinataire: "redacteur",
          consigne: "raccourcir les articles de moitie",
          origine: "2026-09-19 — jemunzu : raccourcir les articles de moitie",
        },
      ],
    });
    expect(gardees).toEqual([]);
  });

  it("accepte une origine CITEE partiellement", () => {
    // Recopier une note entiere n'a rien d'evident pour un modele ; exiger
    // l'egalite stricte ferait tomber des consignes legitimes. Un extrait
    // suffit, tant qu'il provient reellement d'une note.
    const gardees = filtrerConsignes(NOTES, {
      consignes: [
        {
          destinataire: "veilleur",
          consigne: "couvrir l'Afghanistan",
          origine: "chercher des informations supplementaires notamment sur l'afghanistan",
        },
      ],
    });
    expect(gardees).toHaveLength(1);
  });

  it("ignore la casse et les espaces en trop", () => {
    const gardees = filtrerConsignes(NOTES, {
      consignes: [
        {
          destinataire: "veilleur",
          consigne: "couvrir l'Afghanistan",
          origine: "  CHERCHER DES INFORMATIONS   SUPPLEMENTAIRES  ",
        },
      ],
    });
    expect(gardees).toHaveLength(1);
  });

  it("REJETTE une origine trop courte pour prouver quoi que ce soit", () => {
    // « sur » se retrouve dans n'importe quelle note : une origine de trois
    // lettres ne rattache la consigne a rien.
    const gardees = filtrerConsignes(NOTES, {
      consignes: [
        { destinataire: "veilleur", consigne: "faire mieux", origine: "sur" },
      ],
    });
    expect(gardees).toEqual([]);
  });

  it("rend une liste vide quand aucune note n'a ete transmise", () => {
    expect(
      filtrerConsignes([], {
        consignes: [
          { destinataire: "veilleur", consigne: "x", origine: "quelque chose" },
        ],
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 3. Ce que le secretaire sait de sa tache
 * ---------------------------------------------------------------------- */

describe("instructions du secretaire", () => {
  it("nomme CHAQUE destinataire possible et ce dont il s'occupe", () => {
    for (const d of DESTINATAIRES_DE_CONSIGNE) {
      expect(INSTRUCTIONS_SECRETAIRE, d).toContain(d);
    }
  });

  it("exige de citer la note d'origine", () => {
    expect(INSTRUCTIONS_SECRETAIRE).toMatch(/origine/i);
  });

  it("INTERDIT d'inventer une consigne", () => {
    expect(INSTRUCTIONS_SECRETAIRE).toMatch(/n'invente|ne fabrique|jamais une consigne/i);
  });

  it("autorise a n'attribuer AUCUN destinataire", () => {
    // Une note du type « bon article » ne demande rien a personne. Forcer une
    // attribution produirait une consigne creuse qui occuperait la place.
    expect(INSTRUCTIONS_SECRETAIRE).toMatch(/aucun|ne concerne personne|laisse-la de cote/i);
  });

  it("rappelle qu'une consigne ne leve aucune regle", () => {
    expect(INSTRUCTIONS_SECRETAIRE).toMatch(/ne leve|aucune regle|n'autorise/i);
  });
});
