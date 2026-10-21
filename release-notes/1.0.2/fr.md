## ✨ Highlights

- **Cinq nouveaux Connecteurs Scientifiques, ainsi qu'une prise en charge plus poussée de GDC et d'Ensembl.** Le catalogue couvre désormais la nomenclature génique HGNC, les annotations de littérature PubTator 3, les interactions médicament-gène DGIdb, les enregistrements d'ARN non codant RNAcentral, et un nouveau connecteur Orphadata pour les maladies rares (désactivé par défaut, activable par Specialist ou par le Main). Les recherches de fichiers et de cas GDC portent désormais des métadonnées d'échantillon, d'aliquote et de workflow tumeur/normal, afin que les résultats provenant de biospécimens différents ne soient plus mélangés sous un même cas, et l'outil Ensembl VEP accepte directement la notation de variant HGVS au lieu d'exiger une conversion manuelle en coordonnées. (#3738, #3744, #3732)
- **Les cartes de réponse disent enfin la vérité sur le nombre de réponses possibles.** Les questions à choix affichent désormais correctement un libellé Sélection simple ou Sélection multiple au lieu de toujours sous-entendre que plusieurs sélections sont autorisées, chaque question répondue dans un groupe affiche son texte complet et sa réponse au lieu d'être réduite sous un décompte partagé, et déplier une réponse passée révèle sa liste d'options complète. (#3690)
- **Les boîtes de dialogue de paquet de session arrêtent de sauter dans tous les sens.** La boîte de dialogue d'import/export `.science` ne se redimensionne et ne se repositionne plus au gré des étapes et des compteurs — elle garde une position stable et s'ajuste à son contenu. (#3747)
- **Chargement de session plus rapide sur les gros projets.** L'ouverture de sessions avec un long historique évite désormais les analyses de cohérence redondantes lors d'un rechargement propre et met en cache les recherches coûteuses, réduisant le temps d'hydratation et de démarrage sans affaiblir les vérifications de récupération exécutées après un arrêt non propre. (#3718)
- **Correctifs de sécurité pour le runtime Node intégré, et première publication npm de la CLI.** Les versions bureau et CLI autonome embarquent désormais Node 22.23.4 et une bibliothèque réseau Undici à jour, corrigeant les avis de sécurité Node.js d'octobre. La CLI autonome et le Task SDK sont désormais également installables via `npm install --global @aipoch/open-science`, en plus du tap Homebrew existant. (#3751, #3750)

## 🚀 New Features

- La CLI a gagné des commandes locales `version`, `help` et `paths` qui rapportent la version de l'application installée, l'aide des commandes et l'emplacement des répertoires de configuration sans avoir besoin d'un service en cours d'exécution. (#3752)
- Cinq nouveaux Connecteurs Scientifiques : nomenclature génique HGNC, annotations de littérature PubTator 3, interactions médicament-gène DGIdb, enregistrements d'ARN RNAcentral, et associations de maladies rares Orphadata (Orphadata est désactivé par défaut). (#3738)
- Les recherches de fichiers et de cas GDC peuvent filtrer par cas, type d'échantillon et workflow d'analyse, et les résumés incluent les métadonnées liées d'échantillon, d'aliquote et de workflow. (#3744)
- L'outil du connecteur Ensembl VEP accepte directement la notation HGVS (par exemple, un changement de codage de transcript), en plus des identifiants de variant et des coordonnées génomiques. (#3732)
- Mentionner un artefact avec `@` fonctionne désormais depuis les clients web distants, et pas seulement depuis l'application de bureau locale. (#3719)

## 🔧 Improvements

- Les sessions Codex utilisant des modèles sur abonnement reçoivent désormais la taille réelle de fenêtre de contexte du modèle, et l'utilisation rapportée reflète la capacité propre de Codex au lieu d'une valeur par défaut gonflée. (#3739)
- Les boîtes de dialogue d'erreur d'accès et d'attribution de dossier conservent le message d'erreur spécifique et traduit au lieu de regrouper tous les échecs sous un message générique, et ne tronquent plus leurs boutons d'action après l'affichage d'une erreur. (#3710)
- Les résultats d'export de diagnostics restent visibles dans une zone fixe au lieu d'être repoussés sous une liste de fichiers défilante, et les exports partiels sont affichés comme des avertissements plutôt que comme des réussites complètes. (#3741)
- Importer 257 Skills installées ou plus en une fois ne provoque plus d'échec pur et simple — les sélections importantes sont désormais soumises par lots. (#3711)
- Importer une Skill externe dont le nom commence par un préfixe réservé réussit désormais avec un nom local sûr au lieu d'être silencieusement filtrée hors du catalogue. (#3712)
- Déposer un dossier sur le compositeur de message affiche désormais un avis clair invitant à sélectionner les fichiers qu'il contient, au lieu de mettre en attente le dossier et d'échouer avec une erreur confuse. (#3709)
- Les brouillons et le travail en cours sont mieux protégés : les formulaires de paramètres Connector et Compute ne perdent plus de saisie non enregistrée à cause de complétions obsolètes, les erreurs de message en file d'attente sont visibles avec une option d'annulation, et l'application avertit avant de quitter ou de recharger en présence de messages non envoyés. (#3722)
- Changer de conversation pendant qu'un message vers une autre conversation est encore en cours d'envoi ne ramène plus la vue sur cette autre conversation. (#3706)

## 🐛 Bug Fixes

- Les identifiants de modèle/connecteur expirés ou invalides affichent désormais un parcours de récupération spécifique au lieu d'une erreur d'authentification brute, et le compositeur n'est désactivé que lorsque la récupération est réellement nécessaire, afin de ne pas perdre les brouillons ni les réponses en cours. (#3737)
- Une question durable ayant échoué avant d'être enregistrée, ou laissée en attente après un tour déjà terminé, pouvait chacune masquer à tort le compositeur derrière une carte de question obsolète ; les deux cas sont désormais résolus et le compositeur réapparaît. (#3734, #3725)
- Supprimer une collection Literature ayant une collection enfant du même nom ne signale plus à tort un conflit de nom et ne bloque plus la suppression. (#3736)
- Les aperçus DOCX ne réinitialisent plus les compteurs de listes numérotées en cours de document et affichent désormais les bordures de tableau de façon cohérente avec les éditeurs de documents de bureau. (#3735)
- La lecture des PDF préserve plus fidèlement les recadrages de figures, les légendes et la structure des tableaux, et le contenu du mode Lecteur est classé et mis en page plus précisément pour les PDF scientifiques complexes. (#3727)
- Fiabilité des paquets de session (`.science`) : relancer un import partiellement validé ne crée plus de session en double, modifier le titre d'une session importée n'est plus rejeté par la protection en lecture seule, les preuves d'exécution dupliquées au sein d'une archive sont partagées sur le disque au lieu d'être copiées par référence, et les échecs d'export conservent un diagnostic spécifique au lieu d'un message générique de manque d'espace disque. (#3694, #3733)
- Le suivi des dépendances de notebook et de la filiation des fichiers est plus précis à travers les lectures, transformations et exports CSV enchaînés, en Python comme en R. (#3728)
- Une finalisation d'artefact volumineux expirée en cours de transaction ne signale plus d'échec lorsque l'écriture sous-jacente avait déjà été validée. (#3717)
- Le connecteur MiniMax M3.1 intégré n'échoue plus lorsqu'il est utilisé via Codex. (#3731)
- Les échecs d'initialisation de Codex conservent désormais l'erreur de démarrage réelle dans les diagnostics au lieu d'un simple avertissement de nettoyage générique. (#3726)
- Quitter l'application alors que la connexion locale se coupe ne bloque plus l'application et n'affiche plus deux boîtes de dialogue d'erreur contradictoires. (#3704)
- Une session récupérée après une migration de stockage pouvait rester bloquée en état occupé même après une reprise réussie ; les nouvelles tentatives sont désormais admises correctement. (#3705)
- L'application pouvait rarement échouer à démarrer parce qu'un fichier journal SQLite partiellement écrit mais inoffensif était identifié à tort comme corrompu ; ce cas est désormais correctement reconnu, ce qui permet au démarrage de se poursuivre. (#3701)
- Quitter l'application pendant la validation d'une transaction de base de données n'empêche plus un arrêt propre. (#3703)
- Sous Windows, un fichier de permissions du bac à sable réseau de l'espace de travail verrouillé pouvait rester bloqué et échouer à se rétablir ; l'état des permissions est désormais préservé jusqu'à la fin du nettoyage. (#3721)
