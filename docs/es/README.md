<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science es un entorno de investigación con IA de código abierto, centrado en el trabajo local y con modelos flexibles para una ciencia reproducible. Comparta un paquete <code>.science</code> portátil para que otras personas puedan examinar las pruebas que respaldan un resultado, o exporte un vídeo de investigación para mostrar cómo llegó a él.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="Demostración de AIPOCH Open-Science para crear un paquete .science" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">Ver en YouTube: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Descargar AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Última versión de AIPOCH Open-Science" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI de AIPOCH Open-Science en Zenodo" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Preprint de AIPOCH Open-Science en arXiv: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#rendimiento-en-benchmarks">
    <img alt="AIPOCH Open-Science — Resultados de benchmarks" src="../images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Plataformas macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Licencia Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Sitio web aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="README en inglés" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README en ruso" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="README en alemán" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README en español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Este documento es una traducción del `README.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../README.md).

### 💡 AIPOCH Open-Science v1.2.2 — Novedades

_12 de noviembre de 2026_

- **Modo de red estricto**: Active un modo Strict con lista blanca para la red de Notebook — las solicitudes deben coincidir con sus reglas por protocolo, host y puerto; las solicitudes sin coincidencia se bloquean sin solicitud de autorización.
- **Reanudación de películas**: La generación interrumpida de una película de investigación continúa desde puntos de control validados con una vista de progreso de cinco pasos; las escenas completadas y la narración se reutilizan.
- **Fidelidad de PDF**: Los PDF externos conservan figuras nativas, tablas, pies de figura y orden de lectura, y los documentos traducidos preservan la estructura y el diseño originales.
- **Concesiones más seguras en Windows**: Las concesiones de carpetas en modo protegido se comprueban antes de guardar, y los flujos de actualización, desinstalación y entrega se recuperan con más fiabilidad conservando los diagnósticos.
- **Actualizaciones de proveedores**: Qwen4 Max Preview se suma a Bailian Token Plans en Pekín y Singapur, y los modelos predeterminados de las conexiones oficiales se actualizan.
- **Correcciones de fiabilidad**: Las importaciones de sesiones informan de su resultado, la recuperación del servicio bloquea el espacio de trabajo hasta que la conexión vuelve y el contraste del modo oscuro se conserva en todas las superficies.

[Notas completas v1.2.2](https://github.com/aipoch/open-science/releases/tag/v1.2.2)

<a id="share-your-research"></a>

## Un registro de investigación para compartir, un vídeo para ver

Entregue un [paquete `.science`](https://aipoch.com/docs/guides/research-packages/) con las ramas de conversación, versiones de archivos, registros del Notebook y comprobaciones que desee compartir. Quien lo reciba podrá importarlo en su proyecto y consultar el registro de solo lectura para rastrear una figura o tabla hasta sus datos de entrada. Las verificaciones corresponden a quien envía el paquete. En la aplicación de escritorio, una bifurcación crea una copia editable.

Presente el trabajo en un [vídeo de investigación](https://aipoch.com/docs/guides/research-films/). En la aplicación de escritorio, genere el vídeo a partir de una rama de conversación finalizada. El modelo configurado prepara la presentación a partir del registro y el motor de voz local genera la narración en inglés. Revise el vídeo y descargue el reproductor HTML o exporte un MP4. El paquete `.science` también puede incluir el reproductor de un vídeo ya generado en una de sus ramas.

## 🚀 Inicio rápido

### 1. Descargue la aplicación

Abra la [página oficial de descargas](https://aipoch.com/open-science/download) y elija el instalador para su equipo:

| Su equipo                                 | Elija                                              |
| ----------------------------------------- | -------------------------------------------------- |
| macOS 12+: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64         |
| macOS 12+: Intel                          | El DMG de macOS para Intel/x64                     |
| Windows 10/11 x64                         | El instalador de Windows x64 (con firma de código) |
| Linux x64                                 | El paquete AppImage o Debian de Linux x64          |
| Linux ARM64                               | AppImage o paquete Debian de Linux ARM64           |

Consulte la [verificación de descargas](../../SECURITY.md#verifying-your-download) para realizar comprobaciones antes de instalar.

Los archivos de la CLI independiente para macOS, Linux y Windows incluyen Node.js y se pueden usar sin Homebrew ni npm.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

Para la CLI independiente en macOS o Linux, utilice el [tap de AIPOCH](https://github.com/aipoch/homebrew-tap) por separado:

```bash
brew install aipoch/tap/open-science
```

La fórmula incluye Node y no necesita la aplicación de escritorio en ejecución; su versión puede diferir del Cask de escritorio. Consulte los requisitos y las actualizaciones en la [guía del entorno independiente](../standalone-runtime.md).

Para el CLI independiente y la interfaz web, instale el [paquete npm publicado](https://www.npmjs.com/package/@aipoch/open-science) con **Node.js 22.13.0 o posterior**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Abra la URL indicada para completar la configuración o siga la [guía de configuración desde el terminal](../../packages/open-science/CLI.md#first-run-setup-codex). npm admite macOS ARM64/x64, Linux ARM64/x64 con glibc y Windows x64; no requiere la aplicación de escritorio. Mantenga las dependencias opcionales de npm y consulte los [requisitos de Linux y las instrucciones de actualización](../standalone-runtime.md#install-from-npm). La URL contiene un token de autenticación; manténgala privada.

En Windows, reinstalar conserva los datos de investigación. Para una limpieza completa, consulte la [herramienta de restablecimiento](../../scripts/windows-reset/README.md), que elimina permanentemente los datos locales tras la confirmación.

### 2. Complete la configuración inicial

Siga el asistente: **Entorno → Ubicación de datos → Entorno de ejecución del agente → Proveedor de modelo → Entorno de ejecución de Notebook**.

Complete las comprobaciones obligatorias del entorno y del runtime del agente y pruebe la conexión al modelo. Python/R Notebook es opcional; Notebook y la ubicación de datos pueden ajustarse más adelante en Configuración.

En los ajustes del sistema encontrará las opciones de apariencia y notificaciones. La sección **General** incluye la guía de instalación y actualización manuales.

La antigua pestaña Modelo ahora se llama **Capacidades locales** e incluye extracción de PDF, paquetes de idioma OCR y narración de investigaciones. La narración requiere un modelo de voz instalado localmente.

<table>
<tr>
<td width="50%"> <img src="../images/readme/onboarding-environment.jpg" alt="Comprobaciones automáticas del entorno durante el primer inicio de AIPOCH Open-Science"> </td>
<td width="50%"> <img src="../images/readme/onboarding-model-provider.jpg" alt="Configuración del proveedor de modelos durante el primer inicio de AIPOCH Open-Science"> </td>
</tr>
<tr>
<td align="center"> <sub> Comprobaciones de red, almacenamiento y compatibilidad del host </sub> </td>
<td align="center"> <sub> Proveedor, clave API, endpoint y validación de modelo </sub> </td>
</tr>
</table>

### 3. Iniciar un proyecto de investigación

1. Haga clic en **Nuevo proyecto**, abra una sesión y describa el objetivo de investigación, las entradas y los resultados esperados.
2. Adjunte archivos, elija un modelo y un modo de aprobación y envíe la tarea. Use `@` para referenciar archivos del proyecto o `/` para elegir una habilidad.
3. Revise la actividad de las herramientas y las solicitudes de aprobación, previsualice los resultados y consulte la evidencia disponible en **Procedencia**.

> Las capturas de pantalla de este archivo README ilustran el flujo de trabajo. Las etiquetas, catálogos y otros detalles de la interfaz pueden diferir de la versión que instale.

<a id="capacidades-principales"></a>

## ¿Qué puede hacer con AIPOCH Open-Science?

| Tarea                       | Cómo se realiza                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revisar la bibliografía     | Importe referencias de Zotero, filtre artículos con sus criterios y consulte el PDF original para comprobar un hallazgo.                                           |
| Analizar datos              | Ejecute Python o R en un Notebook y examine las tablas y figuras junto a sus archivos de origen.                                                                   |
| Rastrear un resultado       | Consulte las entradas, el código y el historial de una versión en la vista de procedencia. Repita la ejecución si dispone de la receta, las entradas y el entorno. |
| Entregar un resultado       | Comparta un [paquete `.science`](#share-your-research) para que otras personas examinen los pasos y las versiones de archivos usados.                              |
| Ampliar un flujo de trabajo | Active conectores de datos científicos, elija habilidades integradas o instale más habilidades y especialistas desde sus catálogos.                                |
| Elegir un modelo            | Conecte un proveedor compatible, una pasarela propia o una suscripción compatible de Claude o Codex. Los protocolos disponibles dependen del motor del agente.     |

<a id="rendimiento-en-benchmarks"></a>

## Resultados de benchmarks

AIPOCH evaluó AIPOCH Open-Science en tareas que abarcan encontrar un artículo, responder preguntas sobre su contenido y ejecutar un plan de investigación. Los resultados siguientes proceden de ejecuciones propias de AIPOCH. Cada puntuación corresponde a una tarea y una configuración de evaluación concretas. La evaluación también abarca la reproducción de resultados computacionales y la formulación de hipótesis a partir de datos.

| Tarea                                | Benchmark              | Resultado de AIPOCH Open-Science                                                                                                                                                                           |
| ------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encontrar el artículo objetivo       | LitQA2-FullText-Search | En **68 de las 75 preguntas de prueba**, el artículo objetivo apareció entre los primeros 30 resultados de LitQA2-FullText-Search (**90.67% Recall@30**, gpt-6-astra).                                     |
| Responder a partir de la literatura  | LitQA2-FullText        | En una ejecución independiente de LitQA2-FullText, Open-Science respondió correctamente **70 de 75 preguntas** (**93.33% de exactitud**, deepseek-flash con razonamiento Max).                             |
| Elaborar una síntesis con citas      | ScholarQA-CS2          | En 100 preguntas de validación de ScholarQA-CS2, Open-Science obtuvo una **puntuación compuesta de calidad de 0.9289/1** con deepseek-v4-flash. Las referencias de la prueba oficial usan otras preguntas. |
| Ejecutar flujos de investigación     | ASI-Bench              | En ejecuciones locales de ASI-Bench con el mismo modelo, Open-Science obtuvo **59.46** en B4 y Codex **55.45**. En B2 las puntuaciones fueron casi idénticas (**56.11** y **56.09**).                      |
| Ejecutar tareas científicas          | TB-Science 0.1         | En 70 tareas, **145 de 210** ejecuciones locales superadas (**69.05%**) con GPT-6 Astra/max. No es una posición oficial; no hay registros individuales públicos.                                           |
| Analizar datos biomédicos            | BiomniBench-DA         | En BiomniBench-DA Public 50, dos modelos jueces puntuaron los resultados con **81.04** y **77.06**. Su media con igual ponderación fue **79.05**.                                                          |
| Reproducir resultados publicados     | CORE-Bench-Hard        | CORE-Bench-Hard — 36 de 37 tareas de prueba correctas (97,30 %) en la evaluación local. El recuento incluye repeticiones.                                                                                  |
| Formular hipótesis a partir de datos | DiscoveryBench         | DiscoveryBench — En un subconjunto de 25 tareas de validación, la puntuación media del modelo evaluador local fue de 0,7467/1.                                                                             |

<details>
<summary>Alcance de la evaluación e informes</summary>

**Alcance de la evaluación:** estos informes cubren ejecuciones locales o internas de agosto a noviembre de 2026 con los modelos y particiones indicados; no se repitieron para la versión actual. Las referencias son instantáneas históricas, no clasificaciones en tiempo real. Las puntuaciones de distintas familias de benchmarks no son directamente comparables y las diferencias numéricas no establecen significación estadística.

Consulte el [informe de AstaBench y ASI-Bench](https://aipoch.com/benchmark/open-science) y el [informe de BiomniBench-DA](https://aipoch.com/blog/open-science-biomnibench-da) para conocer los detalles. Véase también el [resultado local de TB-Science 0.1](https://aipoch.com/blog/aipoch-open-science-terminal-bench-science-local-result).

[CORE-Bench-Hard · Informe de reproducibilidad](https://aipoch.com/blog/aipoch-open-science-core-bench-hard)

</details>

## Datos, permisos y confianza

AIPOCH Open-Science almacena en el equipo local los datos del proyecto, la configuración, las versiones de los artefactos y la evidencia de procedencia. Las claves API se guardan localmente y utilizan el almacén seguro de credenciales del sistema operativo cuando está disponible. Los registros también son locales y no se cargan automáticamente.

El flujo de datos externos aún es posible y debe revisarse:

- Las solicitudes al modelo envían el prompt y el contexto necesarios al proveedor del modelo seleccionado.
- Las búsquedas web y los conectores remotos envían sus parámetros mostrados a servicios externos.
- Los conectores locales pueden ejecutar comandos de confianza en el equipo.
- La aplicación también puede contactar con servidores de actualización, catálogos del mercado y servicios de descarga de entornos o modelos.
- Los archivos adjuntos, las referencias `@`, los registros y los informes generados pueden contener datos de investigación confidenciales.

Elija el perfil de permiso más limitado que se ajuste a la tarea:

| Modo                                  | Comportamiento                                                                                                                                                               | Uso recomendado                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Solicitar aprobación**              | Solicita aprobación para las acciones no cubiertas por permisos acotados existentes o políticas de herramientas de confianza de la aplicación                                | Flujos de trabajo nuevos, datos confidenciales y scripts desconocidos        |
| **Aprobar ediciones automáticamente** | Usa la revisión automática nativa del backend cuando existe; en caso contrario, solo autoriza automáticamente operaciones claramente de bajo riesgo en el espacio de trabajo | Edición de archivos de confianza con acceso externo controlado               |
| **Acceso completo**                   | Permite automáticamente las ediciones, los comandos, el acceso a la red y los conectores                                                                                     | Trabajo desatendido, de plena confianza y con un alcance claramente definido |

El perfil efectivo depende del backend y de los permisos existentes. También se aplican las políticas de conectores, herramientas y red de cálculo; compruebe el modo efectivo que muestra la aplicación.

Revise los parámetros del conector y la actividad de la herramienta antes de aprobarlos. Nunca incluya claves API, tokens de acceso, identificadores de pacientes, datos no publicados o rutas locales confidenciales en capturas de pantalla o registros de problemas públicos.

## Guías para desarrolladores

- **Desarrollo** · [Compilar y empaquetar desde el código fuente](../development-quick-reference.md) · [Contribuir](../../CONTRIBUTING.md)
- **Ejecutar Open-Science** · [Entorno independiente](../standalone-runtime.md) · [Ciclo de vida del servicio](../../packages/open-science/CLI.md#service-lifecycle) · [Vincular un dispositivo móvil](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **Automatización** · [CLI](../../packages/open-science/CLI.md) · [Node.js SDK](../../packages/open-science/README.md) · [Conectar un cliente MCP](../../packages/open-science/CLI.md#external-agents-through-mcp)

## Preguntas frecuentes

<a id="por-qué-falla-la-prueba-de-conexión-del-modelo"></a>

<details>
<summary>¿Por qué falla la prueba de conexión del modelo?</summary>

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

</details>

<a id="por-qué-continuar-está-deshabilitado-durante-la-instalación"></a>

<details>
<summary>¿Por qué **Continuar** está deshabilitado durante la instalación?</summary>

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

</details>

<a id="cómo-ejecuto-trabajos-en-un-clúster-hpc-remoto"></a>

<details>
<summary>¿Cómo ejecuto trabajos en un clúster HPC remoto?</summary>

R: **Computación remota (SSH)** permanece siempre habilitada y no necesita activarse en Configuración. Registre un host de cálculo SSH en **Configuración → Conexiones → Cálculo**, hágalo disponible para la sesión actual y utilice lenguaje natural o `/remote-compute-ssh`. Se necesita un host SSH accesible, autenticación válida, permisos sobre los directorios necesarios y el software, las dependencias y los recursos de cálculo que requiera la tarea. Direct SSH no requiere planificador; el modo Slurm exige un entorno Slurm operativo y permiso para enviar trabajos. “Siempre habilitada” se refiere a la habilidad, no a la disponibilidad permanente de cada host registrado.

También puede usar Kubernetes, Hugging Face Jobs, Modal y Ray en destinos conectados por usted. Antes de cada envío externo, apruebe el destino, el comando, los recursos y las salidas. Los registros de recuperación permiten retomar la recogida de resultados tras un reinicio; los resultados publicados se abren en Compute Preview. Debe proporcionar las cuentas, el software, los recursos y los permisos; los trabajos en la nube pueden generar cargos.

</details>

<a id="existe-una-interfaz-de-línea-de-comandos"></a>

<details>
<summary>¿Existe una interfaz de línea de comandos?</summary>

R: Sí. Instale la CLI independiente o use **Configuración → General → Herramienta de línea de comandos → Instalar comando** para controlar una instancia de escritorio que ya esté en ejecución. La instalación mediante npm requiere Node.js; Homebrew y los paquetes independientes con entorno de ejecución incluido ya lo incorporan. Inicialice el perfil local y, a continuación, controle el servicio y envíe tareas de investigación sin abrir un navegador:

```bash
# Inicie el servicio en segundo plano
open-science init
open-science start --no-open

# Cree un proyecto y ejecute una tarea usando su nombre exacto
open-science project create "Revisión sistemática"
open-science run --project "Revisión sistemática" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Descargue un artefacto generado
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Consulte la [guía CLI](../../packages/open-science/CLI.md) para obtener la referencia completa de comandos, formatos de salida JSON/JSONL, códigos de salida y opciones de servicio sin interfaz gráfica.

</details>

<a id="cómo-inspecciono-de-dónde-provino-un-resultado-generado"></a>

<details>
<summary>¿Cómo inspecciono de dónde provino un resultado generado?</summary>

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

</details>

<a id="puedo-revisar-una-solicitud-anterior-sin-perder-la-conversación-que-siguió"></a>

<details>
<summary>¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?</summary>

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

</details>

## Colaboradores

Gracias a todas las personas que contribuyen a AIPOCH Open-Science con código, documentación, traducciones, informes de errores y ayuda a la comunidad.

[Ver colaboradores en GitHub](https://github.com/aipoch/open-science/graphs/contributors)

[![Colaboradores de AIPOCH Open-Science](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Participe

Ayude a mejorar AIPOCH Open-Science: informe de un error, sugiera una función, haga una pregunta o contribuya. Elija un canal a continuación para empezar.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> Si AIPOCH Open-Science le resulta útil, dé una estrella al repositorio en GitHub.

Las capacidades entregadas, parciales y previstas aparecen en el [mapa de capacidades](../ROADMAP.md#capability-map).

<a id="aipoch-open-science-artículo-y-cita"></a>

## Cómo citar

Si utilizas AIPOCH Open-Science en tu investigación, cita la [prepublicación de AIPOCH Open-Science](https://arxiv.org/abs/2610.17110).

<details>
<summary>Cita BibTeX</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## Licencia

Licencia Apache 2.0: consulte [LICENSE](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas de AIPOCH Open-Science en GitHub" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
