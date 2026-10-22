## ✨ Highlights

- **Importez des packages `.science` directement depuis votre navigateur.** Une page de téléchargement peut désormais transmettre un package de recherche à l'application de bureau en un clic — l'application le reçoit et le valide automatiquement, puis vous choisissez où l'enregistrer et confirmez l'import. Le démarrage à froid comme une application déjà en cours d'exécution sont pris en charge, et les échecs de transfert décrivent ce qui s'est passé avec des erreurs structurées et exploitables. (#3493)
- **Des mises à jour que vous pouvez suivre — et auxquelles vous pouvez faire confiance, en particulier sur Windows.** Le téléchargement, la disponibilité et la préparation de l'installation restent désormais dans une seule boîte de dialogue avec des notes de version à défilement indépendant, au lieu de voir les boîtes de dialogue se remplacer sous vos yeux. Le chemin de mise à jour sous Windows ne duplique plus le programme d'installation avec un processus de progression séparé, conserve la propriété des successeurs lancés depuis l'Explorateur et cesse de recopier des milliers de fichiers à chaque mise à jour ; quitter l'application attend aussi la fin du nettoyage du notebook, et le démarrage à froid ne signale plus d'échec réseau avant que l'application soit prête. (#3653, #3633)
- **Correctifs de sécurité pour la gestion des identifiants MCP OAuth.** Les identifiants OAuth stockés sont désormais liés au serveur d'autorisation qui les a émis avant toute utilisation, et des correctifs de sécurité tiers actualisés sont inclus. (#3668)
- **Les sessions qui vous attendent s'affichent toujours comme en attente.** Une session suspendue en attente de votre approbation ou de votre réponse ne rebascule plus vers Running — ni dans Home, ni dans la barre latérale, ni dans les actions de l'espace de travail ni dans l'en-tête de la conversation, et cela survit aux rechargements de l'application ainsi qu'aux mises à jour du runtime en direct. (#3574)

## 🚀 New Features

- Le connecteur PDC récupère les métadonnées cliniques publiques au niveau des cas — données démographiques, diagnostics, informations sur la tumeur et références d'échantillons — pour la dernière version d'une étude ou pour une version spécifique. (#3614)
- La sélection de skills peut désormais tenir compte des images jointes à votre message actuel, et pas seulement du texte. (#3595)
- MiniMax M3.1 Flash, le modèle publié avec un contexte d'1M de tokens et une entrée multimodale, est disponible dans les deux régions MiniMax. (#3670)
- Double-cliquez sur une session dans la barre latérale de l'espace de travail pour ouvrir l'éditeur de session, sans passer par le menu d'actions. (#3650)

## 🔧 Improvements

- Dans l'espace de travail web autonome, Compute est activé lorsque les API de notebook et de calcul dont il a besoin sont disponibles, au lieu de rester désactivé. (#3638)
- Settings s'ouvre à nouveau sur la section General, et les sélecteurs de provider se désactivent pendant qu'une sauvegarde est en cours. (#3647, #3646)
- La validation des identifiants au démarrage sous Windows affiche des diagnostics au lieu d'échouer silencieusement. (#3631)
- Les surfaces des popovers s'alignent sur les couleurs du thème actif. (#3667)

## 🐛 Bug Fixes

- Quitter l'application alors qu'une question native au provider était en attente ne l'annule plus définitivement — après un redémarrage, elle peut toujours être traitée. (#3672)
- Arrêter une conversation pendant qu'un nouveau message était en cours d'enregistrement ne laisse plus ce message arrêté parvenir au provider. (#3660)
- Les identifiants d'activité de démarrage MCP répétés ne bloquent plus l'enregistrement des changements de conversation. (#3628)
- La récupération au démarrage conserve son autorité de nouvelle tentative, les vues de la bibliothèque récupérées s'actualisent, et les boîtes de dialogue de récupération ne s'empilent plus les unes sur les autres. (#3579)
- Les modifications de la mémoire effectuées pendant une sauvegarde en attente sont conservées au lieu d'être perdues, et les exécutions de notebook terminées ne sont plus indûment signalées comme interrompues après un redémarrage. (#3571)
- Les commandes de terminal manuelles restent visibles dans la vue Main Agent même lorsqu'un sous-agent est sélectionné. (#3611)
- La lecture des PDF continue de s'améliorer : le texte sur deux colonnes reste dans le bon ordre, l'attribution des figures et des tableaux reste au bon élément, les mises en page du lecteur traduites s'affichent correctement, et la recherche dans les PDF vous indique désormais quand sa couverture est incomplète. (#3605, #3622, #3644, #3654, #3603)
- Literature : les cartes d'outils enregistrées s'actualisent avec l'état actuel de la bibliothèque, le mode plein écran des tableaux utilise la bonne source, et l'état d'enregistrement se met à jour de manière fiable. (#3645, #3629)
- Import de packages de session : les packages peuvent être déposés sur l'accueil du projet, les vérifications d'import et la progression sont plus claires, et les boîtes de dialogue imbriquées défilent correctement. (#3649, #3648, #3673)
- Modifier le corps d'une skill n'écrase plus les noms ou descriptions modifiés séparément, et les recherches d'anticorps respectent leurs limites de résultats configurées. (#3570)
- La révision automatisée attend que les serveurs MCP soient prêts et vérifie l'authentification routée avant de continuer. (#3597, #3627)
- La persistance de l'enregistrement en tant que skill est limitée à la session qui l'a créé. (#3594)
- L'édition de session mobile conserve son comportement de double-clic. (#3651)
- Recréer le runtime de l'agent en pleine session ne laisse plus les nouvelles activités de skills entrer en collision avec les anciennes — une telle collision bloquait auparavant la clôture du tour et les messages suivants. (#3682)
- Les sessions comportant de nombreuses révisions chargent à nouveau leur historique de révisions — l'historique complet dépassait auparavant le budget de transport et bloquait le panneau de révision ; les journaux de révision individuels s'ouvrent désormais à la demande. (#3677)
