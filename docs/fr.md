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
| Tarif en cours (tel que donné par le YouLess)            | 1 min        | capteur simple                                   |
| Puissance, tension, courant par phase                    | 10 s         | capteurs sans historique par défaut (LS120 1.5+) |
| Entrée S0 : puissance (W) et index (kWh)                 | 10 s / 1 min | capteurs simples                                 |
| Gaz (m³), eau (m³)                                       | 1 min        | capteurs de volume, **hors suivi énergétique**   |

Le **suivi énergétique** de Gladys calcule lui-même la consommation par
demi-heure et son coût à partir de l'index de consommation (avec un compteur
P1 : tarif 1 + tarif 2, l'injection n'y est jamais retirée ni ajoutée).
L'injection, le gaz et l'eau restent à part : Gladys facturerait le gaz au
tarif de l'électricité, et l'injection serait comptée comme une
consommation.

Avec un compteur P1, la puissance est supposée être la puissance **nette** :
elle deviendrait négative quand vous injectez (non vérifié). Le tarif en cours
est publié tel que le YouLess le donne (0/1 ou 1/2 selon les sources).

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
- `/d` répond mais `/e` répond 404 ou sans données Enelogic : **LS120
  firmware PVOutput**, lu par `/a?f=j` ;
- `/d` répond 404 : **LS110**, lu par `/a?f=j`.

Toute autre réponse (une autre erreur HTTP, pas de réponse) est une panne
passagère, réessayée : jamais une supposition de modèle. Un LS120 est reconnu
par son adresse MAC ; un LS110 (sans MAC) par son adresse. Un appareil créé
comme LS120 n'est jamais « rétrogradé » en LS110 ou en firmware PVOutput par
une détection : l'état le signale et l'intégration réessaie (si vous avez
remplacé le YouLess, supprimez l'ancien appareil).

## Bon à savoir

- **Appareil injoignable** : l'état de l'intégration le dit, et elle
  réessaie après 10 s, puis 20 s, 40 s… jusqu'à 5 minutes, sans jamais se
  bloquer. Enregistrer la configuration relance tout de suite.
- **Mot de passe refusé** : un essai toutes les 5 minutes seulement.
- **Page des phases** (`/f`) en panne : la puissance et les index continuent ;
  l'état le signale.
- **Index de consommation protégé** (Gladys compte chaque remontée en
  entier) :
  - un index à 0 n'est jamais envoyé ; avec un compteur P1, une lecture sans
    données P1 (coupure du câble P1) ne donne aucun index, jamais `net` ;
  - avec un compteur P1 (LS120), les deux tarifs sont vérifiés d'abord : un
    tarif qui tombe à 0, ou qui baisse alors que l'autre ne baisse pas, est
    un raté d'un registre : pas d'index pour cette lecture (l'état le
    signale), jusqu'à ce que les tarifs redeviennent cohérents ;
  - une **baisse** (compteur remplacé, compteur remis à zéro dans le
    YouLess) et un **saut vers le haut** (plus de 100 kW en moyenne depuis la
    dernière valeur) ne sont **jamais** acceptés tout seuls, ni par le temps
    qui passe, ni par répétition, ni par un redémarrage, ni par
    l'enregistrement de la configuration : ils sont retenus (la retenue est
    gardée dans `/data`), la dernière valeur acceptée est renvoyée à Gladys,
    et l'état de l'intégration affiche la valeur retenue, y compris quand le
    YouLess ne peut pas être lu. Une valeur qui redevient normale (la baisse
    ou le saut était un raté) met fin à la retenue, sans rien facturer ;
  - si la valeur retenue est juste, cliquez sur **Accepter l'index retenu**
    dans la configuration de l'intégration. Le bouton prend **exactement la
    valeur affichée** (plus ce que le foyer peut consommer d'ici la lecture
    suivante) : un **saut** est alors **compté une fois** comme consommation
    (le bouton indique combien de kWh), une **baisse** ne facture rien et la
    consommation repart de là. Toute autre valeur lue ensuite est de nouveau
    retenue. N'acceptez un saut que si cette énergie a vraiment été
    consommée ;
  - la marge grandit avec le temps écoulé depuis la dernière valeur acceptée
    (100 kW en moyenne) : après une **longue panne** (YouLess éteint, réseau
    coupé), une forte hausse peut passer d'un coup, jusqu'à 2 400 kWh après
    24 heures ;
  - **sortie en cas d'impasse** : si l'index reste retenu ou absent pour de
    bon (un nouveau compteur dont un registre reste à 0, par exemple),
    supprimez l'appareil YouLess dans Gladys et recréez-le depuis l'onglet
    Découverte : sa référence repart de l'index actuel (l'historique de
    l'ancien appareil est perdu).
- **Mot de passe refusé par la page des phases** : elle est laissée de côté
  5 minutes, sans nouvelle connexion ; le reste continue.
- Le gaz et l'eau d'un relevé de plus de 26 h sont ignorés (le YouLess garde
  sa dernière valeur quand le compteur ne répond plus).
- Les valeurs inchangées ne sont renvoyées que toutes les 10 minutes ; à
  chaque reconnexion à Gladys, l'appareil et toutes ses valeurs sont publiés
  à nouveau.
- Les caractéristiques de l'appareil sont figées à sa création : si une
  valeur apparaît plus tard (premier relevé de gaz, par exemple), cliquez sur
  « Mettre à jour » dans l'onglet Découverte : les nouvelles valeurs arrivent
  aussitôt. L'appareil republié ne perd jamais une caractéristique de
  l'appareil créé, même si une valeur manque un moment.

## Limites

- Un seul YouLess par installation de l'intégration.
- Le mot de passe passe en clair sur le réseau local (contrainte de
  l'appareil) ; la connexion par la page `/L?w=<mot de passe>` est supposée
  (youless-api utilise l'authentification HTTP Basic, non reprise ici), elle
  n'a pas été vérifiée sur un appareil protégé.
- Les pics mensuels (`pp`, `pa`) du LS120 ne sont pas lus pour l'instant.

## Crédits

Logique de lecture portée de
[youless-api](https://github.com/gjong/youless-python-bridge) (MIT, Gerben
Jongerius), liste des valeurs inspirée de l'intégration YouLess de Home
Assistant (Apache-2.0). Code de l'intégration sous licence Apache-2.0.
