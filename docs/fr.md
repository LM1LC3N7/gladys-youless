# YouLess pour Gladys Assistant

Intégration **non officielle**, sans lien avec YouLess. Elle lit votre
lecteur d'énergie **YouLess** (LS110, LS120, LS120 avec le firmware PVOutput)
**directement sur votre réseau local**, sans cloud ni compte.

> **Jamais testé sur un vrai YouLess.** L'intégration a été écrite d'après la
> bibliothèque youless-api (utilisée par Home Assistant) et des réponses
> simulées. Vos retours sur le forum Gladys sont les bienvenus.

## Ce que vous obtenez

Un appareil « YouLess LS110 » ou « YouLess LS120 », avec seulement ce que
votre lecteur fournit :

| Valeur                                                   | Rythme       | Type dans Gladys                                 |
| -------------------------------------------------------- | ------------ | ------------------------------------------------ |
| Puissance (W)                                            | 10 s         | capteur d'énergie, puissance                     |
| Index de consommation (kWh)                              | 1 min        | capteur d'énergie, **index** : suivi énergétique |
| Index par tarif 1 / 2 (kWh, compteur P1)                 | 1 min        | capteurs simples                                 |
| Index d'injection, total et par tarif (kWh, compteur P1) | 1 min        | capteurs simples, **jamais facturés**            |
| Tarif en cours (1 ou 2)                                  | 1 min        | capteur simple                                   |
| Puissance, tension, courant par phase                    | 10 s         | capteurs (firmware LS120 1.5 et plus)            |
| Entrée S0 : puissance (W) et index (kWh)                 | 10 s / 1 min | capteurs simples                                 |
| Gaz (m³), eau (m³)                                       | 1 min        | capteurs de volume, **hors suivi énergétique**   |

Le **suivi énergétique** de Gladys calcule lui-même la consommation par
demi-heure et son coût à partir de l'index de consommation (avec un compteur
P1 : tarif 1 + tarif 2, l'injection n'y est jamais retirée ni ajoutée).
L'injection, le gaz et l'eau restent à part : Gladys facturerait le gaz au
tarif de l'électricité, et l'injection serait comptée comme une
consommation.

Avec un compteur P1, la puissance est la puissance **nette** : elle devient
négative quand vous injectez.

## Installation

1. Donnez au YouLess une **adresse IP fixe** dans votre box (un LS110 est
   reconnu par son adresse : la changer crée un nouvel appareil).
2. Dans Gladys, installez l'intégration YouLess depuis le store, ouvrez sa
   configuration et saisissez l'**adresse** du YouLess (ex. `192.168.1.50`,
   avec `:port` seulement s'il n'est pas 80).
3. **Mot de passe** : seulement si la page web du YouLess est protégée. Il
   est gardé par Gladys dans sa base (non chiffré), jamais réaffiché, et
   envoyé seulement au YouLess, en HTTP simple sur votre réseau (l'appareil
   ne connaît pas le HTTPS).
4. Cliquez sur **Tester la connexion** : le modèle, la puissance et l'index
   lus s'affichent.
5. Dans l'onglet **Découverte**, créez l'appareil YouLess. Les valeurs
   arrivent aussitôt.

## Détection du modèle

- la page `/d` répond (MAC, firmware) et `/e` donne les données Enelogic :
  **LS120**, lu par `/e`, plus `/f` (phases) à partir du firmware 1.5 ;
- `/d` répond mais pas `/e` : **LS120 firmware PVOutput**, lu par `/a?f=j` ;
- pas de `/d` : **LS110**, lu par `/a?f=j`.

Un LS120 est reconnu par son adresse MAC ; un LS110 (sans MAC) par son
adresse.

## Bon à savoir

- **Appareil injoignable** : l'état de l'intégration le dit, et elle
  réessaie après 10 s, puis 20 s, 40 s… jusqu'à 5 minutes, sans jamais se
  bloquer. Enregistrer la configuration relance tout de suite.
- **Mot de passe refusé** : un essai toutes les 5 minutes seulement.
- **Page des phases** (`/f`) en panne : la puissance et les index continuent ;
  l'état le signale.
- **Index incohérent** (chute à 0, saut énorme) : il n'est pas envoyé à
  Gladys tant qu'il n'a pas été relu 3 fois de suite, pour ne pas fausser la
  consommation et le coût (un compteur remplacé finit donc par passer).
- Le gaz et l'eau d'un relevé de plus de 26 h sont ignorés (le YouLess garde
  sa dernière valeur quand le compteur ne répond plus).
- Les valeurs inchangées ne sont renvoyées que toutes les 10 minutes ; à
  chaque reconnexion à Gladys, l'appareil et toutes ses valeurs sont publiés
  à nouveau.
- Les caractéristiques de l'appareil sont figées à sa création : si une
  valeur apparaît plus tard (premier relevé de gaz, par exemple), cliquez sur
  « Mettre à jour » dans l'onglet Découverte.

## Limites

- Un seul YouLess par installation de l'intégration.
- Le mot de passe passe en clair sur le réseau local (contrainte de
  l'appareil) ; la connexion par la page `/L?w=<mot de passe>` est supposée,
  elle n'a pas été vérifiée sur un appareil protégé.
- Les pics mensuels (`pp`, `pa`) du LS120 ne sont pas lus pour l'instant.

## Crédits

Logique de lecture portée de
[youless-api](https://github.com/gjong/youless-python-bridge) (MIT, Gerben
Jongerius), liste des valeurs inspirée de l'intégration YouLess de Home
Assistant (Apache-2.0). Code de l'intégration sous licence Apache-2.0.
