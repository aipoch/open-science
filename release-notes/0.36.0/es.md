## ✨ Lo más destacado

- **Ejecución de notebooks revisable.** Cada ejecución de notebook se examina en busca de código destructivo o arriesgado antes de ejecutarse; las ejecuciones arriesgadas muestran una tarjeta de revisión centrada con el contexto de la línea de origen y un comprobante persistente, mientras que el análisis habitual se ejecuta sin peticiones repetidas. (#3336)
- **Traducción de PDF compartida y reanudable.** Traduce un PDF completo con puntos de control a nivel de párrafo, alterna entre los modos de lectura de original, traducción y comparación lado a lado, y reanuda entre sesiones: una edición guardada por PDF gestionado, compartida entre todas las entradas. (#3334)
- **Alcance de conectores.** Un nuevo conector PDC trae descubrimiento de estudios de proteómica del cáncer, de biospecímenes y de archivos, y el conector de Genomas gana consultas de desequilibrio de ligamiento específicas por población. (#3335, #3337)
- **Claude Haiku 5.5.** El catálogo de Anthropic integrado añade Claude Haiku 5.5 con su ventana de contexto de 1M de tokens. (#3333)

## 🚀 Novedades

- Ejecución de notebooks revisable con análisis de riesgo por ejecución y comprobantes de revisión persistentes (#3336)
- Traducción de PDF de documento completo y reanudable con modos de lectura de original/traducción/comparación (#3334)
- Conector PDC: búsqueda de estudios de proteómica del cáncer, asociaciones de biospecímenes y metadatos cuantitativos de archivos (#3335)
- Consultas de desequilibrio de ligamiento de Ensembl específicas por población: r²/D′ por pares y búsqueda de variantes proxy (#3337)
- Claude Haiku 5.5 en el catálogo de modelos de Anthropic (#3333)
- Seleccionar todo para la página cargada en las barras de herramientas por lotes de la Biblioteca de literatura y la Bandeja de entrada (#3340)
- Arrastra una tarjeta de archivo de proyecto o el artefacto abierto al compositor para mencionarlo (#3315)

## 🔧 Mejoras

- El linaje de dependencias científicas es más sólido para notebooks de Python y R: se rastrean más lectores científicos, transformaciones de contenedor y devoluciones de llamada, de modo que las aristas de dependencia y los efectos sobre archivos siguen siendo precisos (#3309, #3332)

## 🐛 Correcciones

- La extracción de estructura de PDF conserva las maquetaciones científicas nativas: tablas completas, encabezados jerárquicos, pies de página y figuras multipanel (#3320)
- El panel de Archivos ya no bloquea las menciones de archivos en una conversación nueva (#3338)
- Buscar (Ctrl/Cmd+F) vuelve a funcionar en un espacio de trabajo vacío (#3316)
- El Marketplace de especialistas se abre en Remote Web (#3331)
- Los chips de mención compactos en los compositores de sesión nueva vuelven a renderizarse a su tamaño normal (#3341)
- Los alias de sufijo de tamaño de contexto se eliminan de los catálogos de modelos oficiales, corrigiendo fallos de selección de modelo con algunos motores (#3326)
