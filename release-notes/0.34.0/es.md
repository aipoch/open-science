## ✨ Lo más destacado

- **ARM64 nativo en Linux.** Open Science ahora ofrece instaladores ARM64 para Linux junto a los x64, cubriendo máquinas virtuales Linux en Apple Silicon y estaciones de trabajo ARM. (#3106)
- **Expansión de conectores.** Un nuevo conector de Pathway Commons se une a las fuentes ampliadas de expresión entre especies de cBioPortal, openFDA, MGnify y Bgee. (#3113, #3101, #3097)
- **Conjuntos de datos de revistas.** La biblioteca de literature gana conjuntos de datos de revistas con atributos de referencia para organizar colecciones. (#3095)

## 🚀 Novedades

- Instaladores nativos de Linux ARM64 junto a los paquetes x64 existentes. (#3106)
- Conector de Pathway Commons: busca vías, lista las principales, inspecciona grafos de interacciones y exporta resultados. (#3113)
- Herramientas de expresión entre especies de Bgee: llamadas de expresión, enlaces de descarga y consultas SPARQL entre especies. (#3097)
- Conectores ampliados de cBioPortal, openFDA y MGnify con cobertura de consultas más amplia. (#3101)
- MiniMax M3.1 Flash Preview como opción de proveedor integrada. (#3110)
- Claude Sonnet 5.5 como opción de modelo integrada de Anthropic. (#3116)
- Conjuntos de datos de revistas con atributos de referencia para organizar colecciones de literature. (#3095)
- Navegación de sesiones desde la bandeja en el escritorio para cambiar de sesión rápidamente. (#3047)
- Acciones de referencia en el espacio de trabajo para trabajar con referencias de literature en contexto. (#3058)
- Vista previa de referencias de la biblioteca y ámbitos de mensajes refinados. (#3042)
- Actualización del tiempo de ejecución a Electron 43. (#3060)

## 🔧 Mejoras

- Los cambios de espacio de trabajo conservan las filas de sesión, haciendo la navegación de la barra lateral notablemente más rápida. (#2992)
- El descubrimiento del intérprete genera menos subprocesos, acelerando el inicio del tiempo de ejecución. (#3055)

## 🐛 Correcciones

- **Sesiones y recuperación** — los paquetes de sesión reconocen valores de portador serializados y redactados (#3112); la recuperación se reanuda tras errores de conexión del agente (#3104); las conversaciones nuevas pueden iniciarse durante la preparación del envío (#3109); la delegación se restaura tras detener y reiniciar la app (#3092); la compactación de contexto nativa se estabiliza de forma fiable (#3053); la configuración de Prisma y la admisión de continuación se endurecen (#3028); el historial del subagente se conserva a lo largo de los ciclos de vida de la vista previa (#3091); los notebooks mantienen la primera vista previa de ejecución en segundo plano (#3054).
- **Literature y PDF** — la extracción de figuras y tablas se endurece (#3096); los metadatos ausentes y los detalles de importación de PDF se recuperan (#3049); todas las referencias se abren desde la vista previa de la biblioteca (#3068); el espaciado de las referencias en la vista previa se ajusta (#3103).
- **Revisor y tiempos de ejecución** — las evaluaciones de corrección interrumpidas se reanudan (#3093); el tiempo de ejecución de Codex exige una CLI compatible y repara tiempos de ejecución obsoletos (#3052).
- **Cómputo remoto** — se admiten listados de directorios remotos en macOS (#3085); la preparación del tiempo de ejecución de WSL y las notificaciones del ciclo de vida se endurecen (#3090).
- **UX del espacio de trabajo** — las ediciones están protegidas y las acciones del espacio de trabajo se aclaran (#3063); la selección por lotes de la biblioteca es opcional, con botones de chat aplanados (#3062); el foco del teclado y la navegación con escape se refinan (#3059); las regresiones de disposición, accesibilidad y flujo de trabajo se reparan (#3077); las devoluciones de llamada de recarga de anotaciones retiradas se ignoran (#3061).
- **Ajustes y explicaciones** — el instalador de Claude maneja redirecciones y respuestas HTML (#3098); las explicaciones de servidor local, permisos del tiempo de ejecución y controles desactivados son más claras (#3070, #3087, #3080).
