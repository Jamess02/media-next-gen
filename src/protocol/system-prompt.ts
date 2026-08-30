/**
 * §9.1 — "Chaque agent du pipeline [...] doit recevoir ce protocole comme
 * prompt systeme, pas seulement une instruction de role vague."
 *
 * Le protocole est lu depuis le fichier markdown a la racine, pas recopie dans
 * le code. Une copie divergerait du document de reference des la premiere
 * revision ; ici, editer `protocole-editorial-v1.md` change le comportement de
 * tous les agents, ce qui est le point.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRole } from "./constants.js";

// ESM : `__dirname` n'existe pas, on le derive de import.meta.url.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_PATH = join(HERE, "..", "..", "protocole-editorial-v1.md");

let cached: string | undefined;

/** Texte integral du protocole. Lu une fois, puis memorise pour le process. */
export function loadProtocol(): string {
  cached ??= readFileSync(PROTOCOL_PATH, "utf8");
  return cached;
}

/**
 * §9.7 — "Avant d'ecrire le code d'un agent, relis la section correspondante".
 * Cote runtime, l'equivalent est de rappeler a l'agent quelle section le
 * gouverne, en plus du texte integral.
 */
const ROLE_CLAUSE: Record<AgentRole, string> = {
  veilleur: "§5.1",
  analyste: "§5.2",
  "fact-checker": "§5.2 et §9.3",
  redacteur: "§5.3",
  "redacteur-en-chef": "§5.4",
  editeur: "§5.4",
};

export interface SystemPromptOptions {
  role: AgentRole;
  /** Instructions propres au role, appliquees PAR-DESSUS le protocole. */
  roleInstructions: string;
}

export interface SystemPromptParts {
  /**
   * Le protocole seul. Prefixe STABLE, identique pour les six agents : c'est
   * lui qui porte le point de cache cote Anthropic. Toute variation ici
   * invaliderait le cache de tous les agents a la fois.
   */
  protocol: string;
  /** Partie volatile : role, instructions propres, contraintes de sortie. */
  roleInstructions: string;
  /** Les deux concatenes, pour les APIs a message systeme unique. */
  system: string;
}

export function buildSystemPrompt({
  role,
  roleInstructions,
}: SystemPromptOptions): SystemPromptParts {
  const protocol = loadProtocol();

  const rolePart = [
    "---",
    "",
    `# Ton role dans la chaine : \`${role}\` (${ROLE_CLAUSE[role]})`,
    "",
    roleInstructions.trim(),
    "",
    "## Contraintes de sortie",
    "",
    "- Reponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans bloc de code markdown.",
    "- N'invente jamais une URL. Si tu n'as pas de source, dis-le dans le champ prevu.",
    "- Ne supprime jamais une date.",
    "- Si tu ne peux pas respecter le protocole avec les elements fournis, renvoie",
    "  le champ d'erreur prevu par ton schema plutot que de produire un resultat",
    "  non conforme.",
  ].join("\n");

  return {
    protocol,
    roleInstructions: rolePart,
    system: `${protocol}\n\n${rolePart}`,
  };
}
