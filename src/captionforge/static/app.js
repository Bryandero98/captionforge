(() => {
  const { t, applyToDom, setLang } = window.CaptionForgeI18n;

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
  const downloadVttLink = document.getElementById("download-vtt");
  const downloadAssLink = document.getElementById("download-ass");
  const burnButton = document.getElementById("burn-button");
  const burnProgressSection = document.getElementById("burn-progress");
  const burnStageLabel = document.getElementById("burn-stage-label");
  const burnProgressFill = document.getElementById("burn-progress-fill");
  const downloadVideoLink = document.getElementById("download-video");
  const restartButton = document.getElementById("restart-button");

  const editToggleButton = document.getElementById("edit-toggle-button");
  const editSection = document.getElementById("edit-section");
  const editRows = document.getElementById("edit-rows");
  const editSaveButton = document.getElementById("edit-save-button");
  const editSavedLabel = document.getElementById("edit-saved-label");

  const subtitleStyleSelect = document.getElementById("subtitle-style");
  const karaokeOption = document.getElementById("karaoke-option");
  const karaokeCheckbox = document.getElementById("karaoke-checkbox");

  const historyEmpty = document.getElementById("history-empty");
  const historyList = document.getElementById("history-list");
  const historyClearButton = document.getElementById("history-clear-button");

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

  // ---- Recent-jobs history (localStorage only - the backend forgets a job
  // once a new one starts; see routes/results.py's historical-download
  // fallback, which is what makes these links keep working after that). ----
  const HISTORY_KEY = "captionforge_history";
  const MAX_HISTORY_ENTRIES = 10;

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory(entries) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    } catch {
      // Non-fatal: history just won't persist this session (private mode, full storage).
    }
  }

  function addHistoryEntry(entry) {
    const entries = [entry, ...loadHistory().filter((e) => e.jobId !== entry.jobId)].slice(0, MAX_HISTORY_ENTRIES);
    saveHistory(entries);
    renderHistory();
  }

  // ---- Resuming an in-progress job after an accidental reload - a live job
  // keeps running server-side regardless of what the browser does, but
  // without this the UI would just fall back to the empty upload screen,
  // making it look like the work was lost. ----
  const ACTIVE_JOB_KEY = "captionforge_active_job";

  function saveActiveJob(jobId, filename) {
    try {
      localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ jobId, filename }));
    } catch {
      // Non-fatal: an accidental reload just won't resume this session (private mode, full storage).
    }
  }

  function clearActiveJob() {
    try {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    } catch {
      // Non-fatal.
    }
  }

  function loadActiveJob() {
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed.jobId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  function updateHistoryEntry(jobId, patch) {
    const entries = loadHistory().map((e) => (e.jobId === jobId ? { ...e, ...patch } : e));
    saveHistory(entries);
    renderHistory();
  }

  function renderHistory() {
    const entries = loadHistory();
    historyList.innerHTML = "";
    historyEmpty.hidden = entries.length > 0;
    historyClearButton.hidden = entries.length === 0;
    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "history-item";

      const name = document.createElement("span");
      name.className = "history-item__name";
      name.textContent = entry.filename || entry.jobId;
      name.title = entry.filename || entry.jobId;
      li.appendChild(name);

      const links = document.createElement("span");
      links.className = "history-item__links";
      const linkSpecs = [
        ["historySrt", `/api/jobs/${entry.jobId}/srt`],
        ["historyVtt", `/api/jobs/${entry.jobId}/vtt`],
        ["historyAss", `/api/jobs/${entry.jobId}/ass`],
      ];
      if (entry.videoReady) linkSpecs.push(["historyVideo", `/api/jobs/${entry.jobId}/video`]);
      for (const [labelKey, href] of linkSpecs) {
        const a = document.createElement("a");
        a.href = href;
        a.download = "";
        a.textContent = t(labelKey);
        links.appendChild(a);
      }
      li.appendChild(links);
      historyList.appendChild(li);
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

  function setKaraokeAvailable(available) {
    karaokeOption.hidden = !available;
    if (!available) karaokeCheckbox.checked = false;
  }

  // ---- Edit-before-burn: fetch the transcribed segments, let the user fix
  // the text, PUT the edits back. Restricted server-side to the CURRENT job
  // (see routes/results.py) - editing only makes sense in the window between
  // transcription finishing and the first burn. ----
  function renderEditRows(segments) {
    editRows.innerHTML = "";
    for (const segment of segments) {
      const row = document.createElement("div");
      row.className = "edit-row";

      const totalSeconds = Math.floor(segment.start);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const time = document.createElement("span");
      time.className = "edit-row__time";
      time.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
      row.appendChild(time);

      const input = document.createElement("input");
      input.type = "text";
      input.className = "edit-row__text";
      input.value = segment.text;
      input.dataset.index = String(segment.index);
      row.appendChild(input);

      editRows.appendChild(row);
    }
  }

  editToggleButton.addEventListener("click", async () => {
    if (!editSection.hidden) {
      editSection.hidden = true;
      return;
    }
    if (!currentJobId) return;
    const response = await fetch(`/api/jobs/${currentJobId}/segments`);
    if (!response.ok) {
      showError("editLoadErrorFallback");
      return;
    }
    const { segments } = await response.json();
    renderEditRows(segments);
    editSection.hidden = false;
  });

  editSaveButton.addEventListener("click", async () => {
    if (!currentJobId) return;
    const edits = Array.from(editRows.querySelectorAll(".edit-row__text")).map((input) => ({
      index: Number(input.dataset.index),
      text: input.value,
    }));

    editSaveButton.disabled = true;
    const response = await fetch(`/api/jobs/${currentJobId}/segments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: edits }),
    });
    editSaveButton.disabled = false;

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.detail) showRawError(body.detail);
      else showError("editErrorFallback", { status: response.status });
      return;
    }

    // Editing may have dropped word timings on the changed lines (see
    // routes/results.py) - refresh whether karaoke is still offered.
    const jobResponse = await fetch(`/api/jobs/${currentJobId}`);
    if (jobResponse.ok) {
      const job = await jobResponse.json();
      setKaraokeAvailable(job.karaoke_available);
    }

    editSavedLabel.hidden = false;
    setTimeout(() => {
      editSavedLabel.hidden = true;
    }, 2000);
  });

  historyClearButton.addEventListener("click", () => {
    saveHistory([]);
    renderHistory();
  });

  // How many consecutive EventSource errors to let the browser's own
  // automatic reconnect absorb silently before giving up and telling the
  // user - a transient drop typically heals within a retry or two, but a
  // server that's genuinely gone (crashed, killed) would otherwise retry
  // forever with the progress bar frozen and no explanation.
  const MAX_SSE_RECONNECT_ATTEMPTS = 4;

  function watchJobEvents(jobId, { onUpdate, onDone }) {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    let consecutiveErrors = 0;
    source.onmessage = (event) => {
      consecutiveErrors = 0;
      const job = JSON.parse(event.data);
      onUpdate(job);
      if (job.status === "error") {
        source.close();
        // A real terminal failure, not just a dropped connection - clear the
        // resume pointer so an accidental reload lands back on a clean
        // upload screen (the only recovery path today; the error card has
        // no retry button of its own) instead of re-showing the same error.
        clearActiveJob();
        if (job.error) showRawError(job.error);
        else showError("genericJobError");
      } else if (job.status === "done" || job.status === "burned") {
        source.close();
        onDone(job);
      }
    };
    source.onerror = () => {
      consecutiveErrors += 1;
      if (consecutiveErrors < MAX_SSE_RECONNECT_ATTEMPTS) return; // let the browser's own retry keep trying
      source.close();
      // Unlike a real job error above, this doesn't clear the resume
      // pointer - the job may well still be running server-side, we've
      // just lost the connection to it, and a reload should try again.
      showError("connectionLostError");
    };
    return source;
  }

  // Shared between the live upload flow and resuming an already-finished
  // job after a reload (see resumeActiveJobIfAny below) - keeps both paths
  // rendering the results section identically instead of drifting apart.
  function showTranscriptionResults(jobId, karaokeAvailable, filename) {
    progressSection.hidden = true;
    resultsSection.hidden = false;
    downloadSrtLink.href = `/api/jobs/${jobId}/srt`;
    downloadVttLink.href = `/api/jobs/${jobId}/vtt`;
    downloadAssLink.href = `/api/jobs/${jobId}/ass`;
    setKaraokeAvailable(karaokeAvailable);
    addHistoryEntry({
      jobId,
      filename: filename || jobId,
      createdAt: new Date().toISOString(),
      videoReady: false,
    });
  }

  function showBurnResults(jobId) {
    burnProgressSection.hidden = true;
    downloadVideoLink.hidden = false;
    downloadVideoLink.href = `/api/jobs/${jobId}/video`;
    updateHistoryEntry(jobId, { videoReady: true });
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
    const filename = selectedFile.name;
    saveActiveJob(jobId, filename);
    uploadSection.hidden = true;
    progressSection.hidden = false;
    editSection.hidden = true;
    downloadVideoLink.hidden = true;
    setKaraokeAvailable(false);

    watchJobEvents(jobId, {
      onUpdate: (job) => {
        lastMainJob = job;
        stageLabel.textContent = stageLabelFor(job.status, job.progress);
        progressFill.style.width = `${Math.round(job.progress * 100)}%`;
      },
      onDone: (job) => showTranscriptionResults(jobId, job.karaoke_available, filename),
    });
  });

  burnButton.addEventListener("click", async () => {
    if (!currentJobId) return;
    burnButton.disabled = true;
    burnProgressSection.hidden = false;

    const formData = new FormData();
    formData.append("style", subtitleStyleSelect.value);
    formData.append("karaoke", karaokeCheckbox.checked ? "true" : "false");

    const response = await fetch(`/api/jobs/${currentJobId}/burn`, { method: "POST", body: formData });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.detail) showRawError(body.detail);
      else showError("burnErrorFallback", { status: response.status });
      return;
    }

    const jobIdAtBurnTime = currentJobId;
    watchJobEvents(currentJobId, {
      onUpdate: (job) => {
        lastBurnJob = job;
        burnStageLabel.textContent = stageLabelFor(job.status, job.progress);
        burnProgressFill.style.width = `${Math.round(job.progress * 100)}%`;
      },
      onDone: () => showBurnResults(jobIdAtBurnTime),
    });
  });

  restartButton.addEventListener("click", () => {
    clearActiveJob();
    location.reload();
  });

  // ---- On page load, pick back up wherever a still-tracked job was left -
  // an accidental reload must not look like the work vanished. ----
  async function resumeActiveJobIfAny() {
    const active = loadActiveJob();
    if (!active) return;

    let response;
    try {
      response = await fetch(`/api/jobs/${active.jobId}`);
    } catch {
      return; // Can't reach the server right now - leave the pointer alone, try again on the next load.
    }
    if (!response.ok) {
      clearActiveJob(); // Gone server-side (superseded by another job, or the server restarted) - nothing to resume.
      return;
    }
    const job = await response.json();
    currentJobId = active.jobId;
    uploadSection.hidden = true;

    if (["queued", "extracting_audio", "transcribing"].includes(job.status)) {
      progressSection.hidden = false;
      editSection.hidden = true;
      downloadVideoLink.hidden = true;
      setKaraokeAvailable(false);
      stageLabel.textContent = stageLabelFor(job.status, job.progress);
      progressFill.style.width = `${Math.round(job.progress * 100)}%`;
      watchJobEvents(active.jobId, {
        onUpdate: (j) => {
          lastMainJob = j;
          stageLabel.textContent = stageLabelFor(j.status, j.progress);
          progressFill.style.width = `${Math.round(j.progress * 100)}%`;
        },
        onDone: (j) => showTranscriptionResults(active.jobId, j.karaoke_available, active.filename),
      });
    } else if (job.status === "burning_subtitles") {
      showTranscriptionResults(active.jobId, job.karaoke_available, active.filename);
      burnProgressSection.hidden = false;
      burnStageLabel.textContent = stageLabelFor(job.status, job.progress);
      burnProgressFill.style.width = `${Math.round(job.progress * 100)}%`;
      watchJobEvents(active.jobId, {
        onUpdate: (j) => {
          lastBurnJob = j;
          burnStageLabel.textContent = stageLabelFor(j.status, j.progress);
          burnProgressFill.style.width = `${Math.round(j.progress * 100)}%`;
        },
        onDone: () => showBurnResults(active.jobId),
      });
    } else if (job.status === "done") {
      showTranscriptionResults(active.jobId, job.karaoke_available, active.filename);
    } else if (job.status === "burned") {
      showTranscriptionResults(active.jobId, job.karaoke_available, active.filename);
      showBurnResults(active.jobId);
    } else if (job.status === "error") {
      clearActiveJob();
      if (job.error) showRawError(job.error);
      else showError("genericJobError");
    }
  }

  function changeLang(lang) {
    setLang(lang); // re-applies [data-i18n]/[data-i18n-placeholder]/[data-lang] elements, header buttons included
    // [data-i18n] only covers static markup - text this script wrote itself
    // (the selected-file label, the live stage label, a shown error) needs
    // its own refresh, or it stays frozen in the old language.
    renderSelectedFile();
    if (lastMainJob) stageLabel.textContent = stageLabelFor(lastMainJob.status, lastMainJob.progress);
    if (lastBurnJob) burnStageLabel.textContent = stageLabelFor(lastBurnJob.status, lastBurnJob.progress);
    if (lastErrorRender) lastErrorRender();
    renderHistory(); // history links carry a translated label (".srt", "video", ...)
    window.CaptionForgeOnboarding?.refresh?.(); // its Next/Get-started button text is derived, not [data-i18n]
  }

  langEsButton.addEventListener("click", () => changeLang("es"));
  langEnButton.addEventListener("click", () => changeLang("en"));

  applyToDom(); // also syncs the header ES/EN buttons' active state via i18n.js's [data-lang] handling
  renderHistory();
  resumeActiveJobIfAny();
})();
