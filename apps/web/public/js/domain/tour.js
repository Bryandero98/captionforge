// Guía interactiva (v1.3.1) como funciones puras: pasos, navegación y «ya la vio». Sin DOM.
// Se abre sola solo la primera vez; el botón «Ayuda» la vuelve a abrir. Si el almacenamiento está bloqueado no se abre sola
// (insistiría en cada visita) pero el botón sigue funcionando.

/** @typedef {{ open: boolean, index: number }} TourState */
/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} StorageLike */

export const TOUR_KEY = "cf-tour";

/** `id` da las claves de texto `tour.step.<id>.title/body`; `target` es el id del elemento al que se lleva la vista. */
export const TOUR_STEPS = Object.freeze([
  { id: "choose", target: "drop" },
  { id: "generate", target: "start" },
  { id: "review", target: "result-panel" },
  { id: "translate", target: "translate-form" },
  { id: "dub", target: "dub-form" },
  { id: "video", target: "burn-form" },
]);

/** @returns {TourState} */
export const openTour = () => ({ open: true, index: 0 });

/** @param {TourState} state @returns {TourState} */
export const closeTour = (state) => ({ ...state, open: false });

/** @param {TourState} state @returns {TourState} */
export function goNext(state) {
  if (!state.open) return state;
  return { ...state, index: Math.min(TOUR_STEPS.length - 1, state.index + 1) };
}

/** @param {TourState} state @returns {TourState} */
export function goPrevious(state) {
  if (!state.open) return state;
  return { ...state, index: Math.max(0, state.index - 1) };
}

/** @param {StorageLike | null | undefined} storage */
export function hasSeenTour(storage) {
  try {
    return storage?.getItem(TOUR_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {StorageLike | null | undefined} storage */
export function markTourSeen(storage) {
  try {
    storage?.setItem(TOUR_KEY, "1");
  } catch {
    // sin almacenamiento: no se recuerda, y por eso tampoco se abre sola
  }
}

/** Solo en la primera visita y solo si se puede recordar que ya se vio. @param {StorageLike | null | undefined} storage */
export function shouldAutoOpen(storage) {
  if (storage === null || storage === undefined) return false;
  try {
    storage.getItem(TOUR_KEY);
  } catch {
    return false;
  }
  return !hasSeenTour(storage);
}
