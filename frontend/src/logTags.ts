import { DEFAULT_LOG_RULES, normalizeLogRules, type LogRule } from "./logHighlight";

// Log colour tags: named rule sets stored in ~/.chipper/tags.json (Go: tags.go).
// `common` applies to every log; other tags apply where they are assigned.
// Tag names are case-sensitive ("collector" and "Collector" are two tags).

export const COMMON = "common";
export const TAGS_VERSION = 1;

export interface Tag {
  name: string;
  rules: LogRule[];
  updated: string; // ISO time of the last change ("" = unknown)
}

// Where tags are assigned. Keys of dir/file are paths under a bundle's server
// folder ("modules/lizcollector", "" = the whole server), "/"-separated, so one
// assignment covers that path on every server. file keys are rotation keys
// (rotationKey: "modules/lizcollector/collector.log.*"). name keys are the
// rotation key of a bare file name, for files opened outside a bundle.
// A key with [] means "explicitly no tags here" (stops inheritance); an absent
// key inherits.
export interface TagAssign {
  dir: Record<string, string[]>;
  file: Record<string, string[]>;
  name: Record<string, string[]>;
}

export interface TagStore {
  version: number;
  tags: Tag[];
  assign: TagAssign;
}

export const emptyAssign = (): TagAssign => ({ dir: {}, file: {}, name: {} });

// Rotated logs ("controller.log.2026-10-21-06", "messages-20261011",
// "app.log.3") share a series key so they are treated as one log.
export function rotationKey(rel: string): string {
  return rel
    .replace(/([._-])\d{4}-?\d{2}-?\d{2}([-_T.]?\d{1,2}){0,3}(_\d+)?$/, "$1*")
    .replace(/\.\d{1,3}$/, ".*");
}

// Why `name` can't be used as a new/renamed tag name ("" = fine). `others` are
// the names already taken (excluding the tag being renamed). Mirrors Go's
// tagNameProblem plus the duplicate check, which is case-sensitive.
export function tagNameProblem(name: string, others: string[]): string {
  if (!name) return "태그 이름이 비어 있습니다";
  if (name.trim() !== name) return "태그 이름 앞뒤에 공백을 둘 수 없습니다";
  if ([...name].length > 100) return "태그 이름은 100자까지입니다";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "태그 이름에 제어 문자(줄바꿈·탭 등)를 쓸 수 없습니다";
  if (others.includes(name)) return `「${name}」 태그가 이미 있습니다`;
  return "";
}

// "collector (2)", "collector (3)", … — the first name not in `taken`.
export function uniqueTagName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!taken.includes(n)) return n;
  }
}

function normalizeAssignMap(raw: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue;
    const names = [...new Set(v.filter((x): x is string => typeof x === "string" && x !== COMMON))];
    out[k.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")] = names;
  }
  return out;
}

// A store from tags.json text (or parsed value). Bad tags are dropped, the
// first of duplicate names kept, and `common` is always present and first.
export function normalizeTagStore(raw: any): TagStore {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw?.tags) ? raw.tags : []) {
    if (!t || typeof t.name !== "string" || tagNameProblem(t.name, []) || seen.has(t.name)) continue;
    seen.add(t.name);
    tags.push({
      name: t.name,
      rules: Array.isArray(t.rules) ? normalizeLogRules(t.rules) : [],
      updated: typeof t.updated === "string" ? t.updated : "",
    });
  }
  const ci = tags.findIndex((t) => t.name === COMMON);
  if (ci < 0) tags.unshift({ name: COMMON, rules: DEFAULT_LOG_RULES, updated: "" });
  else if (ci > 0) tags.unshift(...tags.splice(ci, 1));
  const a = raw?.assign;
  return {
    version: TAGS_VERSION,
    tags,
    assign: { dir: normalizeAssignMap(a?.dir), file: normalizeAssignMap(a?.file), name: normalizeAssignMap(a?.name) },
  };
}

// First run: common from the old session's `logRules` (or the defaults).
export function migratedStore(sessionLogRules: unknown, now = new Date().toISOString()): TagStore {
  const rules = Array.isArray(sessionLogRules) ? normalizeLogRules(sessionLogRules) : DEFAULT_LOG_RULES;
  return { version: TAGS_VERSION, tags: [{ name: COMMON, rules, updated: now }], assign: emptyAssign() };
}

export const serializeTags = (s: TagStore) => JSON.stringify(s, null, 2);

// --- which tags apply to a file ------------------------------------------------

export interface BundleRef {
  root: string;
  servers: string[];
}

const isWin = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
const fold = (s: string) => s.toLowerCase();

// The bundle server and the "/"-path under it, when `path` lies inside a
// bundle server folder; null otherwise.
export function bundleRel(path: string, bundle: BundleRef | null | undefined): { server: string; rel: string } | null {
  if (!bundle || !path) return null;
  const win = isWin(bundle.root) || isWin(path);
  const norm = (p: string) => (win ? p.replace(/\\/g, "/").toLowerCase() : p);
  const root = norm(bundle.root).replace(/\/+$/, "");
  const p = norm(path);
  if (!(p.length > root.length + 1 && p.startsWith(root) && p[root.length] === "/")) return null;
  // keep the original case of the part after the root
  const rest = path.replace(/\\/g, "/").slice(root.length + 1).split("/").filter(Boolean);
  if (rest.length < 2) return null; // a file directly in the bundle folder belongs to no server
  const server = bundle.servers.find((s) => (win ? fold(s) === fold(rest[0]) : s === rest[0]));
  if (!server) return null;
  return { server, rel: rest.slice(1).join("/") };
}

// Assignment lookup: exact key first, then a case-insensitive match (bundles
// come from Windows copies as often as from Linux servers).
function lookup(map: Record<string, string[]>, key: string): [string, string[]] | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return [key, map[key]];
  const k = fold(key);
  for (const [mk, v] of Object.entries(map)) if (fold(mk) === k) return [mk, v];
  return undefined;
}

export type TagSource =
  | { kind: "file"; key: string }
  | { kind: "dir"; key: string }
  | { kind: "name"; key: string }
  | { kind: "none" };

export interface AppliedTags {
  names: string[]; // always starts with "common"; then the assigned tags that exist
  source: TagSource; // where the non-common tags came from
}

// Tags for a file:
//   bundle file → tags put directly on its rotation series (assign.file) if
//                 that key exists; else those of the nearest folder up to the
//                 server root ""; else none.
//   other file  → assign.name[rotationKey(base name)].
// `common` is always included (first). Unknown tag names are skipped.
export function tagsFor(store: TagStore, path: string, bundle?: BundleRef | null): AppliedTags {
  const exists = new Set(store.tags.map((t) => t.name));
  const pick = (v: string[], source: TagSource): AppliedTags => ({
    names: [COMMON, ...v.filter((n, i) => n !== COMMON && exists.has(n) && v.indexOf(n) === i)],
    source,
  });
  const br = bundleRel(path, bundle);
  if (br) {
    const fileKey = rotationKey(br.rel);
    const direct = lookup(store.assign.file, fileKey);
    if (direct) return pick(direct[1], { kind: "file", key: direct[0] });
    const parts = br.rel.split("/");
    for (let n = parts.length - 1; n >= 0; n--) {
      const key = parts.slice(0, n).join("/");
      const v = lookup(store.assign.dir, key);
      if (v) return pick(v[1], { kind: "dir", key: v[0] });
    }
    return pick([], { kind: "none" });
  }
  const base = path.split(/[\\/]/).pop() || "";
  if (base) {
    const key = rotationKey(base);
    const v = lookup(store.assign.name, key);
    if (v) return pick(v[1], { kind: "name", key: v[0] });
  }
  return pick([], { kind: "none" });
}

// The rules for a set of applied tags, in highlighter priority order: the
// file's tags first (in the order given), common last — so where a tag rule and
// a common rule colour the same characters, the tag wins.
export function rulesFor(store: TagStore, names: string[]): LogRule[] {
  const byName = new Map(store.tags.map((t) => [t.name, t]));
  const order = [...names.filter((n) => n !== COMMON), ...(names.includes(COMMON) ? [COMMON] : [])];
  return order.flatMap((n) => byName.get(n)?.rules ?? []);
}

// Where a tag is assigned, for the tag window.
export function placesOf(store: TagStore, name: string): { kind: "dir" | "file" | "name"; key: string }[] {
  const out: { kind: "dir" | "file" | "name"; key: string }[] = [];
  for (const kind of ["dir", "file", "name"] as const)
    for (const [key, v] of Object.entries(store.assign[kind])) if (v.includes(name)) out.push({ kind, key });
  return out;
}

// --- edits (pure: return a new store) ------------------------------------------

const mapAssign = (a: TagAssign, f: (v: string[]) => string[] | null): TagAssign => {
  const m = (r: Record<string, string[]>) => {
    const o: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(r)) {
      const nv = f(v);
      if (nv) o[k] = nv;
    }
    return o;
  };
  return { dir: m(a.dir), file: m(a.file), name: m(a.name) };
};

export function renameTag(s: TagStore, from: string, to: string, now = new Date().toISOString()): TagStore {
  if (from === COMMON || from === to) return s;
  return {
    ...s,
    tags: s.tags.map((t) => (t.name === from ? { ...t, name: to, updated: now } : t)),
    assign: mapAssign(s.assign, (v) => v.map((n) => (n === from ? to : n))),
  };
}

// Deleting a tag also removes it from every assignment; a place left with no
// tags goes back to inheriting (the key is removed).
export function deleteTag(s: TagStore, name: string): TagStore {
  if (name === COMMON) return s;
  return {
    ...s,
    tags: s.tags.filter((t) => t.name !== name),
    assign: mapAssign(s.assign, (v) => (v.includes(name) ? (v.length > 1 ? v.filter((n) => n !== name) : null) : v)),
  };
}

export function addTag(s: TagStore, name: string, rules: LogRule[] = [], now = new Date().toISOString()): TagStore {
  return { ...s, tags: [...s.tags, { name, rules, updated: now }] };
}

export function setTagRules(s: TagStore, name: string, rules: LogRule[], now = new Date().toISOString()): TagStore {
  return { ...s, tags: s.tags.map((t) => (t.name === name ? { ...t, rules, updated: now } : t)) };
}
