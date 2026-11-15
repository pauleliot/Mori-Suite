SORI — éditeur de courbes d'animation pour Premiere Pro (même DA que Mori et Ongaku)
=====================================================================================

Ouvrir : Premiere Pro > Fenêtre > Extensions > Sori — Courbes
(sori, 反り : la courbure d'une lame ; le mode débogage CEP « PlayerDebugMode = 1 » est déjà activé sur ce poste.)

PRINCIPE
  Premiere n'expose pas les poignées de Bézier de ses images clés en script. Sori pose donc, entre deux de vos
  images clés, des images clés linéaires qui suivent la courbe. Vos deux clés ne changent jamais ; seul le
  rythme entre elles change. Aucun effet n'est ajouté (sauf le Flou directionnel, si l'option est cochée).

ONGLET COURBE
  - Vue Valeur (amplitude, 0 → 100 %) ou Vitesse (× la vitesse moyenne ; 1× = mouvement linéaire). Touche V.
  - Glisser les poignées ; Maj = poignée à plat (vitesse nulle) ; Alt = casser la tangente d'une sous-clé.
  - Double-clic sur la courbe = sous-clé (subdivision de De Casteljau : la courbe reste identique au pixel près).
    Double-clic sur une sous-clé ou Suppr = la retirer. Chaque valeur de la barre d'info se modifie au clic
    (temps, valeur, influence et vitesse d'entrée / sortie).
  - Si un clip animé est sélectionné, la grille passe en images (durée de la paire de clés visée) :
    pratique pour caler une sous-clé sur un cut ou un SFX. Les sous-clés s'aimantent aux images (Maj = libre).
  - Ctrl+Z / Ctrl+Maj+Z : annuler / rétablir. Signet = enregistrer comme preset. Clic sur le cubic-bezier = copier.

APPLIQUER (Ctrl+Entrée)
  - Sori liste toutes les propriétés animées (au moins 2 images clés) du 1er clip sélectionné, quel que soit
    l'effet (Trajectoire, Opacité, Transformation, effets tiers), avec une case à cocher. Chaque ligne indique
    la paire de clés visée (« img 30 → 50 ») : celle qui entoure la tête de lecture, sinon la plus proche.
  - « Appliquer » pose les clés de la courbe entre ces deux clés, sur chaque propriété cochée.
  - Changer de courbe : réappliquer sur la même paire remplace les clés posées par Sori (il note celles qu'il a
    posées ; elles ne comptent pas comme des clés d'origine). Le bouton à droite d'une ligne recharge la courbe
    déjà appliquée à cette propriété.
  - Flou de mouvement (option) : Premiere ne floute pas les animations de la Trajectoire. Sori ajoute l'effet
    « Flou directionnel » au clip et l'anime, pour chaque paire de clés de Position : 0 sur la clé de départ,
    la valeur choisie à l'image la plus rapide, 0 sur la clé d'arrivée ; direction = celle du déplacement.
    Valeur : Faible 2, Moyen 5, Élevé 10, ou libre de 0,1 à 100. Elle s'applique à la paire la plus rapide ;
    les paires plus lentes reçoivent une valeur proportionnelle à leur vitesse. Deux effets existent selon la
    version de Premiere : le classique (Direction / Longueur du flou, en pixels) et celui de Premiere 2025
    (AE.Impact_Directional_Blur_FX : Angle / Quantité, de 0 à 100) ; Sori reconnaît les deux.
    Position visée : celle de la Trajectoire si elle est cochée, sinon une autre position cochée. C'est une
    imitation : correcte pour un déplacement, sans effet sur l'Échelle ou la Rotation.
  - Densité des clés (Réglages > Injection) : Légère (défaut, écart ≤ 1,2 %), Précise (≤ 0,3 %), Chaque image.
  - Annuler (bouton à côté d'Appliquer, ou Ctrl+Z quand le panneau Sori est actif) : remet les images clés comme
    avant la dernière application (10 niveaux). À préférer au Ctrl+Z de Premiere, qui peut faire planter Premiere
    après une modification par script. Un Flou directionnel ajouté par Sori est remis à 0 ; on peut le
    supprimer à la main.
  - Le clip est relu 3 fois par seconde quand la souris est sur le panneau, toutes les 1,2 s sinon ; la cadence
    ralentit si Premiere répond lentement. Premiere ne renvoie les clés que lorsqu'elles ont changé.

ONGLET BIBLIOTHÈQUE
  - Presets : Linéaire, Ease, Ease In / Out / In-Out, Smooth, Cubic, Quint, Expo, Back (overshoot),
    Elastic In / Out, Bounce In / Out. Clic = charger ; ⚡ = charger et appliquer ; copier = cubic-bezier / JSON.
  - Mes presets : enregistrés depuis l'éditeur (signet), exportables en JSON (presse-papiers + fichier).
  - Import : cubic-bezier(…) CSS, « x1, y1, x2, y2 », [x1, y1, x2, y2], JSON Sori, liste de presets,
    ou objet { name, bezier: […] } / { x1, y1, x2, y2 } (échange avec After Effects / Flow via cubic-bezier).

APPARENCE PARTAGÉE (Mori, Ongaku, Sori)
  Thème, nom affiché, couleur du nom et presets de thème sont écrits dans
    Windows : %APPDATA%\MoriSuite\appearance.json
    macOS   : ~/Library/Application Support/MoriSuite/appearance.json
  (js/suite-theme.js, copié à l'identique dans Ongaku/js et com.cutflow.studio.panel/vendor).
  Un changement dans un panneau est repris en direct par les autres. Les onglets affichés restent propres à
  chaque panneau. Premier lancement : le premier panneau mis à jour (Mori ou Ongaku) crée le fichier avec
  ses réglages ; Sori ne le crée que si on modifie l'apparence depuis Sori.

PAQUETS D'INSTALLATION (Windows / macOS)
  python build.py   → dist/Sori-<version>-Windows.zip et dist/Sori-<version>-macOS.zip
  Version : CSXS/manifest.xml ET APP_VERSION dans js/app.js (le build refuse si elles diffèrent).
  Tests : .claude/test/harness.html (faux Premiere exécutant le vrai JSX), servi par
  « python -m http.server » à la racine du dossier.

FICHIERS
  CSXS/manifest.xml       déclaration du panneau (Node.js activé)
  index.html, css/        interface
  js/curve.js             modèle de courbe : Bézier multi-segments, De Casteljau, presets, import / export
  js/app.js               éditeur canvas, bibliothèque, calcul des clés, réglages
  js/suite-theme.js       apparence partagée Mori / Ongaku / Sori
  jsx/Sori_Premiere.jsx   lecture des clés, injection, effet Transformation (ExtendScript, 100 % ASCII)

Débogage : http://localhost:8090 dans Chrome quand le panneau est ouvert.
