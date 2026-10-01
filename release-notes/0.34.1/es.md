## ✨ Lo más destacado

- **Nuevo par de conectores.** Un conector de CELLxGENE Discover descubre conjuntos de datos públicos de célula única, y un conector de Alliance of Genome Resources cubre genes de organismos modelo entre especies. (#3178, #3136)
- **Expansión de variantes y omics.** Las puntuaciones funcionales de MaveDB se unen al conector de variantes, y el conector de omics amplía su cobertura de Metabolomics Workbench. (#3131, #3139)
- **Bandeja de entrada en la vista previa de la biblioteca.** La vista previa de la biblioteca del espacio de trabajo gana una pestaña de Bandeja de entrada para la cola pendiente, con aceptar, descartar, deshacer y aceptación por lotes. (#3174)
- **gpt-6.1-sol.** El selector de modelos añade gpt-6.1-sol sin cambiar los valores predeterminados existentes. (#3157)

## 🚀 Novedades

- Conector de CELLxGENE Discover: busca conjuntos de datos y colecciones públicos de célula única, filtra por organismo, tejido, enfermedad, ensayo o tipo de célula, inspecciona versiones publicadas y obtén formatos de archivo, tamaños y URL de descarga, además de descripciones de tipos de célula de CellGuide y genes marcadores. (#3178)
- Conector de Alliance of Genome Resources: busca y resume genes en humano, ratón, rata, mosca, gusano, pez cebra, levadura y rana — ortólogos, modelos de enfermedad, anotaciones de fenotipo, alelos, expresión y asociaciones de términos de enfermedad. (#3136)
- Puntuaciones funcionales de MaveDB en el conector de variantes: búsqueda de conjuntos de puntuaciones y metadatos, puntuaciones funcionales específicas de ensayo, asignaciones de variantes VRS y experimentos. (#3131)
- Cobertura ampliada de Metabolomics Workbench en el conector de omics: registros de estudios, muestras, factores experimentales, metadatos de análisis y estructuras y referencias cruzadas de compuestos. (#3139)
- gpt-6.1-sol como opción de modelo, con los valores predeterminados sin cambios. (#3157)
- Pestaña de Bandeja de entrada en la vista previa de la biblioteca del espacio de trabajo: navega la cola pendiente con búsqueda y paginación, acepta o descarta elementos individuales con deshacer, y acepta lotes mediante una selección explícita de página. (#3174)
- Una entrada de importación de `.science` en el estado vacío del espacio de trabajo para importar paquetes de investigación. (#3170)
- Los paquetes de sesión pueden exportar contenido sensible reconocido con confirmación explícita. (#3164)
- Las exportaciones de diagnósticos locales conservan evidencia de solución de problemas para el soporte. (#3143)
- Atajos de envío de comentarios en los planes de sesión. (#3125)
- Estado del host mostrado en el menú de cómputo del compositor. (#3124)

## 🔧 Mejoras

- Las vistas previas de ejecución enlazan directamente a los mensajes relevantes. (#3120)
- Los borradores de skill están protegidos y las interacciones de skill se aclaran. (#3142)
- Las sugerencias de asignación de revistas se simplifican y los roles de las columnas de importación de revistas se aclaran. (#3172, #3169)

## 🐛 Correcciones

- **Notebook y tiempos de ejecución** — el estado del intérprete se conserva entre celdas (#3129); las herramientas globales de npm del sandbox se comparten entre sesiones (#3160); los fallos de enlace de la puerta de enlace de loopback se explican en lenguaje sencillo (#3138); la captura del linaje científico de Python y R se endurece (#3163).
- **PDF y vista previa** — el contenido nativo de figuras y tablas se conserva durante la extracción de estructura (#3162); los trabajadores de vista previa de PDF se ejecutan en clientes del navegador (#3135); las URL de referencia aparecen en la vista de detalle (#3151); la selección de anotaciones se borra antes de que se cierre el lector (#3156); el estilo de la vista previa de tablas combinadas y la sombra de desbordamiento de la columna fijada se corrigen (#3165, #3167).
- **Sesiones y paquetes** — los permisos de seguimiento sobreviven a los reinicios del agente (#3147); los metadatos booleanos se conservan durante la exportación del paquete (#3133).
- **Revistas** — los filtros de revistas se validan y las columnas de alias se reconocen (#3145); las lecturas de entradas de revistas invalidadas se reintentan (#3148).
- **Plataforma** — Windows permite reinstalar tras eliminar una instalación principal antigua (#3176); el inicio de KWallet en Linux se restaura (#3168); la identidad de credenciales acepta revistas SQLite completadas (#3126).
