## ✨ Highlights

- **Réseau Strict pour le Notebook.** Un mode Strict facultatif remplace les offres d'autorisation par une liste blanche gérée manuellement : une requête n'est autorisée que si elle correspond à vos règles par protocole, nom d'hôte ou IP, et port — les requêtes sans correspondance sont purement bloquées. Le mode Relaxed reste le choix par défaut et conserve le comportement d'approbation existant. (#4253)
- **Les films de recherche reprennent depuis des points de contrôle.** La génération d'un film interrompu se poursuit avec le travail validé intact : les scènes terminées, la narration, les minutages et le mixage sont réutilisés d'un redémarrage à l'autre, la boîte de dialogue indique l'étape en cours parmi cinq, et vous choisissez de reprendre ou de régénérer à neuf. (#4290)
- **Fidélité aller-retour des PDF.** Les PDF externes récupèrent des figures natives complètes, des légendes, des enregistrements de tableaux et l'ordre de lecture, et les documents traduits conservent la structure et la mise en page d'origine au lieu de retomber sur un placement non vérifié. (#4300, #4342, #4340, #4334, #4286)
- **Octrois et mises à jour Windows plus sûrs.** Les octrois de dossiers en mode protégé sont validés avant d'être enregistrés ; les flux de mise à jour, de désinstallation et de transfert récupèrent plus fiabilité, nomment ce qui les a bloqués et préservent leurs diagnostics. (#4217, #4305, #4327, #4328, #4337, #4346)
- **Actualisation du catalogue de fournisseurs.** Qwen4 Max Preview rejoint Bailian Token Plans à Beijing et Singapore avec une fenêtre de contexte de 1M, et les modèles par défaut des connexions officielles sont actualisés. (#4311, #4301)

## 🚀 New Features

- Passez le réseau du Notebook en mode Strict : les requêtes doivent correspondre à une liste blanche gérée manuellement par protocole, nom d'hôte ou IP, et port, et les requêtes sans correspondance sont bloquées sans offre d'autorisation. Gérez les règles en groupes logiques modifiables avec étiquettes de provenance ; les destinations intégrées préexistantes sont amorcées une seule fois et les modifications persistent. Révisez les règles amorcées avant de vous fier au mode, car les requêtes bloquées échouent au lieu de demander. (#4253)
- Reprenez la génération d'un film de recherche interrompu depuis des points de contrôle validés : les assistants et scènes terminés survivent à une défaillance ultérieure, la narration et les minutages sont mis en cache indépendamment de la construction du lecteur, et la boîte de dialogue du film indique l'étape en cours parmi cinq avec un choix explicite de reprise ou de régénération à neuf. (#4290)
- Pré-vérifiez les octrois de dossiers Windows en mode protégé avec un contrôle ACL en lecture seule avant l'enregistrement : les dossiers inutilisables sont rejetés avec leur raison avant tout octroi écrit, de sorte que l'exécution du Notebook n'échoue plus tardivement avec une erreur de démarrage de noyau cachée. (#4217)
- Sélectionnez Qwen4 Max Preview depuis Bailian Token Plans à Beijing et Singapore : fenêtre de contexte de 1M, entrée multimodale et efforts de raisonnement low/medium/xhigh, résolus via le sélecteur de région existant et la console de clés. (#4311)

## 🔧 Improvements

- La récupération de la structure des PDF externes préserve des figures complètes avec leurs légendes, les enregistrements et cellules de tableaux, et l'ordre de lecture natif en ligne autour du texte mis à l'échelle et des en-têtes courants. (#4300, #4342, #4340)
- Les PDF traduits conservent la structure et la mise en page natives : le placement exige des preuves vérifiées appartenant à la cible, et le contenu d'origine est conservé chaque fois que le placement ne peut pas être prouvé. (#4334, #4286)
- Les importations de paquets de session rapportent leur résultat : l'annulation renvoie un résultat non nul, les délais d'expiration des requêtes sont marqués non confirmés avec un conseil de vérifier avant de réessayer, et les fichiers manquants ou les archives mal formées reçoivent des codes d'erreur distincts avec un identifiant de corrélation de journal. (#4338)
- Les modèles par défaut des connexions de fournisseurs officiels sont actualisés selon les recommandations actuelles. (#4301)
- Les surfaces d'aperçu s'adaptent aux fenêtres mobiles. (#4325)
- Une racine de données configurée peut être adressée via des alias enregistrés. (#4306)
- Le CLI local conserve les profils d'identifiants intacts, tolère les défaillances de la console et maintient les téléchargements d'artefacts actifs pendant l'arrivée des données. (#4298, #4299)

## 🐛 Bug Fixes

- Lorsque le bureau perd son service local, une surface de récupération à l'échelle de la fenêtre bloque désormais l'interaction avec l'espace de travail jusqu'au retour de la connexion, en gardant les brouillons montés et en restaurant le focus ensuite. (#4323)
- Les flux de mise à jour et de désinstallation Windows séparent la sécurité de la mise à jour du nettoyage des enregistrements, analysent les ressources d'installation physiques, récoltent les assistants détenus avant le transfert, annulent rapidement les vérifications de l'hôte, identifient les processus par identité de naissance plutôt que par PID seul, et préservent les diagnostics d'échec. (#4305, #4327, #4328, #4337, #4346)
- Les travaux de noyau Windows interrompus récupèrent, et la redirection de stderr PowerShell n'avale plus la sortie native du Notebook. (#4297, #4295)
- La persistance des sessions évite les impasses de nettoyage par suppression et découple l'hydratation au démarrage des enregistrements actifs. (#4312, #4314)
- Les erreurs d'exécution de l'agent distinguent les défaillances des fournisseurs de modèles des défaillances ACP, les sessions rechargées restent protégées jusqu'à l'activation de l'invite, et les invites annulées interrompent les recherches de classification. (#4322, #4283, #4289)
- Les octrois de dossiers enregistrés sans rapport ne bloquent plus le démarrage du Notebook. (#4309)
- Les aperçus gardent le contenu en place pendant les vérifications de version. (#4293)
- L'annulation directe d'un travail SSH borne les tentatives d'annulation non confirmées. (#4313)
- Le contraste est préservé sur les surfaces claires et sombres, y compris les avatars en mode sombre, la saisie de relecture et les transitions de thème. (#4345, #4339, #4332)
- Le bureau se ferme après la première erreur non interceptée du processus principal au lieu de continuer dans un état cassé. (#4316)
- Le statut de révision de l'environnement est libellé distinctement des autres états de révision, et les entrées de littérature acceptent les listes de packages LaTeX avec des espaces flexibles. (#4347, #4303)

## 🙏 Remerciements

- Merci à [@roxi3906](https://github.com/roxi3906) pour le mode de liste blanche Strict du Notebook ([#4253](https://github.com/aipoch/open-science/pull/4253)) et les corrections de présentation du code risqué ([#4318](https://github.com/aipoch/open-science/pull/4318), [#4282](https://github.com/aipoch/open-science/pull/4282)).
- Merci à [@ShuangChenyue](https://github.com/ShuangChenyue) pour la pré-vérification des octrois de dossiers Windows ([#4217](https://github.com/aipoch/open-science/pull/4217)).
- Merci à [@liyeshunag](https://github.com/liyeshunag) pour les correctifs des profils d'identifiants du CLI ([#4298](https://github.com/aipoch/open-science/pull/4298)) et la gestion des invites annulées ([#4289](https://github.com/aipoch/open-science/pull/4289)).
- Merci à [@cyj1116](https://github.com/cyj1116) pour les surfaces d'aperçu mobiles ([#4325](https://github.com/aipoch/open-science/pull/4325)) et les correctifs de téléchargement d'artefacts ([#4299](https://github.com/aipoch/open-science/pull/4299)), à [@wen2zhou](https://github.com/wen2zhou) pour les bornes d'annulation SSH ([#4313](https://github.com/aipoch/open-science/pull/4313)) et la préservation de la sortie PowerShell ([#4295](https://github.com/aipoch/open-science/pull/4295)), à [@liguohhh](https://github.com/liguohhh) pour la protection des sessions rechargées ([#4283](https://github.com/aipoch/open-science/pull/4283)), à [@nasus2002](https://github.com/nasus2002) pour l'analyse des entrées de littérature LaTeX ([#4303](https://github.com/aipoch/open-science/pull/4303)), à [@guch96](https://github.com/guch96) pour la persistance des sessions ([#4314](https://github.com/aipoch/open-science/pull/4314)), et à [@daanveer-tech](https://github.com/daanveer-tech) pour les mises à jour du README ([#4292](https://github.com/aipoch/open-science/pull/4292), [#4294](https://github.com/aipoch/open-science/pull/4294), [#4324](https://github.com/aipoch/open-science/pull/4324)).
