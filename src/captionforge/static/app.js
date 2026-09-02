(() => {
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

  let selectedFile = null;
  let currentJobId = null;

  function setSelectedFile(file) {
    selectedFile = file;
    if (file) {
      selectedFileLabel.textContent = `Archivo: ${file.name}`;
      selectedFileLabel.hidden = false;
      uploadButton.disabled = false;
    } else {
      selectedFileLabel.hidden = true;
      uploadButton.disabled = true;
    }
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

  function showError(message) {
    errorMessage.textContent = message;
    errorSection.hidden = false;
    progressSection.hidden = true;
  }

  function watchJobEvents(jobId, { onUpdate, onDone }) {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      const job = JSON.parse(event.data);
      onUpdate(job);
      if (job.status === "error") {
        source.close();
        showError(job.error || "Ocurrió un error inesperado.");
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
      showError("No se pudo conectar con el servidor.");
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showError(body.detail || `Error ${response.status} al subir el video.`);
      uploadButton.disabled = false;
      return;
    }

    const { job_id: jobId } = await response.json();
    currentJobId = jobId;
    uploadSection.hidden = true;
    progressSection.hidden = false;

    watchJobEvents(jobId, {
      onUpdate: (job) => {
        stageLabel.textContent = job.stage_label;
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
      showError(body.detail || `Error ${response.status} al quemar los subtítulos.`);
      return;
    }

    watchJobEvents(currentJobId, {
      onUpdate: (job) => {
        burnStageLabel.textContent = job.stage_label;
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
})();
