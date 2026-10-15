## ✨ Points forts

- **Récupération autonome des défaillances du runtime.** Le démarrage répare les échecs du backend, des paramètres et du réseau sans réinstallation ; les défaillances du runtime sont isolées pour que l'application reste réactive ; et une déconnexion du runtime ne bloque plus l'application — l'option Quitter reste disponible et une reconnexion manuelle est proposée. (#3525, #3414, #3528)
- **Les instantanés volumineux de sessions et de notebooks sont transférés de manière fiable**, de sorte que la restauration ou la migration d'espaces de travail lourds ne bloque ni n'échoue en cours de route. (#3533)

## 🚀 Nouvelles fonctionnalités

- La ligne de commande Linux est désormais également fournie sous forme de paquets autonomes **.deb et .rpm**, en complément des archives existantes. (#3491)
- Les liens et la recherche du centre d'aide dans les Paramètres sont **localisés** en même temps que le reste de l'interface. (#3489)

## 🔧 Améliorations

- L'interface web reste réactive sous une forte activité des agents — les rafales d'événements sont bornées par une file d'envoi partagée, et les lots d'événements du runtime sont plafonnés par taille encodée. (#3530, #3524)
- Les journaux redirigés du backend sont compactés, ce qui maintient les dossiers de diagnostic de petite taille. (#3535)

## 🐛 Corrections

- L'extraction de structure des PDF scientifiques conserve l'attribution des figures et des tableaux au bon élément dans davantage de mises en page. (#3537)
- L'analyse des dépendances et de la filiation des fichiers des notebooks est renforcée face aux preuves trompeuses. (#3511)
- Le comportement de compression et de nouvelle tentative des fournisseurs est à nouveau publié correctement depuis les Paramètres. (#3520)
- Les validations de métadonnées de la littérature avec des identités conflictuelles sont rejetées au lieu de corrompre les enregistrements. (#3518)
- L'état de la littérature est préservé à travers les opérations asynchrones. (#3504)
- Les preuves de récupération des tâches distantes survivent à l'annulation et au nettoyage sur les hôtes de calcul. (#3506)
- Les métadonnées d'espèces Bgee sont corrigées. (#3505)
- Les pièces jointes d'images vides sont clairement signalées dans les erreurs de prompt des agents. (#3513)
- Le chargement au démarrage de l'interface web est unifié, et les boîtes de dialogue de récupération attendent que le démarrage soit réellement stabilisé. (#3488)
- La préparation au premier lancement du notebook affiche le code en cours de réception. (#3487)
- Les sous-processus Windows en arrière-plan ne font plus clignoter de fenêtres console. (#3519)
