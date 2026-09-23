## ✨ Lo más destacado

- **Colecciones inteligentes de Literature.** Una colección puede ahora cribar sus referencias frente a una descripción con criterios explícitos de inclusión y de exclusión, clasificándolas en Incluida, Requiere revisión, Excluida y No evaluada — las decisiones de la IA y las manuales se distinguen, se pueden evaluar referencias individuales o seleccionadas, y la evidencia en PDF opcional, las vistas previas de borradores, la cancelación, los reintentos explícitos y las actualizaciones automáticas opcionales mantienen manejables los cribados de gran tamaño. (#2897)
- **Los paquetes de investigación incorporan metadatos RO-Crate.** Los paquetes `.science` recién exportados describen su instantánea final con metadatos RO-Crate 1.1, reutilizando payloads inmutables seleccionados y reconstruyendo las referencias tras volver a exportar. Los paquetes existentes siguen siendo legibles sin migración. (#2869)
- **Tres conectores nuevos.** El descubrimiento de registros públicos de Zenodo busca registros y recupera metadatos e inventarios de archivos sin autenticación (#2868); las herramientas de GDC listan proyectos y casos de genómica del cáncer, buscan metadatos de archivos y generan manifiestos sin implicar autorización de descarga (#2896); la asignación por lotes de identificadores de UniProt convierte hasta 100.000 identificadores entre bases de datos con resultados sin coincidencia explícitos. (#2881)
- **Controles de acceso a recursos por agente.** Configuración reúne en un solo lugar el acceso del agente principal y de los especialistas a habilidades y conectores, con indicadores de uso bajo cada recurso y un único punto de ajuste. (#2835)

## 🚀 Novedades

- Colecciones inteligentes de Literature: cribado dirigido por descripción con criterios de inclusión/exclusión, estados Incluida / Requiere revisión / Excluida / No evaluada, etiquetas de decisión de IA o manual, evaluación individual o por lotes y actualizaciones automáticas opcionales. (#2897)
- Exportación de diagnósticos de sesión: la cabecera de la sesión y el menú lateral pueden empaquetar las fuentes de diagnóstico elegidas en un único archivo local, de modo que informar de una conversación que falla ya no obliga a rastrear archivos. (#2867)
- Los modelos Xiaomi MiMo v2.6 se incorporan al selector de proveedores con ventanas de contexto de un millón de tokens; `mimo-v2.6-pro` pasa a ser el predeterminado en las nuevas configuraciones, mientras que los modelos v2.5 se conservan para las existentes. (#2894)
- Grok 4.7 se incorpora al catálogo de xAI como nuevo predeterminado con una ventana de contexto de 500.000 tokens y entrada de imágenes; los IDs de los modelos anteriores siguen disponibles. (#2887)
- Los modelos de la generación actual renuevan los catálogos de los proveedores Zen y Go, con datos de protocolo, contexto, visión y esfuerzo de razonamiento verificados frente a la documentación de la gateway. (#2910)

## 🔧 Mejoras

- El streaming sigue respondiendo bajo carga: la estimación de tokens y las colas de streaming tienen límites acotados, los streams de asistente específicos de cada framework se normalizan y los fragmentos de pensamiento se descartan antes de llegar al renderer. (#2903, #2895, #2883)
- Los metadatos RO-Crate de los paquetes de sesión se refuerzan: se conservan los nombres de archivo alternativos y los tipos MIME de los payloads compartidos, y los tamaños declarados en conflicto se rechazan antes de construir el grafo de metadatos. (#2880)

## ⚠️ Cambios importantes

- Los paquetes de investigación `.science` recién exportados incluyen metadatos RO-Crate que describen la instantánea final exportada. Leer los paquetes recién exportados requiere un lector compatible con la capacidad ro-crate; los paquetes existentes siguen siendo legibles sin migración, y los esquemas nativos de la base de datos y de las evidencias no cambian. (#2869)

## 🐛 Correcciones

- **Entorno de ejecución de agentes** — las versiones de Claude CLI no compatibles se bloquean con una señal clara de disponibilidad en lugar de un error opaco al crear la sesión (#2901); los errores de adopción del fallback sobreviven a una reanudación fallida (#2906); las ejecuciones activas obsoletas se recuperan antes de añadir mensajes nuevos (#2877).
- **Paquetes de investigación** — los bloqueos por exportación de credenciales falsos positivos ya no se activan en paquetes ordinarios (#2904).
- **Notebook** — los avisos de entorno y de recuperación en segundo plano se pueden descartar, de modo que un panel bloqueado o un toast atascado ya no exigen un parche manual (#2905, #2870); las sondas de inventario de R en Windows se ejecutan como scripts de una sola línea (#2899); los efectos auxiliares se conservan para la trazabilidad (#2834).
- **Plataforma** — la herramienta de restablecimiento de paquetes de Windows limpia los atributos de solo lectura del árbol (#2902); los paquetes de Linux incluyen el motor de consultas de Fedora, de modo que los sistemas basados en Fedora arrancan de forma fiable (#2886).
- **Interfaz y conectores** — los controles de diagnóstico toleran un arranque lento y el diálogo de exportación se ha refinado (#2893, #2888); los resaltados de búsqueda se restauran y las interacciones con PDF se estabilizan (#2912); los ajustes de acceso a recursos ya no se desbordan horizontalmente (#2879); la tarjeta de recuperación de especialistas se mantiene por encima del dock del compositor (#2873); los catálogos MCP del puente Codex se alinean con el registro actual (#2885); las pistas de conservación de ratón de UCSC usan el valor predeterminado correcto (#2861).
