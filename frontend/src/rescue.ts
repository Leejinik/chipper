// What happened to the session when the whole App went down on a render error
// (App saves it from the editors as it unmounts; the top-level ErrorBoundary
// tells the user). A tiny store because the two live on opposite sides of the
// boundary.
export type RescueState = "" | "saving" | "saved" | "failed" | "skipped";

// An edited tab as it was when the App went down. Its text was taken out of
// the editor then (inside `save`); `inSession`: the session the App saved
// holds it too. The ones the session does not hold (a big tab — the session
// keeps only its path — or every edited tab when the session was not saved)
// exist only here: the error screen offers 「파일로 저장」 for each and asks
// before 「다시 시도」 or closing the window would drop them.
export interface RescueItem {
  id: string;
  name: string;
  path: string; // "" = never saved (「파일로 저장」 asks where)
  size: number; // characters
  inSession: boolean;
  state: "" | "saving" | "saved" | "failed";
  error: string;
  save: () => Promise<boolean>; // true = written
}

let state: RescueState = "";
let items: RescueItem[] = [];
const subs = new Set<() => void>();

// Called during React's commit (App unmounting): notify after it.
const notify = () => queueMicrotask(() => subs.forEach((f) => f()));

export const getRescue = (): RescueState => state;

export function setRescue(s: RescueState) {
  state = s;
  notify();
}

export const getRescueItems = (): RescueItem[] => items;

export function setRescueItems(list: RescueItem[]) {
  items = list;
  notify();
}

// The tabs whose edits are not kept anywhere yet: not in the saved session
// (or the session was not saved) and not written by 「파일로 저장」.
export function unsavedRescueItems(): RescueItem[] {
  return items.filter((i) => i.state !== "saved" && !(state === "saved" && i.inSession));
}

export async function saveRescueItem(id: string) {
  const it = items.find((i) => i.id === id);
  if (!it || it.state === "saving") return;
  it.state = "saving";
  it.error = "";
  notify();
  try {
    it.state = (await it.save()) ? "saved" : "";
  } catch (e) {
    it.state = "failed";
    it.error = String(e);
  }
  notify();
}

export function subscribeRescue(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
