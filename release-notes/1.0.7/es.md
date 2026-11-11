## ✨ Highlights

- **Pi se incorpora como quinto framework de agentes.** Junto a Claude Code, OpenCode, Codex y CodeBuddy, ahora puede ejecutar sesiones con el agente Pi, incluidos la incorporación, la configuración, la validación de conexión y el inicio de sesión de suscripción donde esté disponible. (#3921)
- **Añada referencias directamente desde un enlace DOI o arXiv.** La biblioteca Literature incorpora la entrada Añadir desde DOI o enlace: pegue un DOI simple, un enlace del resolvedor de DOI o una URL de resumen o PDF de arXiv, revise los metadatos resueltos y guárdelo como referencia sin preparar un archivo de importación. (#3990)
- **Los agentes anotan los PDF mientras lee.** Los agentes de lectura ahora pueden enumerar, localizar y crear notas y marcas en Notas y anotaciones existentes de la biblioteca Literature para los PDF vinculados, de modo que peticiones como «marque este párrafo y resuma por qué importa» persisten como anotaciones reales. (#3981)
- **Los PDF escaneados se vuelven legibles con OCR opcional y nueve paquetes de idioma.** OCR pasa a ser un componente bajo demanda en lugar de una carga integrada, con datos de reconocimiento descargables para inglés, chino simplificado y tradicional, alemán, español, francés, japonés, coreano y ruso: el texto de las páginas escaneadas aparece en la lectura de Literature, con indicadores de cobertura por página. (#3973, #4000)

## 🚀 New Features

- El marketplace de intercambio para casos de investigación ahora se puede buscar desde Inicio y el espacio de trabajo de conversación: pestañas de categoría, búsqueda por palabra clave, descargas directas desde los detalles del caso, y sus filtros y posición de desplazamiento se conservan al moverse entre el marketplace y un proyecto. (#3996)

## 🔧 Improvements

- La configuración ahora describe cada conector científico individualmente — Europe PMC, Research Datasets, ChEA3, bioDBnet y CTD — en lugar de compartir un resumen genérico. (#3993)
- Los avisos de fallo del compositor se unifican en una superficie coherente: los fallos de proveedor, entorno, entrada, sesión e internos presentan cada uno una acción de recuperación clara en lugar de formatos de error competidores. (#3989)
- Publicar o restaurar un artefacto siempre trae adelante su última versión publicada, y el panel de procedencia explica las relaciones entre versiones con más claridad. (#3783)
- La selección de idioma de OCR permanece receptiva mientras se guarda, y las tarjetas de modelos locales presentan el estado y las acciones de forma más coherente. (#4017)

## 🐛 Bug Fixes

- Los notebooks de Windows vuelven a preparar su runtime de shell antes del primer uso, restaurando el acceso a PowerShell en backends recién instalados. (#4011)
- Las sesiones de OpenCode ya no terminan cuando los flujos de compactación emiten identidades de mensaje no estándar. (#3998)
- Preguntar un seguimiento mientras una tarea en segundo plano se estabiliza ya no descarta la nueva ejecución. (#3997)
- Las descargas de texto completo funcionan en hosts que usan modos DNS de tipo Fake-IP como Mihomo o Clash, aplazando la resolución al proxy configurado cuando todas las respuestas locales son un marcador de posición. (#3977)
- La actividad de herramientas de Pi se representa con la presentación compartida de Skill, Notebook y Literature en lugar de etiquetas genéricas de entrada y salida. (#4016)
- Una descarga de componente OCR estancada ya no bloquea las lecturas ordinarias de PDF más allá del plazo existente. (#4019)
