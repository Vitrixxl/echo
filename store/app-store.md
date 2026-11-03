# Fiche App Store — Brancard

Tout ce qu'App Store Connect demande, prêt à coller. Langue principale : français (France).

## Informations de l'app

- **Nom** (30 car. max) : Brancard
- **Sous-titre** (30 car. max) : Alertes medic sans réseau
- **Catégorie principale** : Utilitaires
- **Catégorie secondaire** : Navigation
- **Bundle ID** : fr.vitrixxl.brancard
- **SKU** : brancard
- **Prix** : gratuit, toutes les régions (au minimum la France)

## URLs

- **Assistance** : https://brancard.vitrixxl.fr (contact en bas de page : vitrice91@gmail.com)
- **Marketing** : https://brancard.vitrixxl.fr
- **Politique de confidentialité** : https://brancard.vitrixxl.fr/confidentialite

## Texte promotionnel (170 car. max)

Quelqu'un est blessé dans le cortège ? Brancard prévient les street medics autour de toi, même sans réseau : les téléphones se transmettent l'alerte.

## Description (4000 car. max)

Brancard aide les secouristes bénévoles (street medics) à se coordonner pendant les manifestations, rassemblements et événements publics : quand quelqu'un est blessé, ceux qui sont autour sont prévenus.

Sans internet : les téléphones qui ont l'application se transmettent l'alerte entre eux, par Bluetooth, de proche en proche. Plus il y a de monde avec Brancard dans le cortège, plus l'alerte va loin.

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

manifestation,rassemblement,secours,premiers secours,blessé,hors ligne,bluetooth,mesh,secouriste

## Âge (nouveau questionnaire, obligatoire depuis le 31/01/2026)

| Question | Réponse |
|---|---|
| Contrôle parental / Vérification de l'âge | Non / Non |
| Accès web illimité | Non (seul lien : la politique de confidentialité, ouverte dans Safari) |
| Contenu généré par les utilisateurs | Non (sur iPhone, seules des précisions prédéfinies) |
| Messagerie et chat | Non |
| Publicité | Non |
| Informations médicales ou sur des traitements | Peu fréquent |
| Thèmes santé / bien-être | Aucun |
| Thèmes matures ou suggestifs | Peu fréquent (« political strife » : manifestations) |
| Violence, armes, grossièretés, horreur, alcool / drogues, sexualité, jeux d'argent, concours, loot boxes | Aucun |
| **Résultat attendu** | **13+** |

## Union européenne : Digital Services Act

App Store Connect > Business > Compliance (ou Informations sur l'app > Digital Services Act) : déclarer **non-trader** (app gratuite, non commerciale, compte individuel). Sans déclaration, l'app n'est pas disponible dans l'UE. En trader, adresse, téléphone et e-mail seraient publiés sur la fiche.

## Confidentialité de l'app (étiquette « nutritionnelle »)

- **Données collectées** : Localisation > Localisation précise.
  - Usage : fonctionnalités de l'app.
  - Liée à l'identité : non. Utilisée pour le suivi : non.
  - (La position ne va jamais sur nos serveurs. Elle est transmise de téléphone en téléphone quand on lance une alerte, ou en continu pour les medics. Déclarée par prudence.)
- *(Facultatif, prudent)* **Historique de recherche** : le nom de la ville est envoyé à Nominatim. Usage : fonctionnalités. Non liée. Pas de suivi.
- Rien d'autre : la vérification de mise à jour (identifiant aléatoire, IP) n'est pas conservée, et le compteur d'installations ne garde qu'un total.
- Suivi (tracking) : **non**.

## Chiffrement (export)

HTTPS standard, hachage SHA-256 et vérification de signature des mises à jour (authentification), tous exemptés : « Non » à « utilise un chiffrement non exempté » (déjà déclaré dans l'app : ITSAppUsesNonExemptEncryption = NO).

## Notes pour l'examen (App Review)

À coller dans « Notes » (App Review) et dans « Test Information » (TestFlight). Remplacer le lien de la vidéo.

> Brancard is a free, non-commercial coordination tool for volunteer first-aiders ("street medics") at public gatherings in France. It is NOT an emergency service and says so in the app (role screen and alert confirmation): users are told to call 15 / 112 for life-threatening emergencies, with a one-tap call to 112. There is no account, no login, no ads, no analytics.
>
> How it works: phones relay alerts to each other over Bluetooth Low Energy only (Core Bluetooth, custom GATT service). No server receives alerts or positions.
>
> Testing with ONE device (no demo account or demo mode needed):
> 1. First launch: search "Paris" (city search is limited to France) and download its map (internet needed once).
> 2. Choose "Je ne suis pas medic". Because your real GPS position is outside France, LONG-PRESS anywhere on the Paris map to place an alert there, pick a preset detail (e.g. "Blessure"), tap "CONFIRMER L'ALERTE". The alert appears on the map and in the bottom card ("Ton alerte"); it can be cancelled.
> 3. Tap the role pill (top left), confirm "Changer", choose "Je suis street medic", then "Je suis formé·e" (warning about training and continuous position sharing). Your alert is shown as the nearest emergency. Tap "J'y vais": a walking route is computed on the device; "Annuler le trajet" stops it, "Résolu" closes the alert. Medics are asked for notification permission so new alerts can notify them.
> 4. Location permission is optional: without it, alerts can still be placed by long-press.
>
> With TWO devices (video: <UNLISTED VIDEO URL>): alerts raised on one phone appear on the other within seconds with no internet (airplane mode + Bluetooth on). With the medic's iPhone locked, a new alert triggers a local notification.
>
> Background modes: bluetooth-central and bluetooth-peripheral are used so a locked phone continues to receive and relay alerts from nearby phones (GATT server + client). Location is "When In Use" only; there is no background location on iOS.
>
> User content: on iOS there is no free text. Alerts carry only a position and preset tags chosen from a fixed list (Blessure, Saignement, Gaz lacrymo, Malaise, Inconscient, Brûlure), so there is no user-written content to moderate.
>
> Over-the-air updates (expo-updates, signed) are used only for bug fixes, never for new features.
>
> Privacy policy: https://brancard.vitrixxl.fr/confidentialite. Source code: https://github.com/Vitrixxl/echo. Contact: vitrice91@gmail.com

## Demande d'examen accéléré

https://developer.apple.com/contact/app-store/?topic=expedite

> Brancard is a free, non-commercial coordination tool for volunteer first-aiders (street medics) at public gatherings in France: it lets them know when someone nearby is injured, without mobile network. A large demonstration is scheduled in France on [DATE] and volunteer first-aid groups are ready to use the app there; without approval before that date, they cannot coordinate with it at that event. We would be grateful for an expedited review.

## Captures d'écran

Ton neutre : pas de sang, pas de forces de l'ordre, pas de slogans.

Obligatoire : iPhone 6,9" (1320 × 2868) ou 6,7" (1290 × 2796), 3 à 10 images. Prévues :
1. Carte avec une alerte et la carte d'alerte (civil).
2. Écran de confirmation d'alerte (précisions).
3. Trajet medic : bloc de direction + panneau du bas.
4. Écran d'accueil (choix du rôle).
5. Avertissement « Réservé aux personnes formées ».
