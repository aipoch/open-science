## ✨ Points forts

- **Dupliquer une session en une nouvelle copie accessible en écriture.** Une session locale ou importée peut être dupliquée avec l’intégralité de son historique de recherche — branches de conversation, entrées du Notebook, versions d’artefacts, littérature, annotations et marque-pages privés reçoivent tous de nouvelles identités. La session source n’est jamais modifiée et les sessions importées restent en lecture seule. (#2719)
- **Un seul nom de produit : Open-Science.** L’application se présente désormais de manière cohérente comme Open-Science dans l’interface, la CLI et le packaging. Les installations existantes conservent leurs noms et emplacements actuels — données de recherche, identifiants et paramètres sont préservés intacts. (#2567)
- **Les plans de session survivent à la reconstruction du contexte.** Une fois que l’agent a reconstruit son contexte, le plan de session actif est récupéré avec son identité, sa révision et ses approbations en attente, et les outils de plan restent disponibles dans la conversation. (#2661)
- **Les connexions de fournisseur sont validées avant d’être retenues.** Les modifications de fournisseur ne sont testées et enregistrées que si la connexion réussit ; lorsqu’un fournisseur enregistré est rejeté à l’exécution, sa disponibilité est mise à jour au lieu d’échouer silencieusement. (#2746)

## 🚀 Nouveautés

- Une carte d’informations de session dans l’en-tête de conversation affiche le numéro, le titre, la description, la session source, les horodatages et les décomptes de messages et d’artefacts de la session, avec un contrôle d’épinglage qui garde les titres longs compacts. (#2764)
- Les invites d’identifiants pour OpenAlex et NCBI mènent directement aux pages officielles de clés d’API. (#2761)
- Les recherches de variants gnomAD peuvent inclure en option les fréquences alléliques au niveau des populations et les décomptes de génotypes. (#2741)
- Les sessions dérivées vers une nouvelle conversation affichent un séparateur « suite de » ancré à leur tour source. (#2747)
- Paramètres unifie les titres de panneaux, les en-têtes de sections, le retour de sauvegarde et l’alignement des contrôles dans tous les panneaux. (#2739)

## ⚠️ Changements incompatibles

- Les réseaux STRING étendus signalent désormais le graphe complet renvoyé dans `nodes` : les voisins ajoutés portent `is_query=false` et `n_nodes` n’est plus égal au nombre de protéines d’entrée. Les scripts du Notebook qui traitaient `nodes` comme des correspondances d’entrée doivent filtrer sur `is_query`. (#2737)

## 🐛 Corrections

- **Notebook et calcul** — le R Windows s’exécute en mode standard sans configuration du mode protégé (#2708) ; les journaux d’exécution d’artefacts n’affichent plus de faux manques de preuves d’environnement (#2720) ; les diagnostics de verrou par exécution sont préservés pour les vérifications de reproductibilité (#2738).
- **Exécution de l’agent** — les conversations Codex restent utilisables lors du changement d’effort de raisonnement (#2724) ; les commandes d’arrêt, de reprise et de suivi en file d’attente restées bloquées aboutissent de manière fiable (#2745) ; les approbations réseau annulées sont retirées au lieu de persister sous forme de cartes mortes (#2744).
- **Sessions et autorisations** — la progression des étapes du plan de session reste visible pendant l’arrivée des mises à jour d’autorisations (#2759) ; l’achèvement des autorisations se réconcilie avec les tours simultanés et les tentatives d’envoi en doublon n’ajoutent plus de messages non diffusés (#2743) ; les changements d’autorisations sont permis avant le rejeu de l’historique de branche (#2736) ; les séparateurs de duplication s’ancrent au tour copié (#2733) ; les têtes d’artefacts non publiées survivent à la duplication sans bloquer le démarrage (#2730).
- **Connecteurs** — les accessions secondaires UniProt sont résolues vers leurs entrées primaires actuelles (#2762) ; Ensembl résout les identifiants FlyBase, WormBase et de levure avant le repli sur les symboles et préserve les erreurs de requête de séquence (#2715, #2752) ; les fréquences de mutation cBioPortal comptent les échantillons profilés par gène (#2721) ; les filtres d’éligibilité des essais cliniques respectent les bornes d’âge et de sexe (#2734) ; le rendu des molécules préserve les en-têtes molfile et rejette les structures vides (#2751).
- **Interface et stockage** — le modèle personnalisé actif se synchronise lors de l’enregistrement de son fournisseur (#2712) ; l’ouverture des pièces jointes préserve les boîtes de dialogue parentes (#2735) ; la fermeture des boîtes de dialogue ne fait plus clignoter ni réinitialiser le contenu (#2723, #2742) ; l’intention de suivi de la transcription survit aux changements de mise en page (#2732) ; le nettoyage du stockage et les imports locaux sont protégés contre les répertoires en lien symbolique et les fichiers sources réécrits (#2711) ; les paquets de spécialistes alignent les valeurs d’import par défaut et les contrôles d’export (#2756) ; les compétences OpenCode en lecture seule sont nettoyées après la délégation (#2716).
