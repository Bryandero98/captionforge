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
      connectionLostError: "Se perdió la conexión con el servidor. Verifica que siga corriendo y recarga la página.",
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
      onboardingLangTitle: "Elige tu idioma",
      onboardingLangBody: "Puedes cambiarlo cuando quieras con los botones ES / EN de arriba.",
      onboardingUploadTitle: "Sube tu video",
      onboardingUploadBody: "Arrástralo a la zona de subida, o haz clic para elegirlo. Aceptamos .mp4, .mov, .mkv, .webm y .avi - todo se procesa en tu propia máquina, nada sale de ella.",
      onboardingEditTitle: "Edita y personaliza",
      onboardingEditBody: "Corrige el texto si algo salió mal, elige entre 4 estilos de subtítulo, y activa el resaltado karaoke palabra por palabra si quieres.",
      onboardingDownloadTitle: "Descarga o quema los subtítulos",
      onboardingDownloadBody: "Descarga el .srt, .vtt o .ass directamente, o quema los subtítulos en el video con un clic. Tus últimos 10 trabajos quedan en \"Trabajos recientes\" para volver a descargarlos.",
      onboardingBack: "Atrás",
      onboardingNext: "Siguiente",
      onboardingGetStarted: "Empezar",
      onboardingDontShow: "No volver a mostrar",
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
      connectionLostError: "Lost the connection to the server. Check that it's still running and reload the page.",
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
      onboardingLangTitle: "Choose your language",
      onboardingLangBody: "You can change it anytime with the ES / EN buttons up top.",
      onboardingUploadTitle: "Upload your video",
      onboardingUploadBody: "Drag it into the upload area, or click to choose one. We accept .mp4, .mov, .mkv, .webm, and .avi - everything runs on your own machine, nothing leaves it.",
      onboardingEditTitle: "Edit and personalize",
      onboardingEditBody: "Fix the text if something came out wrong, pick from 4 caption styles, and turn on word-by-word karaoke highlighting if you want it.",
      onboardingDownloadTitle: "Download or burn the captions",
      onboardingDownloadBody: "Download the .srt, .vtt, or .ass directly, or burn the captions into the video with one click. Your last 10 jobs stay in \"Recent jobs\" so you can re-download them.",
      onboardingBack: "Back",
      onboardingNext: "Next",
      onboardingGetStarted: "Get started",
      onboardingDontShow: "Don't show this again",
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
    // Any [data-lang] toggle button (the header ES/EN switch) reflects
    // currentLang here, generically - so every caller of setLang() (app.js's
    // header switch AND onboarding.js's language-pick step) keeps it in
    // sync for free, instead of each one having to remember its own copy.
    root.querySelectorAll("[data-lang]").forEach((el) => {
      const isActive = el.getAttribute("data-lang") === currentLang;
      el.classList.toggle("lang-switch__button--active", isActive);
      el.setAttribute("aria-pressed", String(isActive));
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
