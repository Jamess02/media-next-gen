/**
 * Fournisseurs LLM disponibles.
 *
 * Dependances : `openai-compatible-client.ts`, `anthropic-client.ts`,
 * `mock-client.ts` et `types.ts`. C'est le seul module de `llm/` qui lit
 * `process.env` — meme principe que `sources/catalogue.ts` : les clients
 * recoivent leur clef en parametre, l'environnement n'est lu qu'a un endroit.
 *
 * Les quatre fournisseurs gratuits ci-dessous partagent la meme API compatible
 * OpenAI, donc le meme client. Ce qui les distingue tient en trois champs.
 *
 * AVERTISSEMENT DE QUALITE
 *
 * Un modele gratuit valide la MECANIQUE du pipeline (prompts, schemas, gate,
 * journalisation), pas sa qualite editoriale. Il ne teste pas non plus
 * `anthropic-client.ts`, qui reste le seul fichier du projet jamais execute
 * contre son API reelle. Le README le dit aussi, pour que personne ne prenne un
 * article produit par un 8B local pour une validation du pipeline complet.
 */

import type { AuditLog } from "../audit/audit-log.js";
import { AnthropicLlmClient } from "./anthropic-client.js";
import { MockLlmClient, type MockResponder } from "./mock-client.js";
import { OpenAiCompatibleLlmClient } from "./openai-compatible-client.js";
import type { LlmClient } from "./types.js";

export interface ProviderSpec {
  /** Racine de l'API compatible OpenAI. */
  baseUrl: string;
  /** Modele par defaut, surchargeable par MEDIA_MODEL. */
  defaultModel: string;
  /** Variable d'environnement portant la clef. `null` = aucune clef requise. */
  envKey: string | null;
  /** Ou obtenir une clef gratuite. Affiche quand elle manque. */
  signup: string;
  notes: string;
  /**
   * Le fournisseur applique-t-il REELLEMENT `response_format` ?
   *
   * Propriete MESUREE, pas supposee. Quand elle est fausse, le client duplique
   * le schema dans le prompt — sans quoi le modele ne le voit jamais. Quand
   * elle est vraie, cette copie est inutile et double le poids de la requete,
   * ce qui fait franchir les limites de tokens par minute des paliers gratuits.
   *
   * Absente = non verifie = traite comme faux. L'hypothese prudente est
   * qu'un fournisseur inconnu n'applique rien.
   */
  enforcesSchema?: boolean;
  /**
   * Le fournisseur parle-t-il le protocole ANTHROPIC (`/v1/messages`) plutot
   * que le protocole compatible OpenAI ?
   *
   * Change de client, pas seulement d'URL : c'est `anthropic-client.ts` qui
   * sera utilise. Voir l'entree `ollama-anthropic`.
   */
  anthropicProtocol?: boolean;
  /**
   * Authentifie par `Authorization: Bearer` au lieu de `x-api-key`.
   * Mesure, pas supposition — voir `anthropic-client.ts`.
   */
  bearerAuth?: boolean;
  /**
   * Plafond de tokens de sortie.
   *
   * Compte dans le quota par minute chez plusieurs fournisseurs : Groq
   * plafonne a 8000 TPM et y inclut la RESERVATION de sortie, pas seulement
   * les tokens reellement produits. Avec ~4000 tokens d'entree, un max_tokens
   * a 8192 fait donc echouer chaque requete avant meme d'etre traitee.
   */
  maxTokens?: number;
}

export const FREE_PROVIDERS: Record<string, ProviderSpec> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    envKey: "GROQ_API_KEY",
    signup: "https://console.groq.com/keys",
    // Verifie : les quatre modeles testables ont respecte le schema du premier
    // coup, et un modele non supporte est refuse par un 400 explicite.
    enforcesSchema: true,
    // HORS DE PORTEE DEPUIS LE 13e ADAPTATEUR — mesure, pas suppose.
    //
    // 8000 TPM, reservation de sortie incluse. La note precedente annoncait ce
    // reglage comme fragile mais fonctionnel ; il ne l'est plus. Mesure du
    // 2026-09-09, catalogue a 13 sources :
    //
    //   HTTP 413 — Request too large : 9426 demandes pour 8000 autorises
    //
    // L'ENTREE seule pese donc ~7526 tokens (protocole ~3000 + les
    // observations collectees). Baisser `maxTokens` ne sauve rien : meme a 400
    // on serait a ~7926, au bord du plafond, avec des reponses tronquees. Ce
    // n'est plus un reglage a ajuster, c'est un palier trop etroit.
    //
    // La valeur ci-dessous est CONSERVEE pour un catalogue reduit (jusqu'a une
    // dizaine de sources, ou elle tenait). Pour le catalogue complet, prendre
    // `ollama-cloud` ou `gemini`, qui n'imposent pas de plafond par minute
    // comparable. Le 413 est explicite et non retentable : le client le dit
    // ("Attendre ne changera rien") plutot que de boucler.
    maxTokens: 1900,
    notes:
      "Palier gratuit : 8000 tokens/minute ET 200 000 tokens/JOUR. " +
      "INSUFFISANT pour le catalogue complet : avec 13 sources, la requete du " +
      "Veilleur pese 9426 tokens et part en HTTP 413 avant tout traitement " +
      "(mesure le 2026-09-09). Utilisable sur un catalogue reduit uniquement. " +
      "Le plafond journalier est par ailleurs atteint en une quinzaine " +
      "d'executions. " +
      "Inference tres rapide (moins d'une seconde par appel). " +
      "Seul fournisseur gratuit teste qui APPLIQUE reellement `response_format` : " +
      "les quatre modeles testables ont respecte le schema du premier coup. " +
      "Un modele non supporte est refuse par un HTTP 400 explicite, jamais " +
      "silencieusement ignore. Alternatives : openai/gpt-oss-20b, " +
      "qwen/qwen3.8-27b, qwen/qwen3.6-27b.",
  },
  gemini: {
    // Google expose un endpoint compatible OpenAI en plus de son API native.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // `gemini-2.0-flash` figurait ici et n'existe plus au catalogue : la
    // configuration avait vieilli sans que rien ne le signale. Meme faute que
    // le `llama-3.3-70b-versatile` de Groq, disparu en cours de route et
    // decouvert par un HTTP 400 opaque.
    //
    // Choix MESURE le 2026-09-09 par COMPARAISON A SUJET CONSTANT : le meme
    // article (inflation zone euro, Eurostat) produit par chaque modele, puis
    // compare sur le nombre d avertissements du gate, la duree et la sortie.
    //
    //   gemini-3.5-flash-lite  publie, 17 s, 460 mots, tableau, 0 avert. <- retenu
    //   gemini-3.6-flash       publie, 91 s, 583 mots, tableau, 2 avert.
    //   gemini-flash-latest    HTTP 503 — sature ce jour-la
    //   gemini-3.7-flash       quota journalier epuise (voir notes)
    //
    // `gemini-3.6-flash` ecrit plus riche mais produit des phrases reduites a
    // une reference : "En effet, [[claim-1]]." — seul modele a le faire, sur
    // 14 articles. Le lite est plus rapide, plus propre, et sort le tableau.
    defaultModel: "gemini-3.5-flash-lite",
    envKey: "GEMINI_API_KEY",
    signup: "https://aistudio.google.com/apikey",
    // MESURE du 2026-09-09, sur le schema reel du Veilleur envoye a l endpoint
    // compatible OpenAI : `gemini-3.5-flash` et `gemini-3-flash-preview`
    // rendent tous deux une sortie conforme.
    enforcesSchema: true,
    notes:
      "Palier gratuit sans carte bancaire. APPLIQUE `response_format` " +
      "(verifie le 2026-09-09 sur le schema du Veilleur). Pas de plafond de " +
      "tokens par minute serre — la ou Groq bute a 8000 TPM des 13 sources. " +
      "QUOTA JOURNALIER, par MODELE (dimension `model` du quota " +
      "`generate_content_free_tier_requests`) — et il DIFFERE selon le " +
      "modele, ne pas generaliser : 20 requetes/jour MESUREES sur " +
      "`gemini-3.7-flash` (soit ~4 articles/jour a 5 appels par article), " +
      "mais les variantes `flash-lite` ont encaisse plus de 45 requetes dans " +
      "la meme journee sans le moindre 429 — leur plafond est nettement plus " +
      "haut et n a PAS ete mesure. Ne pas conclure qu une cadence est hors de " +
      "portee sans l avoir constatee sur le modele reellement utilise. " +
      "Modeles texte vus par une clef gratuite : gemini-3.8-flash, " +
      "3.7, 3.6, 3.5-flash et leurs variantes lite. `gemini-3.8-flash` et " +
      "`gemini-flash-latest` peuvent rendre HTTP 503 en forte demande.",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    envKey: "MISTRAL_API_KEY",
    signup: "https://console.mistral.ai/api-keys",
    notes: "Modeles francophones — pertinent pour un protocole redige en francais.",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    envKey: "OPENROUTER_API_KEY",
    signup: "https://openrouter.ai/keys",
    notes: "Agrege plusieurs modeles gratuits derriere une seule clef.",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    envKey: null,
    signup: "https://ollama.com/download",
    notes:
      "Ollama LOCAL, aucune clef, aucune limite. Demande l'installation d'Ollama " +
      "et le telechargement d'un modele (plusieurs Go). A ne pas confondre avec " +
      "`ollama-cloud`, qui est le service heberge.",
  },
  /**
   * OLLAMA CLOUD, EN PARLANT LE PROTOCOLE ANTHROPIC.
   *
   * Raison d'etre : `anthropic-client.ts` etait le seul module du projet a
   * n'avoir jamais tourne contre une vraie API, le mode `live` exigeant une
   * clef facturee. Ollama Cloud expose `/v1/messages` en compatibilite
   * Anthropic ; le SDK peut donc y etre dirige, et sa requete est alors recue
   * et traitee par un vrai serveur.
   *
   * MESURE DU 2026-09-09, et elle a tranche une ambiguite de la documentation
   * d'Ollama, qui montre `x-api-key: ollama` pour le serveur LOCAL :
   *
   *   POST https://ollama.com/v1/messages
   *     x-api-key: <clef>            -> HTTP 401 authentication_error
   *     Authorization: Bearer <clef> -> HTTP 200
   *
   * Le SDK Anthropic envoyant `x-api-key` par defaut, un branchement naif
   * aurait echoue et fait chercher l'erreur du mauvais cote.
   */
  "ollama-anthropic": {
    // Le SDK ajoute lui-meme `/v1/messages` : la base s'arrete au domaine.
    baseUrl: "https://ollama.com",
    defaultModel: "gpt-oss:120b",
    envKey: "OLLAMA_API_KEY",
    signup: "https://ollama.com/settings/keys",
    anthropicProtocol: true,
    bearerAuth: true,
    notes:
      "SEUL mode gratuit qui exerce reellement `anthropic-client.ts`. " +
      "NE TERMINE PAS UN PIPELINE, et c'est mesure : Ollama n'applique pas " +
      "`output_config.format`, le modele rend donc un JSON hors schema des le " +
      "Veilleur (champ `retained` absent, 2026-09-09). Ce mode sert a exercer " +
      "le CLIENT, pas a produire un article. " +
      "Ce qu'il valide : la forme de la requete emise par le SDK, " +
      "l'authentification par jeton porteur, le transport vers un vrai " +
      "serveur, et surtout le CHEMIN D'ERREUR — la conversion d'une sortie " +
      "non conforme en `LlmContractError` typee, verifiee en conditions " +
      "reelles, ce qui est justement la partie la plus facile a se tromper. " +
      "Ce qu'il NE valide PAS : que l'API d'Anthropic accepte cette requete, " +
      "ni le chemin nominal — un service compatible reste un service tiers, " +
      "et la compatibilite est partielle (ni cache de prompt, ni " +
      "`tool_choice`, ni traitement par lots).",
  },
  "ollama-cloud": {
    baseUrl: "https://ollama.com/v1",
    // Mesure sur le palier gratuit : gpt-oss:120b repond en ~2 s avec du
    // contenu exploitable. gemma4:31b est plus rapide mais plus faible ;
    // nemotron-3-super rend un contenu vide (raisonnement non expose) et
    // nemotron-3-ultra depasse le delai.
    defaultModel: "gpt-oss:120b",
    envKey: "OLLAMA_API_KEY",
    signup: "https://ollama.com/settings/keys",
    notes:
      "Service heberge. IMPORTANT : le palier gratuit ne couvre que quelques " +
      "modeles (gpt-oss:20b et 120b, gemma4:31b, nemotron-3-nano). Les gros " +
      "modeles (qwen3.5:397b, mistral-large-3, glm-5.x, kimi, deepseek) " +
      "repondent HTTP 402 sans abonnement. Aucun modele gratuit teste ne " +
      "respecte `json_schema` : la boucle de reparation du client est donc " +
      "indispensable ici.",
  },
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "local-model",
    envKey: null,
    signup: "https://lmstudio.ai",
    notes: "Local, serveur compatible OpenAI expose par LM Studio.",
  },
};

export type ProviderName = keyof typeof FREE_PROVIDERS | "anthropic" | "mock";

export interface ResolveProviderInput {
  provider: ProviderName;
  audit: AuditLog;
  responders: Record<string, MockResponder>;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedProvider {
  client: LlmClient;
  /** Avertissements a afficher : qualite attendue, clef manquante, etc. */
  notices: string[];
}

export class ProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

/**
 * Lit une variable d'environnement en traitant la chaine VIDE comme absente.
 *
 * `.env` declare volontairement des variables vides pour documenter leur
 * existence (`MEDIA_MODEL=`). Sans cette normalisation, `env[x] ?? defaut`
 * rendrait la chaine vide — `??` ne se declenche que sur null/undefined — et
 * le pipeline demanderait un modele sans nom.
 */
function readEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function resolveProvider(input: ResolveProviderInput): ResolvedProvider {
  const env = input.env ?? process.env;
  const notices: string[] = [];

  if (input.provider === "mock") {
    return {
      client: new MockLlmClient({ audit: input.audit, responders: input.responders }),
      notices,
    };
  }

  const overrideModel = readEnv(env, "MEDIA_MODEL");

  if (input.provider === "anthropic") {
    if (readEnv(env, "ANTHROPIC_API_KEY") === undefined) {
      throw new ProviderUnavailable(
        "ANTHROPIC_API_KEY absente. La renseigner dans .env, ou choisir un " +
          "fournisseur gratuit : --provider=groq | gemini | mistral | openrouter | ollama.",
      );
    }
    // Surcharge d'URL : passerelle d'entreprise, proxy, ou serveur controle
    // pour exercer ce client sans facturation.
    const baseUrl = readEnv(env, "ANTHROPIC_BASE_URL");
    if (baseUrl !== undefined) {
      notices.push(
        `API Anthropic redirigee vers ${baseUrl} — ce n'est PAS l'API officielle.`,
      );
    }

    return {
      client: new AnthropicLlmClient({
        audit: input.audit,
        ...(overrideModel === undefined ? {} : { model: overrideModel }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }),
      notices,
    };
  }

  const spec = FREE_PROVIDERS[input.provider];
  if (spec === undefined) {
    throw new ProviderUnavailable(
      `Fournisseur inconnu : ${input.provider}. Disponibles : ` +
        `${Object.keys(FREE_PROVIDERS).join(", ")}, anthropic, mock.`,
    );
  }

  let apiKey: string | undefined;
  if (spec.envKey !== null) {
    const value = readEnv(env, spec.envKey);
    if (value === undefined) {
      throw new ProviderUnavailable(
        `${spec.envKey} absente pour le fournisseur "${input.provider}".\n` +
          `  Clef gratuite : ${spec.signup}\n` +
          `  A placer dans .env (jamais commite).`,
      );
    }
    apiKey = value;
  }

  notices.push(
    "Fournisseur gratuit : la mecanique du pipeline est testee (prompts, schemas, " +
      "gate, journalisation), pas la qualite editoriale.",
  );

  // Un fournisseur qui parle le protocole Anthropic change de CLIENT, pas
  // seulement d'URL. C'est le seul chemin gratuit qui exerce reellement
  // `anthropic-client.ts`.
  if (spec.anthropicProtocol === true) {
    notices.push(
      "Ce mode exerce `anthropic-client.ts` contre un vrai serveur — mais un " +
        "serveur COMPATIBLE, pas l'API d'Anthropic.",
      "Il n'ira PAS jusqu'a un article : Ollama n'applique pas le schema de " +
        "sortie, le Veilleur echouera donc sur un JSON hors contrat. C'est " +
        "attendu — ce mode exerce le client, pas la chaine editoriale.",
    );
    return {
      client: new AnthropicLlmClient({
        audit: input.audit,
        model: overrideModel ?? spec.defaultModel,
        baseUrl: spec.baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(spec.bearerAuth === true ? { bearerAuth: true } : {}),
      }),
      notices,
    };
  }

  notices.push(
    "anthropic-client.ts n'est PAS exerce par ce mode. Pour l'exercer sans " +
      "facturation : --provider=ollama-anthropic.",
  );

  return {
    client: new OpenAiCompatibleLlmClient({
      providerName: input.provider,
      baseUrl: spec.baseUrl,
      model: overrideModel ?? spec.defaultModel,
      enforcesSchema: spec.enforcesSchema ?? false,
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      audit: input.audit,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    notices,
  };
}

/** Liste lisible des fournisseurs, pour l'aide en ligne de commande. */
export function describeProviders(env: NodeJS.ProcessEnv = process.env): string {
  const lines = Object.entries(FREE_PROVIDERS).map(([name, spec]) => {
    const ready =
      spec.envKey === null
        ? "serveur local"
        : readEnv(env, spec.envKey) !== undefined
          ? "clef presente"
          : `${spec.envKey} absente — ${spec.signup}`;
    return `  ${name.padEnd(11)} ${spec.defaultModel.padEnd(38)} ${ready}`;
  });
  return [
    "Fournisseurs gratuits (--provider=<nom>) :",
    ...lines,
    "",
    "  anthropic   payant, seul mode exercant anthropic-client.ts",
    "  mock        defaut, hors ligne, aucun appel",
  ].join("\n");
}
