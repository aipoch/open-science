## ✨ Highlights

- **Des mises à jour macOS plus légères.** Les mises à jour dans l'application sous macOS téléchargent désormais des deltas signés au lieu de blockmaps ZIP, de sorte qu'une mise à jour ne transfère que ce qui a changé — et qu'un delta manquant ne peut plus se transformer silencieusement en téléchargement complet. (#4649)
- **Lisez la littérature sans perdre votre place.** Les figures et les tableaux s'affichent en aperçu directement depuis les références dans le texte, et les passages sélectionnés se traduisent sur place — les PDF d'images d'une seule page s'ouvrent désormais avec une couche de texte sélectionnable. (#4681, #4667)
- **Plus de façons de connecter des modèles.** Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry et Vectrust rejoignent le catalogue de fournisseurs, aux côtés de préréglages dédiés Ollama, LM Studio, llama.cpp et vLLM avec découverte des modèles locaux. (#4662)
- **Une application plus légère et plus stable.** L'historique de transcription et les figures Notebook se chargent à la demande, les analyses du catalogue d'accueil et la saisie dans l'espace de travail coûtent moins cher, et l'admission mémoire du Notebook revérifie avant de poursuivre le travail sur le bureau. (#4676, #4678, #4695)

## ⚠️ Portée et sécurité

- **Les nouvelles connexions de fournisseurs envoient des données vers les points de terminaison que vous configurez.** Les requêtes via une passerelle cloud (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) vont à ce fournisseur selon ses conditions ; les préréglages locaux (Ollama, LM Studio, llama.cpp, vLLM) gardent le trafic sur la machine ou le réseau que vous leur indiquez. Vérifiez la destination avant d'acheminer du contenu de projet sensible par une connexion nouvellement ajoutée. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients). (#4662)

## 🚀 New Features

- Les fournisseurs gagnent des **préréglages de passerelle cloud** (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) avec des points de terminaison et une authentification spécifiques au protocole, et des **préréglages de modèles locaux** (Ollama, LM Studio, llama.cpp, vLLM) avec découverte des modèles locaux ; les fournisseurs cloud et locaux partagent une liste de modèles modifiable avec noms d'affichage, fenêtres de contexte et effort de raisonnement. (#4662)
- Les figures et les tableaux **s'affichent en aperçu dans le texte depuis les références** du lecteur PDF, même lorsque l'article ne lie que le numéro ou rien du tout. (#4681)
- Le lecteur PDF peut **traduire un passage sélectionné sur place**, en conservant votre position de lecture ; les PDF de littérature d'images d'une seule page s'ouvrent avec une couche de texte sélectionnable. (#4667)
- Les paramètres gagnent un **sélecteur de service d'images** qui présente les services officiels avant le formulaire personnalisé, et la liste des fournisseurs est réordonnée pour faire apparaître d'abord les abonnements actifs. (#4650)
- L'installation du bureau Windows installe désormais le lanceur de commande `open-science`, afin que les agents externes puissent piloter l'application juste après une installation silencieuse. (#4679)
- Les agents externes peuvent exécuter des boucles CLI/MCP groupées contre l'application via le contrat d'adaptateur d'agent partagé. (#4661)

## 🔧 Improvements

- Les longues sessions sont plus légères : l'historique de transcription et les figures Notebook se chargent à la demande au lieu de tout d'un coup, et les analyses du catalogue d'accueil et la saisie dans l'espace de travail font moins de travail par frappe. (#4676, #4678)
- L'admission mémoire du Notebook revérifie la mémoire disponible avant de poursuivre le travail sur le bureau, et les seuils mémoire multiplateformes sont abaissés pour correspondre à la marge réelle. (#4695, #4643)
- La disponibilité des modèles est désormais expliquée par cause, de sorte qu'un modèle inutilisable vous dit pourquoi au lieu d'échouer simplement. (#4696)
- Les installations d'agents gérés sondent les registres npm en parallèle, réduisant l'attente d'installation sur les réseaux lents. (#4660)
- Le contraste du thème et la visibilité des icônes de fournisseurs sont améliorés en modes clair et sombre. (#4655)

## 🐛 Bug Fixes

- La traduction PDF préserve la mise en page native plus fidèlement, avec une segmentation et une réécriture des PDF scientifiques améliorées, et la vérification d'aperçu est séparée pour que les problèmes de mise en page apparaissent avant la livraison. (#4671, #4693, #4697)
- La reprise de session se rétablit lorsqu'un fournisseur de modèle est temporairement indisponible, et les exécutions reprises sont validées par rapport à leur état de récupération durable au lieu d'échouer net. (#4672, #4652)
- Les nouvelles tentatives du pont de fournisseur préservent désormais l'erreur de modèle d'origine au lieu de la masquer. (#4653)
- Robustesse du Notebook : les métadonnées de passation et la sortie shell enregistrée survivent à la récupération de session, les sondes de démarrage restent limitées à la voie en récupération, et les figures capturées s'affichent lorsque les lignes d'outils s'étendent. (#4657, #4647, #4677)
- Les paquets de session dirigent l'espace temporaire vers la racine des données au lieu du disque système. (#4665)
- Mises à jour : le rappel de mise à jour bien visible est de retour, les mises à niveau Windows tolèrent les déconnexions transitoires du runtime, et les téléchargements du runtime sont retentés en cas de défaillance réseau. (#4646, #4645, #4644)
- Les vidéos de recherche conservent le texte alternatif pour les cibles non-images, la navigation de recherche importée reste réactive, et les fichiers de travail capturés ne déclenchent plus d'avertissements de troncature intempestifs. (#4670, #4663, #4648)

## 🙏 Remerciements

- Merci à tous ceux qui signalent des problèmes de mise à jour, de Notebook et de fournisseurs de modèles sur [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai) et [Discussions](https://github.com/aipoch/open-science/discussions).
- Merci à [@liguohhh](https://github.com/liguohhh) pour les préréglages de passerelle cloud et de modèles locaux ([#4662](https://github.com/aipoch/open-science/pull/4662)).
- Merci à [@nasus2002](https://github.com/nasus2002) pour les aperçus de figures et de tableaux dans le texte ([#4681](https://github.com/aipoch/open-science/pull/4681)).
- Merci à [@guch96](https://github.com/guch96) pour la boucle d'agent CLI/MCP groupée et les revérifications mémoire du Notebook ([#4661](https://github.com/aipoch/open-science/pull/4661), [#4695](https://github.com/aipoch/open-science/pull/4695)).
- Merci à [@ShuangChenyue](https://github.com/ShuangChenyue) pour les sondes de registres concurrentes et la récupération de session en cas de panne de fournisseur ([#4660](https://github.com/aipoch/open-science/pull/4660), [#4672](https://github.com/aipoch/open-science/pull/4672)).
- Merci à [@cyj1116](https://github.com/cyj1116) pour la passation Notebook et la récupération de la sortie shell ([#4657](https://github.com/aipoch/open-science/pull/4657)).
