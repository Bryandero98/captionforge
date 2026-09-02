// Tiny, dependency-free i18n: a flat dictionary per language plus a
// {placeholder} substitution helper. Kept separate from app.js so the
// dictionary can grow without cluttering the app logic, and so
// data-i18n-tagged markup can be translated with one shared call.
window.CaptionForgeI18n = (() => {
  const STORAGE_KEY = "captionforge_lang";

  const DICT = {
    es: {
      tagline: "Subtítulos automáticos, 100% locales. Sin suscripción, sin límite, sin nube.",
      dropZoneLabel: "Arrastra un video aquí, o haz clic para elegir uno",
      modelLabel: "Modelo",
      modelBase: "base (más rápido)",
      modelSmall: "small (equilibrado)",
      modelMedium: "medium (más preciso)",
      languageLabel: "Idioma de origen",
      translateLabel: "Traducir a",
      translatePlaceholder: "ninguno (p. ej. en, es)",
      uploadButton: "Generar subtítulos",
      selectedFile: "Archivo: {name}",
      stageQueued: "En cola",
      stageExtracting: "Extrayendo audio",
      stageTranscribing: "Transcribiendo ({percent}%)",
      stageReady: "Listo",
      stageBurning: "Quemando subtítulos",
      resultsHeading: "Listo",
      downloadSrt: "Descargar .srt",
      downloadVtt: "Descargar .vtt",
      downloadAss: "Descargar .ass",
      burnButton: "Quemar en el video",
      downloadVideo: "Descargar video con subtítulos",
      restartButton: "Procesar otro video",
      connectionError: "No se pudo conectar con el servidor.",
      uploadErrorFallback: "Error {status} al subir el video.",
      burnErrorFallback: "Error {status} al quemar los subtítulos.",
      genericJobError: "Ocurrió un error inesperado.",
      editToggleButton: "Editar subtítulos",
      editHint: "Corrige el texto si algo salió mal. Los tiempos no cambian.",
      editSaveButton: "Guardar cambios",
      editSavedLabel: "Guardado",
      editErrorFallback: "Error {status} al guardar los cambios.",
      editLoadErrorFallback: "No se pudieron cargar los subtítulos para editar.",
      subtitleStyleLabel: "Estilo de subtítulo",
      styleModern: "Moderno",
      styleTiktok: "TikTok bold",
      styleYoutube: "Clásico YouTube",
      styleMinimal: "Minimalista",
      karaokeLabel: "Resaltar palabra por palabra (karaoke)",
      historyHeading: "Trabajos recientes",
      historyEmpty: "Todavía no hay trabajos en este navegador.",
      historySrt: ".srt",
      historyVtt: ".vtt",
      historyAss: ".ass",
      historyVideo: "video",
      historyClear: "Borrar historial",
    },
    en: {
      tagline: "Automatic captions, 100% local. No subscription, no limit, no cloud.",
      dropZoneLabel: "Drag a video here, or click to choose one",
      modelLabel: "Model",
      modelBase: "base (fastest)",
      modelSmall: "small (balanced)",
      modelMedium: "medium (most accurate)",
      languageLabel: "Source language",
      translateLabel: "Translate to",
      translatePlaceholder: "none (e.g. en, es)",
      uploadButton: "Generate captions",
      selectedFile: "File: {name}",
      stageQueued: "Queued",
      stageExtracting: "Extracting audio",
      stageTranscribing: "Transcribing ({percent}%)",
      stageReady: "Ready",
      stageBurning: "Burning subtitles",
      resultsHeading: "Done",
      downloadSrt: "Download .srt",
      downloadVtt: "Download .vtt",
      downloadAss: "Download .ass",
      burnButton: "Burn into video",
      downloadVideo: "Download video with captions",
      restartButton: "Process another video",
      connectionError: "Could not connect to the server.",
      uploadErrorFallback: "Error {status} uploading the video.",
      burnErrorFallback: "Error {status} burning the subtitles.",
      genericJobError: "An unexpected error occurred.",
      editToggleButton: "Edit captions",
      editHint: "Fix the text if something came out wrong. Timing doesn't change.",
      editSaveButton: "Save changes",
      editSavedLabel: "Saved",
      editErrorFallback: "Error {status} saving your changes.",
      editLoadErrorFallback: "Couldn't load the captions to edit.",
      subtitleStyleLabel: "Caption style",
      styleModern: "Modern",
      styleTiktok: "TikTok bold",
      styleYoutube: "YouTube classic",
      styleMinimal: "Minimal",
      karaokeLabel: "Highlight word by word (karaoke)",
      historyHeading: "Recent jobs",
      historyEmpty: "No jobs in this browser yet.",
      historySrt: ".srt",
      historyVtt: ".vtt",
      historyAss: ".ass",
      historyVideo: "video",
      historyClear: "Clear history",
    },
  };

  function detectInitialLang() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "es" || stored === "en") return stored;
    } catch {
      // localStorage can throw in private-browsing/locked-down contexts -
      // falling through to the navigator-based guess is the right recovery.
    }
    return navigator.language && navigator.language.toLowerCase().startsWith("en") ? "en" : "es";
  }

  let currentLang = detectInitialLang();

  function t(key, params) {
    const template = (DICT[currentLang] && DICT[currentLang][key]) ?? DICT.es[key] ?? key;
    if (!params) return template;
    return Object.keys(params).reduce(
      (str, name) => str.replaceAll(`{${name}}`, String(params[name])),
      template
    );
  }

  function applyToDom(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.documentElement.lang = currentLang;
  }

  function setLang(lang) {
    if (lang !== "es" && lang !== "en") return;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Non-fatal: the choice just won't survive a reload this session.
    }
    applyToDom();
  }

  function getLang() {
    return currentLang;
  }

  return { t, applyToDom, setLang, getLang };
})();
