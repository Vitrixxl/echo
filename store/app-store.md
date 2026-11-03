# Fiche App Store — Brancard

Tout ce qu'App Store Connect demande, prêt à coller. Langue principale : français (France).

## Informations de l'app

- **Nom** (30 car. max) : Brancard
- **Sous-titre** (30 car. max) : Alertes street medic sans réseau
- **Catégorie principale** : Utilitaires
- **Catégorie secondaire** : Navigation
- **Bundle ID** : fr.vitrixxl.brancard
- **SKU** : brancard-ios-1
- **Prix** : gratuit, toutes les régions (au minimum la France)

## URLs

- **Assistance** : https://brancard.vitrixxl.fr
- **Marketing** : https://brancard.vitrixxl.fr
- **Politique de confidentialité** : https://brancard.vitrixxl.fr/confidentialite

## Texte promotionnel (170 car. max)

Quelqu'un est blessé dans le cortège ? Brancard prévient les street medics autour de toi, même sans réseau : les téléphones se transmettent l'alerte.

## Description (4000 car. max)

Brancard alerte les street medics quand quelqu'un est blessé en manifestation.

Sans internet : les téléphones qui ont l'application se transmettent l'alerte entre eux, par Bluetooth et Wi-Fi, de proche en proche. Plus il y a de monde avec Brancard dans le cortège, plus l'alerte va loin.

SI TU AS BESOIN D'AIDE
Appuie sur « Appeler un medic », précise ce qui se passe (blessure, saignement, malaise, gaz lacrymogène…) et confirme. L'alerte part avec ta position. Tu vois combien de medics sont en route et sur place.

SI TU ES STREET MEDIC
Tu reçois chaque nouvelle alerte, la plus proche est mise en avant. « J'y vais » trace le chemin à pied, calculé sur ton téléphone, et te guide rue par rue. Les autres medics voient que tu es en route : personne ne se déplace pour rien. Le rôle medic est réservé aux personnes formées aux premiers secours.

AVANT LA MANIF
Installe l'application et télécharge la carte de ta ville : elle reste sur ton téléphone et marche sans réseau.

CONFIDENTIALITÉ
Pas de compte, pas de publicité, pas de traceur. Si tu n'es pas medic, ta position n'est partagée que quand tu lances une alerte. Le code est public.

Brancard ne remplace pas les secours : en cas d'urgence vitale, appelle le 15 ou le 112.

## Mots-clés (100 car. max, séparés par des virgules)

manifestation,street medic,secours,premiers secours,alerte,urgence,sans réseau,bluetooth,blessé,carte

## Âge (questionnaire)

- Informations médicales ou sur des traitements : « Peu fréquent/modéré ». Tout le reste : « Aucun ».
- Accès web illimité : non. Contenu généré par les utilisateurs : non (sur iPhone, seules des précisions prédéfinies sont proposées).
- Résultat attendu : 12+.

## Confidentialité de l'app (étiquette « nutritionnelle »)

- **Données collectées** : Localisation > Localisation précise.
  - Usage : fonctionnalités de l'app.
  - Liée à l'identité : non. Utilisée pour le suivi : non.
  - (La position ne va jamais sur nos serveurs. Elle est transmise de téléphone en téléphone quand on lance une alerte, ou en continu pour les medics. Déclarée par prudence.)
- Aucune autre donnée.

## Chiffrement (export)

Uniquement HTTPS standard : « Non » à « utilise un chiffrement non exempté » (déjà déclaré dans l'app : ITSAppUsesNonExemptEncryption = NO).

## Notes pour l'examen (App Review)

> Brancard lets street medics at street demonstrations receive injury alerts without internet. Phones relay alerts to each other over Bluetooth / peer-to-peer Wi-Fi (MultipeerConnectivity and Core Bluetooth); there is no account and no server-side data.
>
> Testing with ONE device:
> 1. On first launch, search a French city (e.g. "Paris") and download its map (requires internet once).
> 2. Choose "Je ne suis pas medic". Tap "APPELER UN MEDIC", pick a detail, tap "CONFIRMER L'ALERTE": the alert appears on the map and in the bottom card ("Ton alerte"), and can be cancelled.
> 3. Go back to the role screen (tap the "Civil" pill, top left) and choose "Je suis street medic", then "Je suis formé·e". The alert you created is shown as the nearest emergency. Tap "J'y vais": a walking route is computed on the device and turn-by-turn directions appear at the top. "Annuler le trajet" stops it; "Résolu" closes the alert.
> 4. Long-press anywhere on the map to raise an alert at that point (useful to test routing).
>
> With TWO devices near each other, alerts raised on one appear on the other within seconds, with no internet (airplane mode with Bluetooth on works).
>
> Background modes: bluetooth-central and bluetooth-peripheral keep relaying alerts between nearby phones while the screen is off, which is the whole point of the app during a demonstration.
> Location is used only while the app is in use, to place alerts and show medics on the map. Notes on alerts are limited to preset tags on iOS (no free text).
> Privacy policy: https://brancard.vitrixxl.fr/confidentialite — source code: https://github.com/Vitrixxl/echo

## Demande d'examen accéléré

https://developer.apple.com/contact/app-store/?topic=expedite

> Brancard is a free, non-commercial safety app that alerts volunteer first-aiders (street medics) when someone is injured during a street demonstration, working without mobile network. A large demonstration is scheduled in France on [DATE] and medics' groups are ready to use the app there; without approval before that date, injured people at that event cannot use it to call for help. We would be grateful for an expedited review.

## Captures d'écran (à faire sur le simulateur iPhone, Mac)

Obligatoire : iPhone 6,9" (1320 × 2868) ou 6,7" (1290 × 2796), 3 à 10 images. Prévues :
1. Carte avec une alerte et la carte d'alerte (civil).
2. Écran de confirmation d'alerte (précisions).
3. Trajet medic : bloc de direction + panneau du bas.
4. Écran d'accueil (choix du rôle).
5. Avertissement « Réservé aux personnes formées ».
