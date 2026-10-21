// First-run welcome tour: a language pick, then a 3-step walkthrough. Shown
// once automatically, then never again unless the user never dismissed it
// permanently - see the two distinct exits below.
(() => {
  const { t, setLang } = window.CaptionForgeI18n;
  const DISMISS_KEY = "captionforge_onboarding_dismissed";
  const TOTAL_TOUR_STEPS = 3; // steps 1..3; step 0 is the language pick, not part of the count

  const overlay = document.getElementById("onboarding-overlay");
  const closeButton = document.getElementById("onboarding-close");
  const dontShowButton = document.getElementById("onboarding-dont-show");
  const backButton = document.getElementById("onboarding-back");
  const nextButton = document.getElementById("onboarding-next");
  const dotsContainer = document.getElementById("onboarding-dots");
  const actionsContainer = document.querySelector(".onboarding-actions");
  const langEsButton = document.getElementById("onboarding-lang-es");
  const langEnButton = document.getElementById("onboarding-lang-en");

  const steps = [0, 1, 2, 3].map((n) => document.getElementById(`onboarding-step-${n}`));
  const dots = Array.from(dotsContainer.querySelectorAll(".onboarding-dot"));

  let currentStep = 0;

  function isPermanentlyDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === "true";
    } catch {
      return false; // localStorage can throw in private-browsing/locked-down contexts - show the tour rather than guess.
    }
  }

  function close() {
    overlay.hidden = true;
  }

  // "Don't show again" AND finishing the tour naturally both mean "seen it,
  // don't ask again" - only the neutral X (close()) is a this-time-only skip,
  // so the tour still greets the user next session if they just bailed once.
  function dismissPermanently() {
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // Non-fatal: it'll just show again next session in private/locked-down contexts.
    }
    close();
  }

  function render() {
    steps.forEach((el, i) => {
      el.hidden = i !== currentStep;
    });
    const onTourStep = currentStep >= 1;
    actionsContainer.hidden = !onTourStep;
    dotsContainer.hidden = !onTourStep;
    if (!onTourStep) return;
    dots.forEach((dot, i) => dot.classList.toggle("onboarding-dot--active", i === currentStep - 1));
    backButton.hidden = false;
    nextButton.textContent = currentStep === TOTAL_TOUR_STEPS ? t("onboardingGetStarted") : t("onboardingNext");
  }

  function goTo(step) {
    currentStep = step;
    render();
  }

  langEsButton.addEventListener("click", () => {
    setLang("es");
    goTo(1);
  });
  langEnButton.addEventListener("click", () => {
    setLang("en");
    goTo(1);
  });

  backButton.addEventListener("click", () => goTo(currentStep - 1));
  nextButton.addEventListener("click", () => {
    if (currentStep === TOTAL_TOUR_STEPS) dismissPermanently();
    else goTo(currentStep + 1);
  });

  closeButton.addEventListener("click", close);
  dontShowButton.addEventListener("click", dismissPermanently);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });

  // Exposed so app.js's language switch (the header ES/EN buttons) can keep
  // the "Siguiente"/"Empezar" button text in sync while the tour is open -
  // applyToDom() already covers every [data-i18n] element, but this button's
  // text is derived (it depends on which step we're on), same reasoning as
  // app.js's own stage-label refresh on a language switch.
  window.CaptionForgeOnboarding = { refresh: render };

  if (!isPermanentlyDismissed()) {
    overlay.hidden = false;
    render();
  }
})();
