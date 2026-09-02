(() => {
  const { t, applyToDom, setLang, getLang } = window.CaptionForgeI18n;

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const selectedFileLabel = document.getElementById("selected-file");
  const uploadButton = document.getElementById("upload-button");
  const modelSizeSelect = document.getElementById("model-size");
  const languageInput = document.getElementById("language");
  const translateToInput = document.getElementById("translate-to");

  const uploadSection = document.getElementById("upload-section");
  const progressSection = document.getElementById("progress-section");
  const stageLabel = document.getElementById("stage-label");
  const progressFill = document.getElementById("progress-fill");

  const errorSection = document.getElementById("error-section");
  const errorMessage = document.getElementById("error-message");

  const resultsSection = document.getElementById("results-section");
  const downloadSrtLink = document.getElementById("download-srt");
  const burnButton = document.getElementById("burn-button");
  const burnProgressSection = document.getElementById("burn-progress");
  const burnStageLabel = document.getElementById("burn-stage-label");
  const burnProgressFill = document.getElementById("burn-progress-fill");
  const downloadVideoLink = document.getElementById("download-video");
  const restartButton = document.getElementById("restart-button");

  const langEsButton = document.getElementById("lang-es");
  const langEnButton = document.getElementById("lang-en");

  let selectedFile = null;
  let currentJobId = null;
  // The last job payload received for each progress stream, kept around
  // purely so a language switch mid-run can re-derive the stage label
  // instead of leaving it frozen in the old language until the next event.
  let lastMainJob = null;
  let lastBurnJob = null;
  // Re-invoked on a language switch to refresh whatever error is on screen.
  // `null` when no error is showing.
  let lastErrorRender = null;

  // Every status the backend's job state machine can report (see jobs.py) -
  // deliberately language-neutral, so the label shown for it is derived here
  // instead of trusting stage_label, which the backend only ever writes in
  // Spanish.
  function stageLabelFor(status, progress) {
    switch (status) {
      case "queued":
        return t("stageQueued");
      case "extracting_audio":
        return t("stageExtracting");
      case "transcribing":
        return t("stageTranscribing", { percent: Math.round((progress || 0) * 100) });
      case "done":
      case "burned":
        return t("stageReady");
      case "burning_subtitles":
        return t("stageBurning");
      default:
        return "";
    }
  }

  function renderSelectedFile() {
    if (selectedFile) {
      selectedFileLabel.textContent = t("selectedFile", { name: selectedFile.name });
      selectedFileLabel.hidden = false;
      uploadButton.disabled = false;
    } else {
      selectedFileLabel.hidden = true;
      uploadButton.disabled = true;
    }
  }

  function setSelectedFile(file) {
    selectedFile = file;
    renderSelectedFile();
  }

  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => setSelectedFile(fileInput.files[0] || null));

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("drop-zone--active");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("drop-zone--active");
    });
  });
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  });

  // `text` is shown verbatim and NOT re-translated on a language switch -
  // used for backend-provided detail strings (HTTPException bodies, job.error),
  // which the server only ever writes in Spanish today (see the README's
  // "known limitation" note).
  function showRawError(text) {
    errorMessage.textContent = text;
    errorSection.hidden = false;
    progressSection.hidden = true;
    lastErrorRender = () => {
      errorMessage.textContent = text;
    };
  }

  // `key`/`params` ARE re-translated on a language switch - used for every
  // error message this frontend generates itself.
  function showError(key, params) {
    errorMessage.textContent = t(key, params);
    errorSection.hidden = false;
    progressSection.hidden = true;
    lastErrorRender = () => {
      errorMessage.textContent = t(key, params);
    };
  }

  function watchJobEvents(jobId, { onUpdate, onDone }) {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      const job = JSON.parse(event.data);
      onUpdate(job);
      if (job.status === "error") {
        source.close();
        if (job.error) showRawError(job.error);
        else showError("genericJobError");
      } else if (job.status === "done" || job.status === "burned") {
        source.close();
        onDone(job);
      }
    };
    source.onerror = () => {
      // The browser retries automatically; if the job genuinely
      // disappeared server-side the next GET-based check on reconnect
      // will surface it as a 404-driven error instead of hanging silently.
      source.close();
    };
    return source;
  }

  uploadButton.addEventListener("click", async () => {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("model_size", modelSizeSelect.value);
    if (languageInput.value.trim()) formData.append("language", languageInput.value.trim());
    if (translateToInput.value.trim()) formData.append("translate_to", translateToInput.value.trim());

    uploadButton.disabled = true;
    let response;
    try {
      response = await fetch("/api/jobs", { method: "POST", body: formData });
    } catch (err) {
      showError("connectionError");
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.detail) showRawError(body.detail);
      else showError("uploadErrorFallback", { status: response.status });
      uploadButton.disabled = false;
      return;
    }

    const { job_id: jobId } = await response.json();
    currentJobId = jobId;
    uploadSection.hidden = true;
    progressSection.hidden = false;

    watchJobEvents(jobId, {
      onUpdate: (job) => {
        lastMainJob = job;
        stageLabel.textContent = stageLabelFor(job.status, job.progress);
        progressFill.style.width = `${Math.round(job.progress * 100)}%`;
      },
      onDone: (job) => {
        progressSection.hidden = true;
        resultsSection.hidden = false;
        downloadSrtLink.href = `/api/jobs/${jobId}/srt`;
      },
    });
  });

  burnButton.addEventListener("click", async () => {
    if (!currentJobId) return;
    burnButton.disabled = true;
    burnProgressSection.hidden = false;

    const response = await fetch(`/api/jobs/${currentJobId}/burn`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.detail) showRawError(body.detail);
      else showError("burnErrorFallback", { status: response.status });
      return;
    }

    watchJobEvents(currentJobId, {
      onUpdate: (job) => {
        lastBurnJob = job;
        burnStageLabel.textContent = stageLabelFor(job.status, job.progress);
        burnProgressFill.style.width = `${Math.round(job.progress * 100)}%`;
      },
      onDone: (job) => {
        burnProgressSection.hidden = true;
        downloadVideoLink.hidden = false;
        downloadVideoLink.href = `/api/jobs/${currentJobId}/video`;
      },
    });
  });

  restartButton.addEventListener("click", () => location.reload());

  function syncLangButtons() {
    const lang = getLang();
    langEsButton.classList.toggle("lang-switch__button--active", lang === "es");
    langEnButton.classList.toggle("lang-switch__button--active", lang === "en");
    langEsButton.setAttribute("aria-pressed", String(lang === "es"));
    langEnButton.setAttribute("aria-pressed", String(lang === "en"));
  }

  function changeLang(lang) {
    setLang(lang); // re-applies every [data-i18n] / [data-i18n-placeholder] element
    syncLangButtons();
    // [data-i18n] only covers static markup - text this script wrote itself
    // (the selected-file label, the live stage label, a shown error) needs
    // its own refresh, or it stays frozen in the old language.
    renderSelectedFile();
    if (lastMainJob) stageLabel.textContent = stageLabelFor(lastMainJob.status, lastMainJob.progress);
    if (lastBurnJob) burnStageLabel.textContent = stageLabelFor(lastBurnJob.status, lastBurnJob.progress);
    if (lastErrorRender) lastErrorRender();
  }

  langEsButton.addEventListener("click", () => changeLang("es"));
  langEnButton.addEventListener("click", () => changeLang("en"));

  applyToDom();
  syncLangButtons();
})();
