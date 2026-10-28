import { COMMON, addTag, rotationKey, tagsFor, type BundleRef, type TagSource, type TagStore } from "./logTags";

// Assigning tags to places (tree right-click, tab menu, status bar 🏷).
//
// Every lookup goes through tagsFor (logTags.ts) with a real path, so the
// matching rules — rotation series, Windows/Linux case handling — stay in one
// place. A folder is asked about through a probe file name inside it that can
// never be a real file or match a file assignment.

export const PROBE = "\u0001";

export type AssignTarget =
  // dir: key = folder path under the server folder ("" = server root)
  // file: key = rotationKey(path under the server folder)
  // name: key = rotationKey(bare file name), for files outside a bundle
  { kind: "dir" | "file" | "name"; key: string; path: string };

// Path of a probe file inside folder `dir` of a path-producing function.
export const dirProbe = (pathOf: (rel: string) => string, dir: string) => pathOf(dir ? dir + "/" + PROBE : PROBE);

const segs = (k: string) => (k === "" ? 0 : k.split("/").length);
const nonCommon = (names: string[]) => names.filter((n) => n !== COMMON);

export interface PlaceTags {
  directKey: string | undefined; // stored key of this place's own assignment
  direct: string[] | undefined; // its existing tags ([] = "no tags here"); undefined = inherits
  effective: string[]; // non-common tags in effect here
  from: TagSource; // where `effective` comes from
  inherited: boolean; // effective tags come from a folder above
  overrides: string[]; // file with its own tags: the folder tags they replace
}

export function placeTags(store: TagStore, t: AssignTarget, bundle: BundleRef | null | undefined): PlaceTags {
  const ap = tagsFor(store, t.path, bundle);
  const src = ap.source;
  const own =
    t.kind === "dir"
      ? src.kind === "dir" && segs(src.key) === segs(t.key)
      : src.kind === t.kind;
  const effective = nonCommon(ap.names);
  let overrides: string[] = [];
  if (t.kind === "file" && own) {
    const parentProbe = t.path.replace(/[^\\/]*$/, PROBE);
    overrides = nonCommon(tagsFor(store, parentProbe, bundle).names);
  }
  return {
    directKey: own && src.kind !== "none" ? src.key : undefined,
    direct: own ? effective : undefined,
    effective,
    from: src,
    inherited: !own && src.kind === "dir",
    overrides,
  };
}

// Set (names), mark "no tags here" ([]) or clear (null: inherit again) the
// assignment of a place. The stored key that lookups find for the place is the
// one replaced, so a place never ends up with two competing entries.
export function setAssign(
  store: TagStore,
  t: AssignTarget,
  bundle: BundleRef | null | undefined,
  names: string[] | null
): TagStore {
  const cur = placeTags(store, t, bundle);
  const map = { ...store.assign[t.kind] };
  if (cur.directKey !== undefined) delete map[cur.directKey];
  if (names) {
    const known = new Set(store.tags.map((x) => x.name));
    map[cur.directKey ?? t.key] = names.filter((n, i) => n !== COMMON && known.has(n) && names.indexOf(n) === i);
  }
  return { ...store, assign: { ...store.assign, [t.kind]: map } };
}

// Assignment target of an open file: its rotation series when it lies in the
// bundle, else its bare name. null for a tab without a path.
export function targetForPath(path: string, bundleRel: { rel: string } | null): AssignTarget | null {
  if (!path) return null;
  if (bundleRel) return { kind: "file", key: rotationKey(bundleRel.rel), path };
  const base = path.split(/[\\/]/).pop() || "";
  return base ? { kind: "name", key: rotationKey(base), path } : null;
}

// Assignment target of the folder an open bundle file lies in ("" = the
// server folder itself). null outside a bundle or for a tab without a path.
export function folderTargetForPath(path: string, bundleRel: { rel: string } | null): AssignTarget | null {
  if (!path || !bundleRel) return null;
  const cut = bundleRel.rel.lastIndexOf("/");
  return { kind: "dir", key: cut < 0 ? "" : bundleRel.rel.slice(0, cut), path: path.replace(/[^\\/]*$/, PROBE) };
}

// What the assign window decided, applied to the store as it is when 확인 is
// pressed (not to the copy the window opened with): only the new tags it made
// and this one place change.
export interface AssignChange {
  target: AssignTarget;
  created: string[]; // tags made in the window, in order
  names: string[] | null; // as setAssign
}
export function applyAssignChange(store: TagStore, c: AssignChange, bundle: BundleRef | null | undefined): TagStore {
  let s = store;
  for (const n of c.created) if (!s.tags.some((t) => t.name === n)) s = addTag(s, n);
  return setAssign(s, c.target, bundle, c.names);
}

// placeTags with a cache for one store + bundle: the tree asks for every
// line it draws, and the same answer object lets unchanged lines skip redraws.
export function cachedPlaceTags(store: TagStore, bundle: BundleRef | null | undefined): (t: AssignTarget) => PlaceTags {
  const cache = new Map<string, PlaceTags>();
  return (t) => {
    const k = t.kind + "\u0000" + t.key + "\u0000" + t.path;
    let v = cache.get(k);
    if (!v) {
      v = placeTags(store, t, bundle);
      cache.set(k, v);
    }
    return v;
  };
}

// "서버 폴더 전체" → "서버 폴더 전체에서", "modules/x" → "modules/x 에서":
// the particle sits right after a Korean word, after a space behind a path.
export function withEseo(phrase: string): string {
  return /[\uac00-\ud7a3]$/.test(phrase) ? phrase + "에서" : phrase + " 에서";
}

// "modules/lizcollector/collector.log.*" → "modules/lizcollector/collector.log"
export function seriesBase(key: string): string {
  return /[._-]\*$/.test(key) ? key.slice(0, -2) : key;
}

// Where an assignment applies, as a sentence for the window and menus.
export function targetSentence(t: AssignTarget): string {
  if (t.kind === "dir")
    return t.key === ""
      ? "모든 서버의 서버 폴더 전체(그 아래 모든 파일)에 적용됩니다"
      : `모든 서버의 ${t.key} 폴더와 그 아래 모든 파일에 적용됩니다`;
  if (t.kind === "file") return `모든 서버의 ${seriesBase(t.key)} 와 회전 파일 모두에 적용됩니다`;
  return `맨 위 폴더(서버) 밖의, 이름이 「${seriesBase(t.key)}」 인 파일과 그 회전 파일 모두에 적용됩니다 (열어 둔 디렉토리 바로 아래 파일·디렉토리 밖에서 연 파일, 폴더는 상관없음)`;
}

// Where tags in effect come from, as a short noun phrase ("" = nowhere).
export function fromWhere(src: TagSource): string {
  if (src.kind === "file") return `파일 ${seriesBase(src.key)}(회전 파일 포함)`;
  if (src.kind === "dir") return src.key === "" ? "서버 폴더 전체" : `폴더 ${src.key}`;
  if (src.kind === "name") return `이름 「${seriesBase(src.key)}」`;
  return "";
}
