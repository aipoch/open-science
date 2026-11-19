## ✨ Highlights

- **Tâches de recherche planifiées.** Configurez des planifications récurrentes ou ponctuelles qui lancent des sessions et des tâches Notebook toutes seules : chaque exécution s'ouvre dans l'espace de travail avec son propre enregistrement, et vous gardez le contrôle grâce à un historique d'exécutions clair. (#4380)
- **Génération et édition d'images.** Générez des images à partir d'une invite avec votre fournisseur configuré, puis itérez : chaque modification conserve une nouvelle version, vous pouvez donc comparer, revisiter et réutiliser les variantes précédentes dans tout le projet. (#4424)
- **Présentations modifiables.** Les fichiers PowerPoint s'ouvrent en édition : révisez le texte avec sa mise en forme — polices, tailles, couleurs, alignement — tout en gardant la structure du fichier intacte, le tout dans l'application. (#4392)
- **Films de recherche, rejoués.** Les opérations de film peuvent être rejouées sur de nouvelles branches avec des sorties indépendantes, les films s'ouvrent directement depuis le menu de session, et la boîte de dialogue du film explique la consommation de jetons avant la génération. (#4389, #4414)
- **Questions d'agent plus judicieuses.** Lorsque l'agent a besoin de votre avis, il expose désormais les compromis entre les options proposées, pour que vous décidiez en connaissance des conséquences. (#4357)

## ⚠️ Portée et sécurité

- **Les tâches planifiées s'exécutent avec les permissions de votre projet.** Une planification lance sa session ou son exécution Notebook sans confirmation supplémentaire tant que l'application est en cours d'exécution. L'exécution agit avec les dossiers, les identifiants et l'accès réseau déjà accordés à ce projet, et elle consomme le quota de votre fournisseur configuré. Vérifiez la cible et la cadence de la planification ainsi que les droits accordés au projet avant de l'activer, et mettez en pause ou supprimez les planifications dont vous ne voulez plus. Voir la [limite des tâches planifiées dans le registre des limites connues](https://github.com/aipoch/open-science/blob/v1.3.0/docs/known-limitations.md). (#4380)
- **La génération et l'édition d'images divulguent les invites et les images sources à votre fournisseur configuré.** Les requêtes de génération et les images utilisées comme source sont transmises via la connexion au fournisseur que vous avez configurée, et annuler ou supprimer localement ne peut pas rétracter les octets que le fournisseur a déjà reçus. Vérifiez les conditions relatives aux données du fournisseur avant de générer à partir de contenus sensibles. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.0/docs/security.md#data-recipients). (#4424)

## 🚀 New Features

- Créez des tâches planifiées qui lancent une session ou exécutent un Notebook selon une cadence récurrente ou ponctuelle : chaque exécution planifiée s'ouvre dans l'espace de travail comme son propre enregistrement, avec un historique d'exécutions conservé par planification. (#4380)
- Générez des images à partir d'invites via votre fournisseur configuré et modifiez-les avec des instructions de suivi : chaque génération et chaque modification stocke une nouvelle version d'artefact, et les variantes précédentes restent disponibles pour comparaison et réutilisation. (#4424)
- Modifiez les présentations PowerPoint en place : sélectionnez et révisez le texte avec polices, tailles, couleurs et alignement, tout en préservant la structure des diapositives. (#4392)
- Rejouez les opérations d'un film de recherche sur une branche différente et obtenez une sortie indépendante sans toucher au film d'origine. (#4389)
- Ouvrez les films de recherche générés directement depuis le menu de session, et voyez d'emblée combien de jetons la génération d'un film consommera. (#4414)
- Surveillez les processus Notebook en cours d'exécution depuis l'application et arrêtez ceux que l'application détient lorsqu'ils ne sont plus nécessaires. (#4399)
- Les skills de documents et de figures sont prêts à l'emploi : leurs bibliothèques de prise en charge sont préinstallées dans l'environnement géré dès la première utilisation au lieu d'échouer en pleine tâche. (#4411)

## 🔧 Improvements

- Les longs historiques de conversation persistent de manière incrémentale, de sorte que les grandes sessions s'enregistrent en continu, se rechargent plus vite et restent réactives pendant leur croissance. (#4378)
- L'application atteint l'accueil du projet plus tôt au démarrage en élaguant le travail qui bloquait le premier écran. (#4398)
- La génération de film bloquée, les transferts de paquets de recherche et les livraisons en arrière-plan récupèrent d'elles-mêmes au lieu d'attendre un redémarrage. (#4372)
- Les installations et mises à jour Windows utilisent une chaîne d'empaquetage plus légère et plus fiable, et les vérifications de disponibilité des mises à jour sont bornées pour ne plus bloquer le déroulement. (#4420, #4417)
- La planification de récupération des cibles de calcul s'exécute à la demande au lieu d'un minuteur fixe, réduisant la surcharge au repos. (#4375)
- Les références de skills s'alignent sur les noms de skills publics OpenCode 2.x, de sorte que les skills importés se résolvent comme prévu. (#4355)
- Les PDF externes récupèrent leur structure native de façon plus fiable pendant l'analyse et la traduction, le lecteur consolide sa barre d'outils, et les limites de prise en charge des images s'expliquent d'elles-mêmes au lieu d'échouer en silence. (#4361, #4360, #4435, #4407, #4394, #4400)
- Le compositeur garde les contrôles d'envoi accessibles dans les mises en page étroites, affiche l'utilisation du contexte avec précision, et révèle la flèche de défilement vers le plus récent au survol de la conversation. (#4367, #4403)
- La première peinture des longues conversations est plafonnée pour que la fenêtre s'ouvre rapidement même avec de nombreux messages chargés. (#4376)

## 🐛 Bug Fixes

- Les sessions conservent leur numérotation correcte lorsque les enregistrements sont réparés, et la relecture du journal ne répète plus le travail ni ne rescanne inutilement l'historique. (#4368, #4432, #4428)
- Les environnements d'exécution de l'agent libèrent leurs ressources au fil des cycles de vie des agents, de sorte que les exécutions répétées n'accumulent pas de surcharge. (#4396)
- Les rechargements de skills n'interrompent plus la création de session en cours. (#4427)
- Les transferts d'agent préservent leurs métadonnées même lorsque les résultats d'outils sont tronqués. (#4413)
- Les téléchargements d'artefacts via le CLI local n'expirent plus pendant que les données arrivent encore. (#4430)
- Les requêtes de tâches distantes et les téléchargements honorent la durée de vie de l'appelant, de sorte que les opérations abandonnées s'arrêtent rapidement. (#4390)
- Les travaux Ray terminaux sont supprimés après la récolte au lieu de persister sur la cible. (#4386)
- Les liens de ressources ACP sont à nouveau acceptés. (#4381)
- Les paquets Science ouvrent le mode de film importé disponible au lieu d'échouer. (#4419)
- Les aperçus conservent leur identité de nom de fichier dans les surfaces étroites, les marques d'exécution se placent aux bonnes positions, et le sélecteur de projet garde son défilement à l'intérieur de la liste. (#4401, #4350, #4405)
- Les transcriptions du cadre Notebook se paginent de façon régulière, et les notes de bas de page Markdown gardent leur défilement contenu. (#4370, #4391)

## 🙏 Remerciements

- Merci à [@cyj1116](https://github.com/cyj1116) pour les présentations modifiables ([#4392](https://github.com/aipoch/open-science/pull/4392)), les raffinements du lecteur PDF ([#4394](https://github.com/aipoch/open-science/pull/4394)), la préservation des métadonnées de transfert ([#4413](https://github.com/aipoch/open-science/pull/4413)) et les corrections des délais d'expiration des téléchargements du CLI ([#4430](https://github.com/aipoch/open-science/pull/4430)).
- Merci à [@wen2zhou](https://github.com/wen2zhou) pour les compromis d'options dans les questions d'agent ([#4357](https://github.com/aipoch/open-science/pull/4357)), la surveillance des processus Notebook ([#4399](https://github.com/aipoch/open-science/pull/4399)) et l'identité de nom de fichier des aperçus ([#4401](https://github.com/aipoch/open-science/pull/4401)).
- Merci à [@fengdwx](https://github.com/fengdwx) pour la persistance incrémentale de l'historique des sessions ([#4378](https://github.com/aipoch/open-science/pull/4378)).
- Merci à [@roxi3906](https://github.com/roxi3906) pour la stabilité de la navigation des marques d'exécution ([#4350](https://github.com/aipoch/open-science/pull/4350)), à [@BobbyLin7](https://github.com/BobbyLin7) pour l'alignement sur les noms de skills OpenCode ([#4355](https://github.com/aipoch/open-science/pull/4355)) et à [@daanveer-tech](https://github.com/daanveer-tech) pour les mises à jour du README ([#4433](https://github.com/aipoch/open-science/pull/4433)).
