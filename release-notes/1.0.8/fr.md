## ✨ Highlights

- **Les paramètres sont réorganisés en onglets dédiés.** Les préférences générales se répartissent en onglets spécialisés : Apparence et Notifications passent sous les paramètres Système, tandis que Général affiche désormais les informations de l'application, le diagnostic, les outils en ligne de commande et les ressources d'aide — dont un lien direct vers le guide d'installation et de mise à jour manuelles — sans fouiller. (#4022)
- **Importez des références par lots depuis DOI, arXiv ou PubMed.** « Ajouter depuis un DOI ou un lien » accepte désormais jusqu'à 100 identifiants mixtes par import — DOI, identifiant arXiv, PMID, PMCID ou liens d'article officiels — en les normalisant et dédupliquant avant l'examen habituel et l'enregistrement transactionnel. (#4039)
- **Synthèses d'étude par IA pour la littérature.** La vue détaillée de la bibliothèque Literature gagne une carte de synthèse IA qui résume un article en cinq sections structurées — question de recherche, population d'étude, méthodes, résultats principaux et limites — générée avec votre modèle principal configuré à partir du texte intégral ou de l'abstract, et étiquetée selon lequel a été utilisé. (#4037)
- **Les sessions terminées libèrent leurs processus d'agents.** Les sessions terminées sur les cinq frameworks d'agents n'accumulent plus de processus de fournisseur ni d'outils en mémoire : les runtimes de révision partagés, les baux de relève remplacés et les échecs de nettoyage sont libérés ou réessayés jusqu'à confirmation, pour que les longues journées de travail avec de nombreuses sessions restent réactives. (#4046, #4054, #4061)

## 🚀 New Features

- Tencent TokenHub gagne le modèle de raisonnement Hy4 et les routes actuelles de DeepSeek V4.1 Flash avec des fenêtres de contexte de 1 000 000 de tokens, ainsi que l'entrée d'image pour GLM-5.3-Flash, Kimi K3 et MiniMax M3. (#4060)

## 🔧 Improvements

- Les requêtes eQTL Catalogue fonctionnent à nouveau après le retrait de l'API REST en amont, en utilisant des fichiers indexés, et valident désormais que les coordonnées utilisent l'assemblage GRCh38 au lieu de retourner silencieusement des correspondances trompeuses. (#4036)
- L'ordre de lecture et l'extraction des PDF sont plus fiables : l'ordonnancement automatique utilise des indices de texte positionnés pour distinguer les colonnes de texte des lignes de tableau, les limites de recadrage sont vérifiées par rapport à la source native, les cellules de tableau ambiguës conservent leur texte d'origine avec un avertissement de fiabilité, et le worker PDF Windows ne plante plus lors du démontage. (#3994, #4056)
- Les boîtes de dialogue de mise à jour nomment désormais le processus bloquant au lieu d'imprimer les chemins système complets, et les échecs de récupération du bureau conservent leur preuve d'erreur réelle dans les paquets de diagnostic et les journaux au lieu de ne signaler qu'un échec générique. (#4047, #4045)
- La couverture de reproduction des analyses R est plus honnête : les appels scientifiques capables de forcer des arguments ou de distribuer des méthodes révoquent désormais les preuves de fichiers obsolètes, de sorte que la vérification en aval ne surestime plus les fichiers dont un résultat dépendait. (#4052)

## 🐛 Bug Fixes

- Les mises à jour macOS ne sont plus bloquées par de simples détenteurs de fichiers en lecture seule tels que l'agent StoreKit, et Windows ne classe plus les propres processus backend de l'application comme étrangers lors de la préparation de la mise à jour. (#4028)
- L'inspection de mise à jour Windows ne signale plus une occupation inconnue lorsque les outils système sont absents du PATH ou que les analyses sont longues, et les reçus Notebook obsolètes ne bloquent plus la récupération après la réutilisation d'un ID de processus. (#4042)
- Un téléchargement enregistré ne se termine plus par une erreur de permission lorsque le répertoire de destination lui-même n'est pas lisible ; le fichier terminé demeure. (#4053)
- Les outils en ligne de commande des notebooks en bac à sable utilisent le runtime Node de l'application lorsque la version du PATH est trop ancienne pour utiliser le proxy configuré, restaurant l'accès réseau dans le bac à sable. (#4058)
- Les vérifications de protection Windows ne ferment plus une passerelle partagée saine entre les sondages et ne signalent plus de faux échec d'exécution. (#4029)
- Une nouvelle recherche d'un article efface la notification précédente « le PDF n'a pas pu être ajouté » une fois la nouvelle recherche réussie. (#4041)
- Pi s'installe désormais correctement dans l'application de bureau empaquetée au lieu d'échouer en localisant ses fichiers d'amorçage. (#4027)
- Le compositeur n'affiche plus de notification de modèle indisponible en double à côté du statut du sélecteur de modèle. (#4051)
- Un téléchargement d'artefact qui se termine puis échoue en libérant sa capacité ne s'échappe plus comme erreur non gérée susceptible de terminer le backend. (#4055)
- Les artefacts Markdown réparent une tête de provenance obsolète laissée par d'anciennes versions à l'ouverture, et le panneau de provenance explique désormais explicitement les preuves d'exécution incomplètes. (#4021)
