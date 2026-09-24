## ✨ Lo más destacado

- **Cribado inteligente de Literature en vivo.** Las colecciones inteligentes criban ahora las referencias en vivo, con controles de pausa y reanudación que mantienen los cribados de gran tamaño bajo tu control de principio a fin. (#2968)
- **Conectores y herramientas de alineamiento nuevos.** HMMER se incorpora a la familia de conectores para búsquedas de homología HMMER3 específicas de programa de EMBL-EBI (#2957); InterProScan se incorpora como conector que comprueba el estado y recupera resultados de trabajos de anotación existentes (#2935); y el conector Genomes incorpora el alineamiento múltiple de secuencias con Clustal Omega (#2944).
- **Actualización de los catálogos de proveedores.** GPT-6 y Claude Opus 5.5 se incorporan a los catálogos de proveedores, listos para elegir en configuraciones nuevas y existentes. (#2967)
- **La evidencia en PDF viaja con la conversación.** Las conversaciones del espacio de trabajo pueden incluir ahora evidencia en PDF junto al primer mensaje, de modo que el contexto llega antes de que el agente empiece a trabajar. (#2941)

## 🚀 Novedades

- Cribado inteligente de Literature en vivo: las ejecuciones de cribado evalúan las referencias a medida que llegan y se pueden pausar y reanudar en cualquier punto. (#2968)
- Conector HMMER: envía búsquedas específicas de programa con HMMER3 de EMBL-EBI —phmmer, hmmscan, hmmsearch o jackhmmer— sobre secuencias de proteínas, perfiles HMM y alineamientos contra bases de datos correspondientes. (#2957)
- Conector InterProScan: comprueba el estado y recupera los resultados de trabajos de anotación de InterProScan existentes por ID de trabajo. (#2935)
- El alineamiento múltiple de secuencias con Clustal Omega llega al conector Genomes: alinea tres o más registros FASTA de proteínas, ADN o ARN con Clustal Omega de EMBL-EBI y recupera un archivo de alineamiento descargable. (#2944)
- Los modelos GPT-6 y Claude Opus 5.5 se incorporan a los catálogos de proveedores. (#2967)
- Las conversaciones del espacio de trabajo pueden incluir evidencia en PDF con el primer mensaje, de modo que el agente ve el material de origen antes de empezar. (#2941)
- Los diagnósticos de sesión pueden incluir evidencia de paquetes sensible cuando lo autorizas explícitamente, aportando un contexto más profundo para la resolución de problemas. (#2947)
- Las colecciones de Literature distinguen ahora sus ámbitos y los enlazan, de modo que las colecciones personales y compartidas quedan claramente separadas y conectadas. (#2938)

## 🔧 Mejoras

- La cabecera de la sección de proveedores de Configuración incorpora una acción directa de proveedor, de modo que añadir o ajustar proveedores requiere menos pasos. (#2970)
- Los archivos del espacio de trabajo reciben iconos de tipo de archivo unificados, lo que facilita hojear de un vistazo carpetas con contenido mixto. (#2965)

## 🐛 Correcciones

- **Notebook** — los entornos de Python gestionados se restauran en Windows y la ruta de Python gestionada se activa durante el descubrimiento, de modo que los entornos gestionados por la app vuelven a funcionar en Windows (#2953, #2951); cuando se deniega el acceso al entorno de ejecución de R, la app ahora lo solicita en lugar de fallar en silencio (#2930).
- **Sesión** — las condiciones de carrera al guardar en tiempo de ejecución y en cómputo se recuperan limpiamente en lugar de perder trabajo (#2955); la continuación y la revelación de la revisión se estabilizan (#2950); una admisión no disponible se reintenta una vez antes de rendirse (#2943).
- **Puente del agente** — el puente ACP se reconecta cuando cambia la capacidad de visión, de modo que las sesiones ya no se quedan atascadas tras una actualización de capacidad (#2963).
- **Espacio de trabajo** — el compositor permanece ocupado mientras un mensaje del agente está activo, evitando envíos duplicados accidentales (#2836); la identidad de la vista previa de PDF se conserva en el primer envío (#2948).
- **Configuración** — los atajos de búsqueda global y local se separan para que ya no colisionen (#2934); se completa la traducción de los textos de conectores (#2946).
- **Habilidades** — los flujos de trabajo de recorte y revisión de figuras vuelven a comportarse correctamente (#2936).
- **Almacenamiento** — las ubicaciones históricas de datos persisten y están protegidas entre actualizaciones (#2865).
- **Paquetes y onboarding** — los indicadores de token ya no se detectan dentro de palabras no relacionadas (#2940); la marca DeepSeek en el onboarding se normaliza (#2939).
- **Interfaz** — la información sobre herramientas de edición de anotaciones se simplifica (#2966); el instalador de Windows informa de los fallos de limpieza con diagnósticos accionables (#2952); los iconos de tipo de archivo se agrandan en pestañas y listas (#2976); el conector OpenAlex ya no requiere credenciales, de modo que las búsquedas de literatura funcionan desde el primer momento (#2969).
