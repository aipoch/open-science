## ✨ Points forts

- **Mémoire d'agent persistante.** L'agent peut désormais retenir l'essentiel d'une session à l'autre. Les entrées de mémoire opt-in, organisées en catégories par projet, sont rappelées automatiquement quand une conversation les concerne — et tout reste consultable, modifiable et effaçable depuis les réglages. (#1432)
- **Workflows de figures sensibles à la provenance.** Les compétences scientifiques intégrées se dotent d'aides enregistrées pour le style des figures, la composition multi-panneaux et les récits prêts pour publication — construites sur des entrées d'artefacts immuables, afin que chaque figure reste traçable jusqu'aux données qui l'ont produite. (#1864)
- **Gestion centralisée des identifiants.** Les jetons GitHub, les clés de connecteurs et les connexions de connecteurs vivent au même endroit, avec l'état de santé en un coup d'œil, une récupération guidée quand un identifiant cesse de fonctionner, et une revérification automatique des connecteurs concernés une fois l'identifiant réparé. (#1865)
- **Une vision plus complète de l'usage.** Le tableau de bord d'usage attribue désormais la consommation de jetons à l'exécution qui l'a produite et compte les appels de modèles hors de la conversation principale — conversations latérales, délégation et compaction de contexte incluses. (#1877, #1874)

## 🚀 Nouveautés

- **Mémoire d'agent persistante** — catégories de mémoire opt-in par projet, rappelées par l'agent avant les tours concernés ; les entrées se créent, se corrigent et se suppriment depuis un panneau de réglages dédié, et le rappel reste limité au projet de la conversation pour ne pas mélanger des travaux sans rapport. (#1432)
- **Gestion centralisée des identifiants** — un seul panneau pour les jetons d'accès personnels GitHub, les clés d'API de connecteurs et les connexions de connecteurs, avec état de santé, récupération guidée et acceptation des clés sur les offres gratuites à débit limité des sources de données ouvertes. (#1865)
- **Fournisseur Tencent TokenHub** avec des endpoints internationaux et Chine continentale plus un premier ensemble de modèles Tencent. (#1880)
- **Workflows de figures sensibles à la provenance dans les compétences intégrées** — des aides enregistrées pour le style des figures, la composition multi-panneaux et les récits prêts pour publication, qui consomment des entrées d'artefacts immuables et gardent les figures traçables jusqu'aux données qui les ont produites. (#1864)
- **Attribution d'usage par exécution** — l'usage de jetons est attribué à l'exécution qui l'a produite et persisté, le tableau de bord reste donc fidèle après redémarrage. (#1877)

## 🔧 Améliorations

- Le tableau de bord d'usage inclut désormais les appels de modèles hors de la conversation principale — conversations latérales, délégation et compaction de contexte — pour que les totaux correspondent à la facturation de votre fournisseur. (#1874)
- Les chargements de compétence dépliés rendent le document chargé en Markdown formaté, se rétablissent par réessai quand le document est inatteignable et se déplient sans sauts de défilement. (#1812)
- Un téléchargement de mise à jour échoué n'est plus un cul-de-sac : la boîte de dialogue reste actionnable et peut réessayer immédiatement. (#1868)
- Les téléchargements de mise à jour et les installations de runtime sont durcis — les manifestes sont validés avant usage, les installateurs doivent provenir de l'origine de confiance, et les installations expirées sont nettoyées complètement. (#1873)
- La sortie d'erreur de l'agent est résumée au lieu d'être déversée dans les journaux, gardant la recherche courante et les chemins locaux hors des diagnostics ; les échantillons bruts restent disponibles comme outil de support opt-in. (#1858)
- Le runtime CodeBuddy n'envoie plus de rapports d'erreurs d'exécution. (#1856)
- Le sélecteur de modèles explique pourquoi un modèle est actuellement indisponible au lieu de le désactiver en silence. (#1879)
- Les flux d'événements de l'API Task et du CLI gagnent une identité d'exécution stable avec rejeu borné : les consommateurs se reconnectent sans confondre des exécutions successives — et les flux révoqués ou terminés cessent de réessayer au lieu de boucler indéfiniment. (#1875)
- Les champs requis et les erreurs de champs sont désormais exposés aux technologies d'assistance. (#1869)

## 🐛 Corrections

- **Backend Claude** — une réponse Claude interrompue reprend au lieu de se figer (#1853) ; les identifiants de boucle locale survivent aux redémarrages et reconfigurations (#1878, #1859) ; et les permissions d'outils accordées par l'agent ne sont plus masquées par des réglages périmés (#1848).
- **Sessions** — un premier tour chargé ne masque plus la réponse de l'agent quand détails de session et comptabilisation d'usage se chevauchent (#1876), et les mises à jour comptables consécutives se rejouent proprement (#1860).
- **Service local et headless** — les corps de requêtes concurrents et les diffusions WebSocket sont bornés, et les clients bloqués sont déconnectés pour que le service localhost reste réactif sous charge. (#1857)
- **Exécutions longues** — les événements bruts d'exécution sont libérés après traitement, si bien que les tâches longues retiennent nettement moins de mémoire. (#1855)
- **Notebook** — les métadonnées internes de routage n'atteignent plus les appels de modèles du notebook. (#1861)
- **Accès aux dossiers** — une réponse périmée de boîte de dialogue ne peut plus fermer la mauvaise boîte d'octroi ni rapporter un dossier obsolète. (#1870)
- **Connecteurs** — l'annulation est désactivée pendant un enregistrement en cours, protégeant la continuation de la connexion OAuth. (#1867)
- **Espace de travail** — l'aperçu de session ne reste plus ouvert sous des menus d'actions ouverts. (#1852)
