// What happened to the session when the whole App went down on a render error
// (App saves it from the editors as it unmounts; the top-level ErrorBoundary
// tells the user). A tiny store because the two live on opposite sides of the
// boundary.
export type RescueState = "" | "saving" | "saved" | "failed" | "skipped";

let state: RescueState = "";
const subs = new Set<() => void>();

export const getRescue = (): RescueState => state;

export function setRescue(s: RescueState) {
  state = s;
  // Called during React's commit (App unmounting): notify after it.
  queueMicrotask(() => subs.forEach((f) => f()));
}

export function subscribeRescue(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
