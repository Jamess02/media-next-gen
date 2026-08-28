# Media Next Gen — pipeline éditorial multi-agents

Implémentation du [Protocole Éditorial v1.0](protocole-editorial-v1.md) : un
pipeline géopolitique/économie où chaque affirmation publiée est typée, sourcée,
datée et contestable.

Le protocole n'est pas une note d'intention annexée au code — il **est** la
spécification. Chaque module cite la clause qu'il applique, et les clauses
critiques sont couvertes par des tests.

```bash
npm install
npm test                                                    # 85 tests

# Scénario simulé, hors ligne, avec pièges posés pour exercer le gate
npm run dev -- "resserrement monétaire et données commerciales"

# Chaîne complète sur de VRAIES données (API Banque mondiale, sans clé)
npm run dev -- --real-sources "inflation en zone euro"

# Corriger un article publié (§6)
npm run dev -- revise <article-id> --type=factuelle "ce qui change"
```

Sans aucune clé API, le pipeline tourne de bout en bout — y compris sur de
vraies sources — et produit de vrais artefacts : `output/`, `audit/`,
`changelog-editorial.md`.

---

## Principe directeur

> Une règle appliquée par un LLM est une suggestion.
> Une règle appliquée par du code testé est une contrainte.

Partout où le protocole dit « ne doit jamais », l'implémentation cherche à rendre
la violation **impossible** plutôt qu'à la détecter après coup.

| Clause | Approche | Où |
|---|---|---|
| §9.3 — gate bloquant | Le fact-checker LLM ne peut que **dégrader** : ses sorties sont bornées par du code (clamp monotone). Un modèle défaillant ou manipulé ne peut pas ouvrir le gate. | [fact-checker.ts](src/agents/fact-checker.ts) |
| §8 — pas de promotion en `fait` | Le schéma de sortie du Rédacteur **ne contient aucune claim**. Il écrit autour de claims immuables : il n'a pas de canal pour requalifier. | [redacteur.ts](src/agents/redacteur.ts) |
| §9.5 / EP-006 — pas de fusion silencieuse | `combine()` refuse d'agréger sans pondération explicite ni limites de comparabilité déclarées. | [scoring.ts](src/protocol/scoring.ts) |
| EP-005 — pas d'illusion de précision | On ne peut pas construire un chiffre sans couverture, fraîcheur, méthode et incertitude. Sinon `qualify()` rend du texte. | [scoring.ts](src/protocol/scoring.ts) |
| §4 / EP-001 — tiers de sources | Le tier est **dérivé du domaine**, jamais déclaré par un agent. Domaine inconnu ⇒ tier 3, jamais mieux. | [registry.ts](src/sources/registry.ts) |
| §9.4 — journalisation | Imposée par la passerelle, pas par la discipline des adaptateurs. Un adaptateur ne peut pas l'oublier. | [gateway.ts](src/sources/gateway.ts) |
| §9.4 — journal versionné **sans secrets** | Le journal part sur un dépôt public, or FRED, GNews et ACLED transportent leur clé **dans l'URL**. Les URLs et messages d'erreur sont caviardés au point de passage unique du journal, et le caviardage est déclaré. | [redaction.ts](src/audit/redaction.ts) |
| §9.6 — changelog versionné | Fichier markdown **append-only**. Le module n'expose ni `update` ni `delete`. | [changelog.ts](src/editorial/changelog.ts) |
| §9.1 — protocole en prompt système | Injecté par la classe de base. Aucun chemin de code n'appelle le modèle sans lui. | [base.ts](src/agents/base.ts) |
| §6 — correction sans réécriture | `published_at` est réimposé depuis la version publiée : même une fonction d'édition boguée ne peut pas antidater un article ni effacer une correction. | [revision.ts](src/editorial/revision.ts) |
| §9.3 — reprise en reformulation | Si aucune claim ne passe, une **seconde passe** tente la reformulation en hypothèse explicite. Bornée à une reprise : une boucle non bornée affaiblirait le texte jusqu'à ce qu'il passe. | [pipeline.ts](src/pipeline.ts) |

---

## Architecture

```
protocole-editorial-v1.md      ← spécification, chargée à l'exécution
changelog-editorial.md         ← §6/§9.6, append-only, versionné

src/
  protocol/     Noyau normatif. Aucune dépendance sortante, aucun I/O.
    constants     §2 §3 §4 — seuils et typologies
    schema        §7 — contrat JSON entre agents (zod)
    rules         §2 §3 §4 §6 §8 — gate déterministe (fonctions pures)
    scoring       EP-005 EP-006 §9.5 — chiffres et composites
    system-prompt §9.1 — chargement du protocole

  agents/       §5 — un module par rôle
    veilleur → analyste → fact-checker → redacteur → redacteur-en-chef → editeur

  sources/      Accès externe : registre de tiers, passerelle, catalogue
                http.ts = fetch mutualisé (timeout, statut, parsing)
                worldbank / imf / eurostat / usgs / fred = adaptateurs RÉELS
  llm/          Frontière modèle : interface + client Anthropic + mock
  audit/        §9.4 — journal JSONL + archives adressées par contenu
  editorial/    §6 — changelog public + flux de correction
  fixtures/     Réponses simulées : scriptées (Zembla) et adaptatives
  pipeline.ts   §5 — orchestration (contient zéro règle éditoriale)
```

**Sens des dépendances** : `protocol/` ne dépend de rien. Tout le reste en
dépend. C'est ce qui permet de tester les règles éditoriales sans clé API, sans
réseau et sans LLM.

---

## Dépendances

**Runtime**

| Paquet | Rôle |
|---|---|
| `zod` | Valide le contrat §7 à l'exécution. Les types TypeScript disparaissent à la compilation ; un agent émettant un JSON malformé passerait sinon inaperçu. Sert aussi à contraindre les sorties du modèle. |
| `@anthropic-ai/sdk` | Appels à l'API Claude, via `messages.parse()` + `zodOutputFormat`. Isolé derrière l'interface `LlmClient` : le mode simulation n'en dépend pas. |

**Développement** : `typescript`, `@types/node`, `tsx` (exécution directe),
`vitest` (tests).

**Volontairement absent** : aucun framework d'agents. Le protocole décrit déjà
l'orchestration exacte (§5) ; une couche d'abstraction supplémentaire masquerait
le gate au lieu de l'appliquer.

---

## Modes d'exécution

| | défaut | `--real-sources` | `--mode=live` |
|---|---|---|---|
| LLM | Réponses scriptées (Zembla) | Réponses **adaptatives** dérivées des données reçues | API Claude (`claude-opus-5`) |
| Sources | Adaptateurs simulés | **5 sources réelles** (voir ci-dessous) | idem |
| Coût | nul | nul | facturé |
| Usage | exercer le gate (pièges posés) | démo bout-en-bout sur données réelles | production |

### Sources branchées

| Source | Tier | Clé | Piège traité |
|---|---|---|---|
| [Banque mondiale](src/sources/worldbank.ts) | 1 | non | Années nulles comptées, flottants bruts arrondis (EP-005) |
| [FMI (WEO)](src/sources/imf.ts) | 1 | non | **Projections mélangées aux observations** : la série va jusqu'en 2031 sans que l'API distingue. Seule la dernière année antérieure à l'année en cours est retenue (§3) |
| [Eurostat](src/sources/eurostat.ts) | 1 | non | Index JSON-stat à plat : l'adaptateur **refuse de deviner** si une dimension n'est pas figée |
| [USGS](src/sources/usgs.ts) | 1 | non | Solution `automatic` signalée comme préliminaire et révisable (§5.2) |
| [FRED](src/sources/fred.ts) | 1 | `FRED_API_KEY` | Valeurs `"."` jamais converties en 0 ; clé dans l'URL, caviardée au journal |

Sans clé FRED, la source est **déclarée absente** plutôt que silencieusement omise (EP-003). Trois autres sources du §4 sont documentées comme non branchées, avec leur motif — dont GDELT, dont le certificat TLS a expiré : contourner la vérification TLS exposerait le pipeline à une interception.

Le mode `live` exige `--mode=live` **et** `ANTHROPIC_API_KEY`. Un pipeline qui
appellerait une API payante et publierait de vraies affirmations parce qu'une
variable d'environnement traînait ne serait pas acceptable.

**Deux jeux de réponses simulées, et c'est délibéré.** Le scénario scripté porte
sur une économie **fictive** (Zembla), tout est préfixé `[SIMULATION]`, et il
pose des pièges précis — un fact-checker qui tente une promotion illégale, un
niveau de preuve surcoté — pour vérifier que le gate les refuse. Les responders
adaptatifs, eux, lisent leur entrée et construisent leurs sorties depuis les
données réellement collectées. Appliquer le scénario Zembla à de vraies sources
produirait des claims fictives citant des données authentiques : exactement ce
que le protocole interdit.

---

## Ce qui reste à faire

1. **Sources restantes** — trois du §4 attendent une action externe :
   ReliefWeb (demander un `appname` approuvé), OpenSanctions (clé), GDELT
   (certificat TLS à corriger côté source). Comtrade et l'OCDE demandent un
   travail de format supplémentaire (SDMX). Le contrat `SourceAdapter` est
   stable : chaque ajout est un fichier plus une entrée au
   [catalogue](src/sources/catalogue.ts).
2. **Reprise en collecte** — le §9.3 offre deux issues à une claim rejetée :
   la reformulation (implémentée) ou le **retour en collecte** avec une fenêtre
   élargie (pas encore).
3. **Versionnement Git** — voir ci-dessous.
4. **Relecture humaine** — le pipeline produit un texte publiable au sens du
   protocole. Il ne remplace pas un rédacteur en chef humain, et le protocole ne
   prétend pas le contraire.

### Mise sous Git

Git n'est pas installé sur cette machine, donc le dépôt n'a pas pu être créé.
`.gitignore` et `.gitattributes` sont prêts. Après installation de Git :

```bash
git init
git add .
git commit -m "Pipeline editorial multi-agents conforme au Protocole Editorial v1.0"
```

`changelog-editorial.md` **doit** être versionné (§9.6). `audit/journal.jsonl`
l'est aussi : c'est la trace de preuve. Sont exclus `audit/raw/` (volumineux,
soumis aux CGU des fournisseurs) et `output/` (artefacts de simulation
régénérés à chaque exécution).

---

## Limite assumée

Le filtre EP-007 de [rules.ts](src/protocol/rules.ts) est **lexical**. Il attrape
« les investisseurs devraient », pas « les fondamentaux restent solides ». C'est
un garde-fou de dernière ligne, jamais une preuve de conformité : le jugement
sémantique appartient au Rédacteur en chef (§5.4), et en dernier ressort à un
humain. Le code le dit explicitement là où il est écrit, pour que personne ne
prenne un test vert pour une garantie de neutralité.
