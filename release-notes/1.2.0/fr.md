## ✨ Highlights

- **Exécutez des jobs sur des backends cloud.** Kubernetes, Hugging Face Jobs, Modal et Ray rejoignent SSH et Slurm : approuvez la cible, la commande, les ressources et les sorties avant la soumission, récupérez le job après un redémarrage et ouvrez les résultats publiés depuis Compute Preview. (#4191)
- **Agent Open-Science intégré.** Un runtime d'agent intégré autonome, avec exécution de tours neutre vis-à-vis du fournisseur et gestion validée des outils, devient le choix par défaut des nouvelles installations (auparavant Claude) ; Claude Code, OpenCode, Codex, CodeBuddy et Pi restent disponibles. (#4147, #4159)
- **Mises à jour macOS plus rapides.** Les mises à jour ne téléchargent que les blocs modifiés de l'image de l'application, en repliant sur le téléchargement complet si nécessaire. (#4177)
- **Discutez d'une recherche importée à une étape.** La question posée depuis un paquet `.science` importé ou une étape de relecture ouvre une conversation enfant liée à cette étape ; le parent conserve son identité et les discussions survivent à l'archivage. (#4178)
- **Un espace de travail plus serein.** La barre latérale place d'abord la recherche épinglée et importée et replie les sessions plus anciennes dans une seule liste de récents, l'historique importé fait de « forker pour continuer » l'étape évidente, et l'envoi depuis un tour antérieur ne déplace plus la position de lecture. (#4180, #4183, #4188)
- **Des mises à jour et des documents plus fiables.** macOS vérifie l'application en cours d'exécution avant de bloquer une installation, les mises à jour Windows nomment les fichiers qui retiennent l'application ouverte, et la traduction de PDF à mise en page fixe conserve les pages saines lorsqu'une page échoue. (#4161, #4158, #4186)

## 🚀 New Features

- Soumettez des jobs approuvés à Kubernetes, Hugging Face Jobs, Modal ou Ray, avec approbation par job de la cible, de la commande, des ressources et des sorties, ainsi que des enregistrements de récupération qui reprennent la collecte après un redémarrage. Les jobs distants s'exécutent sous l'autorité de votre propre compte connecté : chaque backend nécessite ses propres identifiants, et les entrées approuvées, la commande et les sorties quittent cette machine pour le fournisseur sélectionné. (#4191)
- Utilisez le runtime d'agent Open-Science intégré, avec des adaptateurs de streaming pour les principaux protocoles d'API et des magasins durables ; c'est l'agent par défaut des nouvelles installations. (#4147, #4159)
- Téléchargez les mises à jour macOS différentiellement via des blockmaps, avec repli automatique sur le téléchargement complet. (#4177)
- Démarrez une discussion enfant liée à une étape depuis une recherche importée ou une relecture ; la suppression du parent convertit les discussions en conversations ordinaires. (#4178)
- Prévisualisez les liens sources dans une carte au survol qui affiche le domaine de destination et, pour les sources HTTPS approuvées, les métadonnées de titre et de description. (#4194)

## 🔧 Improvements

- La barre latérale de l'espace de travail ordonne les groupes en Épinglé, Recherche importée, Actif et Récents, et les sessions enfant se lisent clairement comme des branches de leur parent. (#4180)
- L'historique de recherche importé conserve les quatre actions mais promeut Fork to continue comme action principale unique. (#4183)
- L'envoi d'une invite pendant la lecture d'un tour antérieur maintient la transcription ancrée au lieu de sauter à la fin. (#4188)
- L'onglet Modèle devient Capacités locales, couvrant l'extraction PDF, les packs de langues OCR et la narration de recherche avec des cartes alignées. (#4175)
- La question en relecture se rattache à l'étape sélectionnée ou au run du Notebook, y compris les cellules hors de la page courante. (#4187, #4185)
- Les messages d'erreur des outils indiquent désormais l'appel échoué et l'étape suivante explicite au lieu de donner l'impression que l'outil est indisponible. (#4184)
- L'analyse de grandes sources du Notebook s'exécute hors du thread principal, les preuves de fichiers réutilisent un worker résident et les sorties des processus possédés sont attendues nativement, gardant les runs et les arrêts réactifs. (#4166, #4174, #4169)
- L'extraction PDF de la littérature externe ne récupère que des fragments de prose native, de maths et de tableaux prouvés et rejette les légendes similaires et les queues de citations. (#4156, #4176)
- Le formulaire manuel Ajouter une référence accepte les saisies à identifiant seul comme un PMID, en générant un titre à partir du premier identifiant. (#4150)
- Les contrôles d'export vidéo de recherche restent compacts pendant la progression, et le bouton film ne fait plus clignoter la mauvaise action pendant le chargement de son statut. (#4182, #4179)

## 🐛 Bug Fixes

- Les alias de modèles DeepSeek passent par chat completions, corrigeant les échecs de validation et d'exécution sur le chemin Responses. (#4192)
- Les environnements R gérés de Windows lancent Rscript avec les répertoires DLL Conda activés, corrigeant les sorties STATUS_DLL_NOT_FOUND. (#4195)
- Sur Windows avec mise à l'échelle d'affichage, la fenêtre principale se limite à la zone de travail de l'écran afin que la barre des tâches ne puisse plus couvrir la zone de saisie. (#4200)
- La traduction de PDF à mise en page fixe conserve les pages traduites indépendamment lorsqu'une page a une mise en page non prise en charge au lieu de rejeter tout l'aperçu. (#4186)
- Les vérifications d'installation des mises à jour valident le bundle macOS en cours d'exécution avant de signaler une installation occupée, nomment les processus Windows qui retiennent les fichiers de l'application et résolvent les blocages sans bloquer l'application. (#4161, #4158, #4153)
- Le service en arrière-plan macOS partagé se détache du gestionnaire de plantages du bureau, afin qu'un gestionnaire obsolète ne retienne plus de fichiers ni ne bloque les mises à jour. (#4165)
- Les diagnostics de démarrage survivent au redémarrage automatique après une sortie du backend. (#4144)
- La récupération du runtime du Notebook sur Windows prouve que l'arbre de processus du noyau est sorti avant de lever les barrières de démarrage, et les tâches shell préfèrent le Node géré par l'application aux shims de l'hôte. (#4140, #4142, #4143)
- Le nettoyage du runtime Codex résout taskkill de manière fiable dans les environnements Windows restreints. (#4199)

## 🙏 Remerciements

Merci à [@daanveer-tech](https://github.com/daanveer-tech) d'avoir aligné les détails de la version v1.1.0 dans les README localisés. ([#4146](https://github.com/aipoch/open-science/pull/4146))
