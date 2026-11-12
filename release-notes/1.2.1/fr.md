## ✨ Highlights

- **Un seul endroit pour toutes les ressources.** Le Centre de ressources gère désormais les compétences, les connecteurs et les spécialistes — y compris l'installation depuis la place de marché, aussi dans l'interface Web — avec des cartes, des filtres et des vues de détail unifiés, et les références de compétences s'ouvrent dans le volet du projet sans quitter la conversation. (#4270)
- **Optimisation scientifique de l'invite.** Affinez l'invite du projet en cours depuis le composeur en un clic ; révisez, modifiez ou annulez le résultat et enregistrez des modèles personnalisés dans les paramètres du projet. L'optimisation ne s'exécute via votre fournisseur configuré que lorsque vous l'invoquez. (#3991)
- **Un Agent intégré plus robuste.** Les comptes d'abonnement Codex sont désormais disponibles pour l'agent principal et les sous-agents, Claude Fable 5.2 rejoint la liste des modèles, et les longues réponses ne sont plus tronquées à 4 096 jetons. (#4250, #4249, #4275)
- **Les longues sessions de recherche s'exportent sans à-coups.** Les exécutions du Notebook et de Compute stockent leurs preuves une seule fois sous une forme compacte et vérifiable, de sorte que les exports `.science` de longs historiques restent rapides et légers. (#4248, #4258, #4240)
- **Une connexion au calcul cloud qui résiste aux réseaux réels.** Modal et Hugging Face provisionnent un environnement d'exécution Python compatible avant l'ouverture du navigateur, et la vérification du compte suit désormais le proxy système. (#4255)

## 🚀 New Features

- Gérez les compétences, les connecteurs et les spécialistes — et installez depuis la place de marché, y compris dans le moteur de rendu Web — depuis le Centre de ressources unifié, avec des cartes de catalogue cohérentes, des filtres avec réinitialisation, une sélection en bloc et des tiroirs de détail ; les références de compétences depuis le composeur et les messages envoyés s'ouvrent dans le volet Centre de ressources du projet sans perturber la conversation active ni le brouillon. (#4270)
- Optimisez l'invite du projet actif depuis le composeur : révisez et modifiez le résultat avant qu'il ne remplace le brouillon, Annuler restaure le texte précédent et les pièces jointes collées supprimées, et les modèles d'optimisation personnalisés vivent dans les paramètres du projet. L'optimisation est manuelle et ne s'exécute via le fournisseur configuré que lorsqu'elle est invoquée. (#3991)
- Utilisez des comptes d'abonnement Codex importés ou appartenant à l'application pour l'agent principal et les sous-agents de l'Agent Open-Science intégré, la connexion, le rafraîchissement et le remplacement des identifiants réutilisant les flux de connexion Codex existants. (#4250)
- Sélectionnez Claude Fable 5.2 avec une fenêtre de contexte de 1M depuis la liste des modèles Anthropic fournis. (#4249)
- Exportez les métadonnées bibliographiques en CSV aux côtés de BibTeX et RIS — références sélectionnées sur plusieurs pages avec exclusions individuelles, ou un projet ou une collection entier — avec 16 noms de colonnes anglais stables et des cellules vides pour les valeurs manquantes. (#4262)

## 🔧 Improvements

- L'Agent intégré respecte la limite de sortie annoncée de chaque modèle (la valeur configurée, puis les métadonnées exactes du fournisseur, puis un repli de 16 384 jetons) et préfère le protocole de point de terminaison natif de chaque modèle, de sorte que les longues réponses prises en charge arrivent complètes. (#4275)
- L'Agent intégré mesure correctement son utilisation du contexte et compacte bien plus tard dans les longues sessions. (#4209)
- Une question de l'Agent désormais répondue n'attend plus une écriture différée de la persistance, supprimant le blocage « completion has not committed yet » avant que la réponse ne se poursuive. (#4279)
- Les cibles de calcul Modal et Hugging Face partagent un même flux de préparation de l'environnement d'exécution Python : l'interpréteur sélectionné est vérifié sans y installer, les appels d'autorisation et du SDK lui restent liés, et un résultat d'autorisation périmé ne peut plus écraser une connexion plus récente. (#4255)
- Les preuves du Notebook et de Compute sont stockées une seule fois par contenu unique avec des empreintes vérifiées ; les exports de longs historiques — des centaines d'exécutions sur les mêmes fichiers — produisent des paquets compacts, et le premier export comble rétroactivement les preuves historiques. (#4248, #4258, #4240, #4259)
- La génération de films de recherche se poursuit lorsque vous changez de session, au lieu de s'arrêter avec la conversation qui l'a lancée. (#4268)
- Les interpréteurs Python, R, REPL et Shell inactifs sont récupérés après 15 minutes sans activité de session, avec de petits réservoirs par type, de sorte que les conversations terminées n'accumulent plus d'environnements d'exécution résidents. (#4274)
- L'avis de réinitialisation du contexte se ferme tout seul après six secondes, et les cartes du catalogue de ressources gardent leurs avatars d'utilisation compacts. (#4281, #4276)

## 🐛 Bug Fixes

- Les fichiers du Notebook joints dans une conversation ouvrent à nouveau un aperçu, et les liens vers des fichiers locaux dans les réponses ouvrent le fichier correspondant. (#4257)
- L'empaquetage signé des mises à jour Windows est débloqué, et la récupération des mises à jour nomme les fichiers et processus qui retiennent l'application, élaguent les journaux de démarrage fermés et résolvent les blocages sans coincer l'installateur. (#4233, #4230, #4231, #4247)
- Les importations de littérature préservent le routage des identifiants et la casse des DOI. (#4225)
- Les aperçus des sources Web sont à nouveau adaptables dans les mises en page étroites. (#4220)
- La récupération de la structure des PDF externes se durcit contre les fichiers endommagés, et la traduction de PDF isole les invites d'agent et les capacités d'outils par document. (#4238, #4228)
- L'appariement mobile reste désactivé jusqu'à ce que vous le sélectionniez, et les échecs RPC de la télécommande Web expliquent ce qui s'est passé au lieu d'échouer silencieusement. (#4221)
- Les détails des erreurs des fournisseurs survivent à travers l'environnement d'exécution de l'agent, et les échecs de classification des requêtes OpenCode ne fuient plus au-delà de la requête qui les a rencontrés. (#4237, #4261)
- Les commits de conversation accusent réception des événements terminaux de manière fiable, les importations locales de CLI autorisées fonctionnent à nouveau dans les paquets de session, et la navigation vers le premier message est restaurée dans les longues conversations. (#4269, #4267, #4260)
- La récupération sous Linux ne confond plus les processus du noyau confirmés avec des processus du Notebook en fuite. (#4265)

## 🙏 Remerciements

- Merci à [@wen2zhou](https://github.com/wen2zhou) pour la prise en charge des abonnements Codex dans l'Agent intégré ([#4250](https://github.com/aipoch/open-science/pull/4250)), la préparation des environnements d'exécution Modal et Hugging Face ([#4255](https://github.com/aipoch/open-science/pull/4255)) et les aperçus de fichiers dans les conversations ([#4257](https://github.com/aipoch/open-science/pull/4257)).
- Merci à [@roxi3906](https://github.com/roxi3906) pour l'optimisation de l'invite par projet ([#3991](https://github.com/aipoch/open-science/pull/3991)).
- Merci à [@nasus2002](https://github.com/nasus2002) pour l'export CSV bibliographique ([#4262](https://github.com/aipoch/open-science/pull/4262)) et les corrections de gestion des DOI ([#4225](https://github.com/aipoch/open-science/pull/4225)).
- Merci à [@guch96](https://github.com/guch96) pour la correction de la poursuite après une question répondue ([#4279](https://github.com/aipoch/open-science/pull/4279)) et la récupération des mises à jour Windows ([#4230](https://github.com/aipoch/open-science/pull/4230)), à [@cyj1116](https://github.com/cyj1116) pour les améliorations de l'appariement mobile ([#4221](https://github.com/aipoch/open-science/pull/4221)), et à [@daanveer-tech](https://github.com/daanveer-tech) pour la documentation des benchmarks du README ([#4219](https://github.com/aipoch/open-science/pull/4219), [#4227](https://github.com/aipoch/open-science/pull/4227)).
