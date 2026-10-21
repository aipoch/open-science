<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Entorno de investigación con IA para una ciencia reproducible — de código abierto, centrado en la ejecución local e independiente del modelo.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Descargar" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Versión" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Preprint de AIPOCH Open-Science en arXiv: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#rendimiento-en-benchmarks">
    <img alt="AIPOCH Open-Science — puntuaciones más altas en las comparaciones de benchmarks presentadas" src="../../docs/images/readme/benchmark-comparisons.svg">
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

AIPOCH Open-Science es un entorno de investigación con IA para científicos e investigadores, desarrollado por [AIPOCH](https://aipoch.com/open-science) con un enfoque de código abierto, centrado en la ejecución local e independiente del modelo. Permite realizar investigaciones reproducibles e inspeccionables con agentes científicos de IA, ejecutar Python y R, conectarse a fuentes de datos científicos y trabajar en macOS, Windows y Linux. Cree un proyecto, describa su objetivo de investigación en lenguaje natural y permita que los agentes lean archivos, busquen en la web, ejecuten código, consulten fuentes de datos científicos y produzcan informes, tablas y figuras con procedencia rastreable, todo en un mismo espacio de trabajo.

AIPOCH Open-Science respalda la investigación computacional y con uso intensivo de datos en todas las disciplinas, incluidos el aprendizaje automático, la estadística, las ciencias biológicas, la química, la ciencia de los materiales, la física y las ciencias ambientales. Acompaña todo el proceso de investigación, desde la revisión bibliográfica y el desarrollo de hipótesis hasta la ejecución de código, el análisis de datos, la simulación, la visualización y la producción de resultados rastreables.

Las sesiones de investigación terminadas también pueden exportarse como paquetes `.science` portátiles para revisión, traspaso y archivo, con ramas de conversación, versiones de archivos, registros de Notebook y evidencias de verificación seleccionados.

> 💡 **AIPOCH Open-Science v1.0.1** _(actualizado en octubre de 2026)_. Este parche añade la importación de paquetes `.science` con un solo clic desde el navegador, un actualizador integrado más claro y fiable (especialmente en Windows), el estado de espera de las sesiones siempre visible, correcciones de seguridad en el manejo de credenciales OAuth de MCP y una serie de correcciones para PDF, bibliografía y paquetes de sesiones. Consulte las [notas de la versión 1.0.1](../../release-notes/1.0.1/es.md) para más detalles. Las descargas siguen correspondiendo a la [última versión publicada](https://github.com/aipoch/open-science/releases/latest).

<p align="center">
 <img width="1920" height="1140" alt="Banner principal de AIPOCH Open-Science: Science, Open to All — un entorno de investigación de IA científica de código abierto, independiente del modelo y autohospedado" src="../images/readme/open-science-banner.png" />
</p>

## Tabla de contenido

- [Inicio rápido](#-inicio-rápido)
- [Recorrido por el producto](#recorrido-por-el-producto)
- [Paquetes de investigación `.science` de AIPOCH Open-Science](#paquetes-de-investigación-science-de-aipoch-open-science)
- [AIPOCH Open-Science: artículo y cita](#aipoch-open-science-artículo-y-cita)
- [Rendimiento en benchmarks](#rendimiento-en-benchmarks)
- [Capacidades principales](#capacidades-principales)
- [Proveedores de modelos](#proveedores-de-modelos)
- [Datos, permisos y confianza](#datos-permisos-y-confianza)
- [Desarrollo y empaquetado](#desarrollo-y-empaquetado)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Participe](#participe)
- [Licencia](#licencia)
- [Historial de estrellas](#historial-de-estrellas)

## 🚀 Inicio rápido

### 1. Descargue la aplicación

Abra la [página oficial de descargas](https://aipoch.com/open-science/download) y elija el instalador para su equipo:

| Su equipo                                 | Elija                                              |
| ----------------------------------------- | -------------------------------------------------- |
| macOS 12+: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64         |
| macOS 12+: Intel                          | El DMG de macOS para Intel/x64                     |
| Windows x64                               | El instalador de Windows x64 (con firma de código) |
| Linux x64                                 | El paquete AppImage o Debian de Linux x64          |
| Linux ARM64                               | AppImage o paquete Debian de Linux ARM64           |

Descargue desde la [página oficial de descargas](https://aipoch.com/open-science/download); consulte la [verificación de descargas](../../SECURITY.md#verifying-your-download) si es necesario.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

Para la CLI independiente en macOS o Linux, utilice el [tap de AIPOCH](https://github.com/aipoch/homebrew-tap) por separado:

```bash
brew install aipoch/tap/open-science
```

La fórmula incluye Node y no necesita la aplicación de escritorio en ejecución; su versión puede diferir del Cask de escritorio. Consulte los requisitos y las actualizaciones en la [guía del entorno independiente](../standalone-runtime.md).

En Windows, reinstalar conserva los datos de investigación. Para una limpieza completa, consulte la [herramienta de restablecimiento](../../scripts/windows-reset/README.md), que elimina permanentemente los datos locales tras la confirmación.

### 2. Complete la configuración inicial

Siga el asistente: **Entorno → Ubicación de datos → Entorno de ejecución del agente → Proveedor de modelo → Entorno de ejecución de Notebook**.

Complete las comprobaciones obligatorias del entorno y del runtime del agente y pruebe la conexión al modelo. Python/R Notebook es opcional; Notebook y la ubicación de datos pueden ajustarse más adelante en Configuración.

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

## Recorrido por el producto

### De la solicitud de investigación al resultado rastreable

Considere una tarea bioinformática representativa: reproducir un análisis publicado de expresión diferencial, comparar los resultados regenerados con el artículo y entregar el informe, las tablas y las figuras necesarias para la revisión. Las capturas siguientes son vistas representativas de flujos de trabajo documentados de AIPOCH Open-Science; ilustran cada etapa, pero no pertenecen a una única sesión continua.

#### 1. Definir la tarea de investigación y sus evidencias

Describa la pregunta de investigación, el artículo y los conjuntos de datos de origen, los métodos o umbrales necesarios, los resultados esperados y los criterios de aceptación. Cargue los archivos de apoyo o haga referencia a un artefacto existente del proyecto con `@`, para que el agente parta de entradas explícitas y no de un contexto oculto.

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="Tarea de reproducción de un artículo en AIPOCH Open-Science con la conclusión, los artefactos generados y la comparación de fuentes en un mismo espacio de trabajo" width="900">
</p>

#### 2. Ejecutar con herramientas científicas inspeccionables

El agente puede combinar en el Notebook compartido habilidades científicas, conectores de investigación sujetos a permisos, búsquedas, operaciones con archivos y código Python o R. Las figuras generadas se pueden revisar junto al resumen de la investigación, mientras que el registro del artefacto permite inspeccionar el código productor capturado y las evidencias de ejecución.

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="Análisis bioinformático en AIPOCH Open-Science que muestra juntos el resumen de la investigación, la figura generada y el código productor capturado" width="900">
</p>

#### 3. Revisar informes, tablas y figuras en contexto

La respuesta final resume qué se reprodujo, qué presentó diferencias y qué limitaciones son importantes. Los informes Markdown, las tablas CSV, las imágenes y otros artefactos de investigación generados permanecen asociados a la sesión y también se reúnen en la biblioteca de archivos del proyecto, donde se pueden previsualizar junto a la conversación y reutilizar en trabajos posteriores.

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="Resultado de reproducción en AIPOCH Open-Science con figuras de expresión diferencial y archivos generados junto a la explicación del agente" width="900">
</p>

#### 4. Rastrear cada artefacto hasta sus evidencias

Cada artefacto generado se almacena como una versión inmutable con suma de comprobación. La vista **Provenance** puede mostrar el código productor y el historial de ejecución, las entradas referenciadas, el inventario observado del entorno, la rama de conversación productora y los hallazgos del Reviewer específicos de la versión. Las evidencias que no se pudieron verificar se marcan como no disponibles en lugar de inferirse.

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="Vista previa de un artefacto de investigación de AIPOCH Open-Science con acceso a Provenance para rastrear un resultado generado" width="900">
</p>

## Paquetes de investigación `.science` de AIPOCH Open-Science

Exporte una sesión de investigación terminada como un paquete `.science` portátil para revisión, traspaso y archivo. Elija las ramas de conversación, versiones de archivos, registros de Notebook y evidencias de verificación que desea incluir, y luego importe el paquete en otro proyecto o equipo.

**Exportar → transferir → inspeccionar**

1. Exporte una sesión terminada y elija el contenido que desea incluir.
2. Transfiera el archivo `.science` a un colaborador o a otro equipo.
3. Importe el archivo en un proyecto. **Research replay**, a la derecha, muestra el proceso registrado; la conversación de la izquierda permite hacer preguntas y citar pasos fijos.

Los registros importados siguen siendo de solo lectura; ver la reproducción no ejecuta código, no llama a modelos ni restaura credenciales. La primera pregunta crea una conversación editable asociada; utilice **Create a copy to continue research** para crear una copia de trabajo. Volver a ejecutar un resultado sigue requiriendo una receta completa, los datos necesarios y un entorno disponible.

Se excluyen las conversaciones Side Chat, los marcadores privados de lectura y las credenciales; los archivos incluidos dependen de la selección de exportación. Los registros de verificación recibidos describen las comprobaciones del remitente, no una nueva ejecución en este equipo. Consulte la [guía de paquetes `.science`](https://aipoch.com/docs/guides/research-packages/).

## AIPOCH Open-Science: artículo y cita

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

Preprint de arXiv · [v1](https://arxiv.org/abs/2610.17110v1) · Enviado el 12 de octubre de 2026.

Nuestro preprint presenta AIPOCH Open-Science, un entorno de investigación con IA de código abierto que utiliza paquetes `.science` portátiles para compartir el contexto de investigación, las versiones de artefactos y los registros de verificación. Consulte el artículo para conocer el diseño de intercambio de paquetes y la evaluación controlada.

Si utiliza AIPOCH Open-Science en su investigación, puede citar el preprint:

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

## Rendimiento en benchmarks

Son resultados históricos de informes de agosto a octubre de 2026, no una evaluación nueva de v1.0.0.

Informes fuente: [29 de septiembre](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), [12 de octubre](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh) (puede requerirse permiso de acceso).

### 🏆 AstaBench LitQA2-FullText-Search — 10/10 artículos objetivo encontrados

AIPOCH Open-Science logró **100% recall@30** en las diez consultas del conjunto oficial de validación con **DeepSeek v4-flash (max)**, especialistas en búsqueda bibliográfica y habilidades. Todos los artículos objetivo aparecieron entre los primeros 30 resultados. La puntuación supera los tres resultados públicos de validación incluidos en el informe, con **20 puntos porcentuales** sobre la referencia más alta de **80%**. Se informaron tres repeticiones locales, que muestran la localización de artículos para este conjunto de preguntas científicas.

![AIPOCH Open-Science obtiene 100% recall@30 y 10/10 aciertos en la validación de AstaBench LitQA2; prueba y validación usan preguntas distintas](../images/readme/astabench-litqa2.png)

La figura incluye registros de prueba y validación; el orden es exclusivamente numérico. Recall@30 mide la recuperación del artículo objetivo, no la exactitud de las respuestas científicas.

### 🏆 ASI-Bench B1–B4 — Puntuaciones más altas en las cuatro comparaciones incluidas

AIPOCH Open-Science obtuvo **79.35, 56.11, 59.67 y 59.46** en ASI-Bench B1, B2, B3 y B4 con **GPT-6 (gpt-6-astra / xhigh)**, especialistas de dominio y habilidades: los valores mostrados más altos en las respectivas comparaciones recogidas en los informes. Las cuatro condiciones evalúan **ejecutar un plan completo, organizar un flujo de trabajo, seleccionar métodos de investigación de forma autónoma y realizar investigación autónoma con información distractora**.

Las referencias locales de Codex con el mismo modelo e intensidad de razonamiento indicada obtuvieron 74.78, 56.09, 58.12 y 55.45, con diferencias numéricas de **+4.57, +0.02, +1.55 y +4.01 puntos**, respectivamente. Se informaron tres repeticiones locales para B1/B2; B3/B4 son medias de tres ejecuciones locales de 60 tareas cada una.

![AIPOCH Open-Science obtiene 79.35, 56.11, 59.67 y 59.46 en ASI-Bench B1–B4; se distinguen resultados locales y referencias públicas](../images/readme/asi-bench-b1-b4.jpg)

Las ejecuciones locales usaron seed31415. La puntuación B1 de AIPOCH abarca 59 tareas; una se excluyó por el problema del evaluador descrito en el informe. B3/B4 usaron v0.32.0 y un juez sustituto. Las referencias públicas difieren en instancias, configuración y evaluación; la ventaja de 0.02 puntos en B2 es solo numérica.

### 🏆 Mayor puntuación en la comparación recopilada de BiomniBench-DA Public 50 — 79.05

AIPOCH Open-Science logró **79.05** con **gpt-5.6-sol (xhigh)** en una evaluación interna de las 50 tareas denominadas BiomniBench-DA Public 50, el valor mostrado más alto de la comparación recopilada. Es la media con igual ponderación de **81.04** del juez Gemini 3.1 Pro y **77.06** del juez DeepSeek v4-pro, que refleja el análisis de datos biomédicos de esta configuración. Consulte el [informe de evaluación](https://aipoch.com/blog/open-science-biomnibench-da).

![AIPOCH Open-Science registra una media interna de 79.05 en BiomniBench-DA Public 50, con puntuaciones de jueces de 77.06 y 81.04](../images/readme/biomnibench-public50-leaderboard.png)

La comparación mezcla registros con distinta cobertura de jueces y no constituye una clasificación oficial bajo condiciones uniformes de evaluación.

**Alcance de la evaluación:** Son resultados locales/internos comunicados por el propio equipo. Encabezar las comparaciones incluidas no acredita un primer puesto oficial ni mejoras estadísticamente significativas.

## Capacidades principales

AIPOCH Open-Science combina gestión de proyectos, ejecución de agentes multimodelo, Notebooks de Python y R, conectores de datos científicos, versiones inmutables de artefactos con procedencia y control humano autorizado en un espacio de trabajo local. La aplicación instalada y las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) son la fuente de referencia para los catálogos actuales, los detalles de empaquetado y las opciones recién incorporadas.

| Área                                                | Capacidad central                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Habilidades científicas**                         | Amplíe la investigación con **23 habilidades integradas** y **525 habilidades** del [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), con instalación y actualizaciones en un clic. Cree habilidades mediante conversación o trabajo completado e importe paquetes o fuentes de GitHub. Las aportaciones se publican tras revisión; una importación local no las publica.                                                                                                                                                              |
| **Conectores**                                      | Acceda a recursos científicos con **36 conectores integrados** o añada conectores MCP locales y remotos personalizados. Gestione permisos por herramienta e importe o exporte configuraciones.                                                                                                                                                                                                                                                                                                                                                                      |
| **Especialistas y delegación**                      | Instale **10 especialistas** del [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) o cree especialistas personales para recibir tareas del agente principal. Los paquetes admiten importación y exportación; las aportaciones se revisan antes de publicarse y las importaciones locales no las publican.                                                                                                                                                                                                                      |
| **Modelos y backends de agentes**                   | Use modelos en la nube, pasarelas compatibles o inicios de sesión de suscripciones Claude y Codex. Elija Claude Code, OpenCode, Codex o CodeBuddy como backend, con pruebas de conexión, entrada de imágenes y ajustes de razonamiento.                                                                                                                                                                                                                                                                                                                             |
| **Proyectos, sesiones y paquetes de investigación** | Organice proyectos con sesiones fijadas, ramas de mensajes, conversaciones laterales e historial recuperable. Traslade un **paquete de investigación `.science` portátil** a otro proyecto o equipo con ramas de conversación, versiones de archivos seleccionadas, registros de Notebook y evidencia de verificación. Las importaciones son de solo lectura, sin ejecutar código ni restaurar credenciales; se excluyen conversaciones laterales y marcadores, y los archivos dependen de la selección de exportación.                                             |
| **Agente revisor**                                  | Active la revisión automática opcional para comprobar, en un contexto separado, las respuestas, registros de ejecución y evidencias de archivos relacionados con un turno completado del agente. Obtenga comprobaciones fundamentadas con resultados de aprobación, advertencia o fallo, con un número limitado de ciclos de corrección por el agente principal y nueva revisión cuando se detecten problemas. Se conservan los registros de revisión y el estado de resolución de los problemas; la revisión se limita a los registros disponibles para ese turno. |
| **Python, R, Notebooks y HPC**                      | Ejecute Python, R, Notebook y shell localmente con entornos gestionados o intérpretes propios, con ejecución en segundo plano e historial. SSH y Slurm requieren el host, software, recursos y permisos descritos en la FAQ de cálculo remoto.                                                                                                                                                                                                                                                                                                                      |
| **Biblioteca de referencias**                       | Importe y gestione referencias y PDF con colecciones, etiquetas, vínculos a proyectos, notas y fusión de duplicados. Busque textos completos de acceso abierto, lea PDF, extraiga figuras y tablas y utilice fuentes de la biblioteca en las conversaciones para el análisis asistido por IA. Genere bibliografías con el estilo de cita elegido y exporte referencias en BibTeX o RIS.                                                                                                                                                                             |
| **Archivos científicos y vistas previas**           | Suba archivos de hasta **10 GiB cada uno**, organice los archivos del proyecto y previsualice datos científicos, PDF, documentos Office, imágenes, código y estructuras moleculares. El límite de subida no garantiza que un modelo lea todo el archivo: contexto, análisis de adjuntos y vistas previas tienen límites propios. Los archivos grandes suelen necesitar lectura o análisis por bloques mediante código.                                                                                                                                              |
| **Artefactos y procedencia**                        | Conserve versiones inmutables de resultados con código generador, entradas, historial de ejecución, entorno y evidencia de revisión disponibles. En el escritorio, reproduzca versiones aptas con una receta completa, las entradas necesarias y un entorno utilizable, compare salidas y exporte registros de verificación. La falta de evidencia puede impedir la verificación, y reproducir resultados no demuestra validez científica.                                                                                                                          |

Dispone de anotaciones PDF persistentes y notas de documentos. Con un modelo de cribado configurado, las colecciones inteligentes evalúan referencias según sus criterios de inclusión y exclusión. Las decisiones de IA y las manuales se registran por separado para apoyar la revisión humana.

En la aplicación de escritorio también puede exportar la procedencia de artefactos como RO-Crate 1.1. Un paquete de entorno ligado a una versión solo puede crear un entorno gestionado si la captura está completa y es compatible con la plataforma de destino; no es una copia de seguridad completa del equipo.

## Proveedores de modelos

AIPOCH Open-Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Están disponibles las siguientes opciones de conexión:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                                                                                                                 |
| **Puerta de enlace personalizada** | Indique la URL base, el ID exacto del modelo y un protocolo API compatible con el backend elegido (Messages, Chat Completions o Responses), y pruebe la conexión. Las pasarelas remotas requieren HTTPS y clave API. Las direcciones de loopback como `localhost`, `127.0.0.1` o `[::1]` permiten HTTP sin clave; hay ajustes predefinidos para Ollama, LM Studio, llama.cpp y vLLM. El formato API predeterminado no garantiza la compatibilidad del servidor o del modelo. |
| **Suscripción de Codex**           | Seleccione el framework de agentes Codex y luego elija Suscripción de Codex como tipo de proveedor.                                                                                                                                                                                                                                                                                                                                                                          |
| **Suscripción de Claude**          | Inicie sesión con una suscripción de Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en el perfil predeterminado `~/.claude`) o **aislado** (un flujo `claude setup-token` gestionado por la aplicación bajo un `CLAUDE_CONFIG_DIR` propio y completamente aislado de `~/.claude/`, con la opción alternativa de pegar un token).                                                                                     |
| **xAI (Grok) OAuth**               | Utilice el inicio de sesión de dispositivo integrado de xAI (Grok) OAuth. El acceso depende de la cuenta de xAI y de los protocolos del backend elegido; valide la conexión en la aplicación.                                                                                                                                                                                                                                                                                |

Hay 25 opciones de proveedor preconfiguradas, incluidos OpenAI, Anthropic, DeepSeek, NVIDIA Build y otros. Los modelos y puntos de acceso regionales dependen de la versión instalada y del backend elegido; consulte el selector y la prueba de conexión de la aplicación.

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

## Desarrollo y empaquetado

AIPOCH Open-Science consta de un backend Node convencional y un cliente de escritorio Electron, con React, TypeScript, Prisma/SQLite y un entorno de agentes basado en ACP.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 24 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- La ejecución de Notebook es opcional y usa entornos Python/R gestionados por la aplicación o un intérprete compatible que usted configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

Consulte la [referencia de comandos de desarrollo y empaquetado](development-quick-reference.md) y la [guía de contribución](../../CONTRIBUTING.md) para los comandos de compilación y el flujo de desarrollo.

### Modos web y sin interfaz gráfica en localhost

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico.

```bash
npm run dev:web
npm run pack:backend
```

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico. `npm run dev:web` y `npm run dev:headless` compilan e inician el backend y la interfaz web; no inician el escritorio ni la bandeja. `OPEN_SCIENCE_WEB_PORT` selecciona el puerto (predeterminado `44100`); Ctrl+C cierra el servicio en primer plano de forma ordenada.

El desarrollo desde el código fuente requiere Node.js 24. El tarball npm independiente requiere Node >=22.13.0; el CLI/SDK ligero requiere Node >=22.5. Los archivos de Release, la fórmula Homebrew y el lanzador del escritorio incluyen su propio entorno de ejecución.

El escritorio y el navegador comparten el servicio. Al salir, el escritorio detiene solo el backend que inició; si se conectó a un servicio del CLI, únicamente se desconecta.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### Acceso remoto móvil

Se puede acceder a la misma interfaz web de localhost desde un teléfono o una tableta mediante el emparejamiento de Remote.It. Empareje un navegador con un código de AIPOCH Open-Science de seis dígitos, apruébelo una vez en el escritorio y el espacio de trabajo permanecerá accesible sin exponer directamente el servidor de loopback. Puede revocar la confianza del navegador; además, los cambios de modo o el cierre del servicio invalidan de inmediato las sesiones remotas activas.

El equipo anfitrión debe permanecer encendido y conectado, con AIPOCH Open-Science y el agente Remote.It en ejecución, y debe estar añadido a una cuenta de Remote.It con sesión iniciada. La autorización del navegador caduca y puede revocarse; consulte la [guía de control remoto](../remote-control.md).

### CLI y SDK sin interfaz gráfica

La CLI sin interfaz gráfica y el SDK de Node.js sin dependencias utilizan el mismo daemon local, así como los mismos proyectos, sesiones, credenciales y permisos que las interfaces web y de escritorio. La documentación detallada se incluye en el paquete publicado y sirve como referencia única de los comandos:

- [Guía CLI](../../packages/open-science/CLI.md): instalación, ciclo de vida del servicio, automatización de tareas, artefactos, formatos de salida y códigos de salida
- [Descripción general del paquete SDK](../../packages/open-science/README.md) - Inicio rápido de Node.js y punto de entrada del paquete

## Preguntas frecuentes

### ¿Por qué falla la prueba de conexión del modelo?

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

### ¿Por qué **Continuar** está deshabilitado durante la instalación?

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

### ¿Cómo ejecuto trabajos en un clúster HPC remoto?

R: **Computación remota (SSH)** permanece siempre habilitada y no necesita activarse en Configuración. Registre un host de cálculo SSH en **Configuración → Cálculo**, hágalo disponible para la sesión actual y utilice lenguaje natural o `/remote-compute-ssh`. Se necesita un host SSH accesible, autenticación válida, permisos sobre los directorios necesarios y el software, las dependencias y los recursos de cálculo que requiera la tarea. Direct SSH no requiere planificador; el modo Slurm exige un entorno Slurm operativo y permiso para enviar trabajos. “Siempre habilitada” se refiere a la habilidad, no a la disponibilidad permanente de cada host registrado.

### ¿Existe una interfaz de línea de comandos?

R: Sí. Instale el paquete Node independiente para iniciar un backend autónomo. El comando instalado desde **Configuración → General → Herramienta de línea de comandos → Instalar comando** controla una instancia de escritorio que ya esté en ejecución; para ello no necesita instalar Node.js por separado. Excepción: el lanzador incluido en el paquete Debian inicia el backend incluido con su runtime Node. Para el siguiente ejemplo autónomo, instale el paquete independiente y Node.js, inicialice el perfil local e inicie el servicio:

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

### ¿Cómo inspecciono de dónde provino un resultado generado?

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

### ¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

## Participe

AIPOCH Open-Science agradece informes de errores, propuestas de funciones, debates sobre diseño, preguntas de la comunidad y contribuciones a través de GitHub, Discord, X y el sitio web de AIPOCH. Elija el canal que mejor se adapte a su objetivo, luego siga la guía de contribución vinculada y el recordatorio de seguridad de publicación pública antes de compartir los detalles del proyecto.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> **Dar Star al repositorio:** Si este proyecto le ha resultado útil, agradeceríamos que le diera Star en GitHub. Ayuda a sostener el desarrollo y solo lleva un segundo.

Las capacidades entregadas, parciales y previstas aparecen en el [mapa de capacidades](../ROADMAP.md#capability-map).

## Licencia

Licencia Apache 2.0: consulte [LICENSE](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
