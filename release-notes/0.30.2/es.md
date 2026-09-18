## ✨ Lo más destacado

- **R en Windows vuelve a ser fiable.** El R gestionado con conda se inicia de forma fiable en Windows, el intérprete se resuelve de nuevo tras la materialización del entorno, la recuperación verificada del kernel conserva la ejecución y las comprobaciones de recetas selladas recuperan los puntos de entrada pip verificados de Windows. (#2630, #2645, #2653, #2679)
- **Los turnos del Notebook se reproducen correctamente.** Las entradas del mismo turno y las importaciones de la biblioteca estándar se restauran en la reproducción, de modo que una nueva ejecución ve exactamente las entradas que vio la ejecución original. (#2706)
- **Las correcciones del revisor conservan su contexto.** Los hilos de retroalimentación vinculados ya no pierden el contexto de corrección entre rondas, y la revisión automática sobrevive al inicio de una conversación nueva. (#2682, #2625)
- **Evidencia de literatura y conectores más limpia.** Las importaciones de PubMed separan los apellidos de los autores de las iniciales (y dejan de interpretar sufijos como "Jr." como iniciales), las cadenas de retractación que afloran mediante actualizaciones de Crossref se comprueban, y Ensembl, VEP, Reactome, OLS, CellGuide, UCSC y gnomAD se comportan con precisión. (#2675, #2677, #2693, #2703, #2696, #2687, #2664, #2663, #2634)

## 🔧 Mejoras

- DeepSeek V4.1 Flash se incorpora al catálogo de modelos, con los modelos heredados de las sesiones conservados tras la actualización (#2660), y la gama de Volcengine Ark se renueva (#2673).
- Los indicadores de selección de pestañas se animan con fluidez. (#2638)
- Las tarjetas de herramientas de literatura se unifican y los detalles de literatura se amplían. (#2670)

## 🐛 Correcciones

- **Notebook y cómputo** — el R de conda en Windows vuelve a iniciarse con los fallos del sandbox rastreados (#2630); el ejecutable de R se resuelve tras la materialización del entorno (#2645); se conservan la ejecución y la recuperación verificada del kernel (#2653); las entradas del mismo turno y las importaciones de la biblioteca estándar se reproducen (#2706); los puntos de entrada pip verificados de Windows se recuperan para las comprobaciones de reproducibilidad (#2679); las instantáneas de conversaciones en cola de la CLI se concilian (#2676); no se producen escrituras durante la hidratación pasiva de conversaciones (#2640).
- **Literatura** — los apellidos y las iniciales de los autores de PubMed se separan (#2675) y los sufijos de los autores ya no se tratan como iniciales (#2677); se comprueban las relaciones de retractación "updated-by" de Crossref (#2693).
- **Conectores** — las búsquedas de Ensembl informan de la especie resuelta (#2703); las consultas de regiones de VEP se normalizan a la hebra directa (#2696); la especie solicitada de Reactome se respeta y se valida (#2687); los fallos de OLS se conservan y la paginación de relaciones se valida (#2664); los fallos de obtención de datos de CellGuide se muestran correctamente (#2663); los límites de UCSC se validan y los límites de gnomAD se ajustan (#2634).
- **Sesiones y conversaciones laterales** — las conversaciones laterales conservan su punto de montaje en la aplicación (#2680) y ya no esperan la disponibilidad del turno principal para su admisión (#2668); los subagentes de OpenCode delegados se ejecutan en entornos de ejecución aislados (#2652).
- **Habilidades y mercado** — las habilidades del entorno de ejecución vinculadas a especialistas se preparan correctamente (#2698); el mercado muestra su fuente cuando faltan los autores (#2672); las referencias de habilidades de OpenCode aprovisionadas resultan legibles (#2651).
- **Permisos y configuración** — la aprobación de la búsqueda web nativa se recuerda durante la conversación (#2646); Configuración permanece abierta al descartar la navegación móvil (#2658); la identidad de sesión de Go se incluye en los sondeos de proveedores (#2662); el detalle de la imagen original se normaliza en el puente de Responses (#2650); la acción de deshacer permanece por encima del panel de configuración (#2641); los diseños de mensajes contextuales en línea se restauran (#2674).
