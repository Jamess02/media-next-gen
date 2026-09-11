# Sources de données de marché

Trois fournisseurs, branchés le 2026-09-11 : **Binance**, **CoinGecko** et **Yahoo Finance**. Ce document dit, pour chacun, ce qu'il permet d'affirmer, et surtout ce qu'il **ne permet pas** d'affirmer.

Les connecteurs vivent dans [`src/marche/`](../src/marche/). Aucun agent ne les appelle : ils passent par le pont [`adaptateur.ts`](../src/marche/adaptateur.ts), qui les branche sur la passerelle des sources. Leurs données subissent donc le même traitement que toutes les autres : journal d'audit (§9.4), tier dérivé du domaine (§4), caviardage, filtre d'injection.

## En bref

| Source | Tier | Périmètre | Usage | Clef | Formule exigée au gate |
|---|---|---|---|---|---|
| Binance | 1 | une plateforme | citable | aucune | « sur Binance » |
| CoinGecko | 2 | agrégat multi-plateformes | citable | `COINGECKO_API_KEY` (plan Demo) | « selon CoinGecko » |
| Yahoo Finance | 3 | agrégateur grand public | **signal**, jamais cité | aucune | — (ne se cite pas) |

Le tier, le périmètre et l'usage se **déduisent du domaine** ([`sources/registry.ts`](../src/sources/registry.ts), [`protocol/sources-de-marche.ts`](../src/protocol/sources-de-marche.ts)). Aucun agent ne les déclare.

## Ce que ces sources ne permettent jamais d'affirmer

- **Une recommandation** d'achat, de vente ou de conservation (EP-007). « A reculé de 2 % sur Binance » est un constat ; « un point d'entrée » est un conseil.
- **Une prévision de prix.** Ce sont des relevés passés.
- **Une comparaison entre deux instants différents** (EP-006). Tous les relevés datent de **minuit UTC** précisément pour que deux sources se comparent.

---

## Binance — tier 1, une plateforme

**Ce qui est relevé.** La bougie journalière **close** de la veille (journée UTC) : ouverture, clôture, plus haut, plus bas, et volume de la paire en BTC et en USDT. L'URL est bornée par `startTime` et `endTime` : une bougie close ne change plus, donc le lecteur retrouve le même chiffre en rejouant l'URL.

**Horodatages.** Donnée : clôture de la bougie (`23:59:59.999Z`). Requête : l'instant où nous l'avons obtenue. Si la donnée vient du cache, c'est la date de la requête d'**origine** qui est gardée.

**Ce que Binance permet d'affirmer**

> Le 10 septembre 2026 (journée UTC), le bitcoin a clôturé à 76 568,72 USDT sur Binance.

**Ce que Binance ne permet PAS d'affirmer**

- **« Le prix du bitcoin »**, sans autre précision. Binance ne voit que les échanges conclus chez lui. Pour un chiffre du marché global, c'est CoinGecko. Règle bloquante : `PLATEFORME_NON_NOMMEE`, sur la claim et sur le paragraphe du corps qui la cite.
- **Un montant en dollars.** La paire est cotée en USDT, un stablecoin qui vise la parité avec le dollar sans l'être. Règle bloquante : `USDT_PRESENTE_EN_DOLLARS`.
- **Quoi que ce soit sur les autres plateformes.**
- **Un prix « actuel ».** `ticker/24hr` est une fenêtre glissante, et son URL rend autre chose à chaque appel. Il n'est pas exploité.
- **Un état daté du carnet d'ordres.** `depth` ne renvoie **aucun horodatage**, seulement un identifiant de mise à jour, et ne se rejoue pas. Il n'est pas exploité.
- **Une journée calendaire de Paris.** La journée Binance est UTC.

**Limites techniques**

- **Hôte.** `data-api.binance.vision`, réservé aux données de marché. Jamais `api.binance.com`.
- **Endpoints.** Liste blanche : `klines`, `ticker/24hr`, `avgPrice`, `depth`, `aggTrades`, `exchangeInfo`, plus `ping` pour la sonde. Tout paramètre de signature (`signature`, `timestamp`, `recvWindow`) est refusé avant l'appel. Une clef de compte (`X-MBX-APIKEY`) ne peut même pas être configurée : ce projet ne passe jamais d'ordre. Mesuré : `/api/v3/account` rend 404 sur cet hôte.
- **Débit.** Plafond mesuré : 6 000 unités de poids par minute. Une bougie pèse 2. Le poids consommé (`x-mbx-used-weight-1m`) est lu à chaque réponse, et l'on s'arrête jusqu'à la minute suivante dès 4 800.
- **429 (limite atteinte).** Aucune reprise ; aucune requête pendant `Retry-After`. Sans cet en-tête, la pause dure une minute.
- **418 (bannissement).** Binance le prononce pour deux minutes à trois jours. L'état est **écrit sur disque** (`.cache/marche/etat-binance.json`) : un redémarrage ne le lève pas. **Ne pas supprimer ce fichier pendant un bannissement.** Binance allonge les bannissements en cas de récidive.
- **Pannes passagères.** 5xx, 408, erreur réseau, délai dépassé, code Binance `-1007` : trois essais au plus, avec un délai qui double. Réessayer une lecture n'a aucun effet de bord.
- **Délai.** Dix secondes par requête.

---

## CoinGecko — tier 2, un agrégat

**Ce qui est relevé.** Le point de **00:00:00Z** de `market_chart/range`, qui donne trois mesures au même instant :

- le prix moyen en dollars ;
- la capitalisation ;
- le volume échangé sur vingt-quatre heures glissantes, toutes plateformes suivies.

Mesuré le 2026-09-11 : ce point vaut exactement l'instantané journalier de `history`, mais son horodatage est **dans la donnée**. L'URL se rejoue **sans clef**.

**Plan Demo, mesuré et documenté.**

- 100 appels par minute et 10 000 crédits par mois ; chaque réponse HTTP 200 consomme un crédit.
- Fraîcheur annoncée : 60 secondes.
- **Aucun en-tête de limite de débit** : le débit est tenu par nous seuls, à une requête par seconde au plus.
- La clef voyage dans l'en-tête `x-cg-demo-api-key`. Jamais dans l'URL : celle-ci est citée dans l'article.

**Ce que CoinGecko permet d'affirmer**

> Selon CoinGecko, le bitcoin valait en moyenne 76 555 dollars le 11 septembre 2026 à 0 h UTC.

**Ce que CoinGecko ne permet PAS d'affirmer**

- **Un prix unique ou « officiel ».** C'est une moyenne pondérée par les volumes, selon la méthodologie de CoinGecko. Un autre agrégateur publie une autre valeur.
- **Le prix sur une plateforme donnée.**
- **Une donnée sans attribution.** Les conditions du plan Demo **exigent** l'attribution, visible et proche de la donnée. Règle bloquante : `AGREGAT_NON_ATTRIBUE`.

**Attribution sur le site — tranchée le 2026-09-12.** Tout article qui s'appuie sur CoinGecko affiche, juste après ses chiffres et avant les fiches de preuve, la mention « Données de prix fournies par CoinGecko ». La mention entière est le lien vers coingecko.com, ce qui vaut citation et lien de retour en une phrase. Elle est posée par le code depuis le registre ([`sources-de-marche.ts`](../src/protocol/sources-de-marche.ts)) : une consigne de rédaction s'oublie, et cet oubli-là romprait la licence. Le logo que le guide mentionne n'est pas affiché — le site ne porte aucune image.

**Reste à trancher : le cadre d'usage.** Selon le résumé de la page tarifaire, le plan Demo n'est pas destiné à un usage commercial. Je ne l'ai pas vérifié dans le texte des conditions : à relire avant toute monétisation.

**Limite non mesurée.** La profondeur d'historique du palier gratuit est limitée. Au-delà, une URL citée pourrait cesser de se rejouer.

---

## Yahoo Finance — signal, jamais cité

**Option (b), validée par l'éditeur le 2026-09-11.** Connecteur TypeScript natif, sans yfinance ni processus Python. Les deux options interrogent les mêmes endpoints non documentés : la fragilité est la même. yfinance ajoutait douze dépendances, dont `curl_cffi`, qui imite l'empreinte TLS d'un navigateur pour déjouer la détection de robots. Ce contournement n'a pas été autorisé. Mesuré : l'endpoint répond HTTP 200 à notre agent déclaré, sans cookie ni jeton.

**Instruments et émetteurs d'origine.** C'est l'émetteur qu'on cite, jamais Yahoo.

| Symbole | Instrument | Unité | Émetteur à citer |
|---|---|---|---|
| `^FCHI` | CAC 40 | points | Euronext |
| `^GSPC` | S&P 500 | points | S&P Dow Jones Indices |
| `^STOXX50E` | Euro Stoxx 50 | points | STOXX |
| `^N225` | Nikkei 225 | points | Nikkei Inc. |
| `BZ=F` | Brent — contrat NYMEX | dollars par baril | CME Group (NYMEX) |
| `CL=F` | WTI | dollars par baril | CME Group (NYMEX) |
| `GC=F` | Or | dollars par once | CME Group (COMEX) |

**Ce que Yahoo permet** : repérer un mouvement, et savoir où le vérifier.

**Ce que Yahoo ne permet PAS** : fonder **quoi que ce soit** dans un article. Ses données ne sont jamais citées. Le traitement est déterministe :

- le fact-checker retire le signal des citations d'une claim qui a une autre source ;
- il rejette d'office une claim qui ne reposait que sur le signal, en nommant l'émetteur à citer, avant tout appel au modèle ;
- le gate refuse qu'un signal subsiste. Règle bloquante : `SOURCE_SIGNAL_CITEE`.

**Limites de la source**

- **Séries ajustées rétroactivement.** Le cache ne dure donc que six heures.
- **Couverture inégale** hors États-Unis, **fréquence de mise à jour variable**.
- **Flottants 32 bits.** Yahoo rend `8116.759765625` pour 8 116,76. La valeur est arrondie au `priceHint` que Yahoo fournit (EP-005).
- **Horodatage.** Celui d'une barre journalière est l'**ouverture** de la séance ; la clôture intervient le même jour.
- **Séance du jour.** Une clôture `null` (mesuré sur le Nikkei) ou une barre datée de minuit pile est une séance non close : elle est sautée.
- **« Brent » de Yahoo.** `BZ=F` est le contrat NYMEX *Brent Last Day Financial*, réglé sur le Brent d'ICE. Ce n'est **pas** le prix de référence du Brent.
- **Contrats glissants.** `CL=F`, `GC=F` et `BZ=F` désignent le contrat du mois le plus proche. Yahoo en change à l'échéance, ce qui crée une rupture dans la série.
- **Conditions d'utilisation.** Yahoo réserve ces données à un usage personnel. L'usage « signal interne, jamais publié » est ce qui les respecte.

**Débit.** Une requête toutes les deux secondes au plus. Sur 429, trente minutes sans requête ; sur 403, signe de l'anti-robot, une heure. L'anti-robot n'est **jamais** contourné.

### Le contrat de schéma — et comment le modifier

Il n'y a pas de version de bibliothèque à épingler. Ce qui fait contrat, c'est la **forme de la réponse**, décrite dans [`yahoo.ts`](../src/marche/yahoo.ts) et versionnée par `CONTRAT_YAHOO` (actuellement `v8-chart/2026-09-11`). Une réponse qui s'en écarte produit un échec bruyant qui cite cette version, jamais une valeur plausible tirée d'une forme inconnue.

**Adapter le connecteur à un changement de Yahoo est une opération à risque.** Dans l'ordre :

1. **Mesurer** l'endpoint réel et conserver la réponse.
2. **Mettre à jour les fixtures** de [`tests/marche-yahoo.test.ts`](../tests/marche-yahoo.test.ts) avec cette réponse réelle, pas une forme imaginée.
3. **Adapter** `lireChart`, puis changer `CONTRAT_YAHOO` pour la date de la mesure.
4. **Faire passer** toute la suite (`npm test`) **avant** tout usage : c'est le test de non-régression.
5. **Consigner** la mesure dans le message de commit.

---

## Comportements communs

**Pertinence.** Une source de marché n'est interrogée que si le sujet l'appelle (`src/marche/instruments.ts`) : bitcoin, ether, cryptomonnaies, CAC 40, pétrole… Un article sur l'Iran ne consomme ni le poids Binance, ni les crédits CoinGecko.

**Cache.** Les réponses sont gardées dans `.cache/marche/`, qui n'est pas versionné (redistribution encadrée par les fournisseurs). Seule une réponse **validée** entre en cache. Durées par défaut :

- sept jours pour une bougie Binance close ;
- un jour pour CoinGecko ;
- six heures pour Yahoo.

La variable `MARCHE_CACHE_TTL_MINUTES` les remplace toutes.

**Garde-fous**, appliqués par le pont à chaque point de chaque connecteur ([`garde-fous.ts`](../src/marche/garde-fous.ts)). Sont refusés :

- une valeur absente ou non numérique ;
- une valeur négative ;
- un prix, un niveau ou une capitalisation nul ;
- une donnée datée du futur, ou postérieure à la requête qui l'a obtenue ;
- une donnée périmée : plus de deux jours pour les cryptoactifs, six pour les places boursières.

Pour Binance, une bougie incohérente (plus haut sous le plus bas) est aussi refusée.

**Schéma modifié.** Le connecteur échoue bruyamment, avec le mot « schéma de réponse modifié », et rien n'est mis en cache.

**Mode dégradé.** Une source indisponible ne bloque jamais le pipeline. L'article porte la mention « source indisponible lors de la collecte », avec le motif : limite de débit, bannissement, schéma modifié, donnée aberrante.

**Sonde de santé.** `npm run dev -- marches` envoie une requête légère par fournisseur, sans appel au modèle. Elle dit lequel répond, lequel a changé de schéma, lequel nous a bannis.
