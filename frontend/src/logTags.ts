import { DEFAULT_LOG_RULES, DEFAULTS_REV, normalizeLogRules, type LogRule } from "./logHighlight";

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
// assignment covers that path on every server. file keys are rotation keys:
// the path of the live file of a rotated series ("modules/lizcollector/
// collector.log" covers collector.log, collector.log.1, collector.log.2026-10-21_1,
// … — see rotationKey). name keys are the rotation key of a bare file name, for
// files opened outside a bundle ("messages" covers messages-20261011 too).
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
  // Revision of the built-in common rules this common was last brought up to
  // (logHighlight DEFAULTS_REV, commonDefaults.ts); absent = 1 (before stage 6).
  defaults?: number;
}

export const emptyAssign = (): TagAssign => ({ dir: {}, file: {}, name: {} });

// The rotation key of a file: its path with the rotation suffix taken off the
// last segment, i.e. the name of the live file of its series. The live file
// and every rotated copy share it, so a tag put on one is on all of them:
//   collector.log, collector.log.1, collector.log.2026-10-21_1 → collector.log
//   controller.log.2026-10-21-06 → controller.log
//   messages, messages-20261011, messages.from-20261011         → messages
//   api_debug.log.2026-10-21.1.gz, clickhouse-server.log.0.gz  → api_debug.log, clickhouse-server.log
//   gc.log.0.current                                            → gc.log
// Shared by the tag lookup (tagsFor), the tree's 「태그 지정」 (stage 4) and
// import/export (stage 5) — the keys are stored in tags.json, so this format is
// part of the file format.
export function rotationKey(rel: string): string {
  const cut = rel.lastIndexOf("/") + 1;
  const base = rel.slice(cut);
  let b = base.replace(/\.current$/, "");
  if (/\.(gz|bz2|xz|zst)$/i.test(b) && !/\.tar\.[a-z0-9]+$/i.test(b)) b = b.replace(/\.(gz|bz2|xz|zst)$/i, "");
  b = b
    .replace(/\.from-\d{8}$/, "") // copies made by rtaskmgr's log collection
    .replace(/[._-]\d{4}-?\d{2}-?\d{2}([-_T.]?\d{1,2}){0,3}(_\d+)?$/, "")
    .replace(/\.\d{1,3}$/, "");
  return rel.slice(0, cut) + (b || base);
}

// Keys written by early stage-3 builds ended in "*" ("collector.log.*").
const legacyRotationKey = (k: string) => (/[._-]\*$/.test(k) ? k.slice(0, -2) : k);

// --- tag names ---------------------------------------------------------------------
// Same rules as Go's tagNameProblem (tags.go), spelled out character by
// character so both languages agree (JS trim() and Go TrimSpace differ):
//   - not empty, at most 100 characters (code points) — a product rule;
//   - no white space at either end (WS below = Go unicode.IsSpace ∪ JS trim);
//   - no control characters (Cc: line breaks, tabs, …);
//   - no invisible characters: format characters (Cf: zero-width space/joiner,
//     direction marks and overrides like U+202E, BOM, soft hyphen) and line/
//     paragraph separators (Zl, Zp) — two names that look the same must be the
//     same name;
//   - Unicode NFC. normalizeTagName turns a typed name into NFC first, so "é"
//     typed as e + U+0301 and as U+00E9 is one name.
// Names are compared exactly (case-sensitive: "collector" ≠ "Collector").
export const MAX_TAG_NAME_LEN = 100;
const WS = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// A typed or imported name in the form tags.json keeps (NFC). Shared with the
// tree's 「새 태그」 (stage 4) and import (stage 5).
export const normalizeTagName = (name: string) => name.normalize("NFC");

// Why `name` can't be used as a new/renamed tag name ("" = fine). `others` are
// the names already taken (excluding the tag being renamed). Pass the name
// through normalizeTagName first.
export function tagNameProblem(name: string, others: string[]): string {
  if (!name) return "태그 이름이 비어 있습니다";
  const cps = [...name];
  if (cps.length > MAX_TAG_NAME_LEN) return `태그 이름은 ${MAX_TAG_NAME_LEN}자까지입니다`;
  if (WS.test(cps[0]) || WS.test(cps[cps.length - 1])) return "태그 이름 앞뒤에 공백을 둘 수 없습니다";
  if (CONTROL.test(name)) return "태그 이름에 제어 문자(줄바꿈·탭 등)를 쓸 수 없습니다";
  if (INVISIBLE.test(name)) return "태그 이름에 보이지 않는 글자(폭 없는 문자·방향 제어 문자 등)를 쓸 수 없습니다";
  if (name.normalize("NFC") !== name) return "태그 이름이 NFC 로 정규화되어 있지 않습니다";
  if (others.includes(name)) return `「${name}」 태그가 이미 있습니다`;
  return "";
}

// A usable name made from a stored/imported one that breaks the rules (used
// when loading tags.json, and for import): NFC, invisible and control
// characters removed, ends trimmed, cut to the limit, then made unique.
export function repairTagName(raw: string, taken: string[]): string {
  let n = normalizeTagName(raw).replace(new RegExp(INVISIBLE.source, "gu"), "").replace(new RegExp(CONTROL.source, "g"), "");
  let cps = [...n];
  while (cps.length && WS.test(cps[0])) cps.shift();
  while (cps.length && WS.test(cps[cps.length - 1])) cps.pop();
  cps = cps.slice(0, MAX_TAG_NAME_LEN);
  while (cps.length && WS.test(cps[cps.length - 1])) cps.pop();
  n = cps.join("").normalize("NFC") || "이름 없는 태그";
  if ([...n].length > MAX_TAG_NAME_LEN - 5) n = [...n].slice(0, MAX_TAG_NAME_LEN - 5).join("");
  return uniqueTagName(n, taken);
}

// The one name maker: `base` when it is free, else "collector (2)",
// "collector (3)", … — the first not in `taken` (a list, or a Set/Map of
// names for big stores). The base is cut so the name stays within the
// 100-character limit.
export function uniqueTagName(base: string, taken: string[] | { has(name: string): boolean }): string {
  const has = Array.isArray(taken) ? (x: string) => taken.includes(x) : (x: string) => taken.has(x);
  if (!has(base)) return base;
  const chars = [...base];
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const room = MAX_TAG_NAME_LEN - suffix.length;
    const n = (chars.length > room ? chars.slice(0, room).join("").trimEnd() : base) + suffix;
    if (!has(n)) return n;
  }
}

// Why `s` (a rule label, say) holds characters a tag name may not: control
// characters or invisible ones (zero-width, direction marks/overrides, BOM …)
// — the same character rules as tag names. "" = none.
export function hiddenCharProblem(s: string): string {
  if (CONTROL.test(s)) return "제어 문자(줄바꿈·탭 등)";
  if (INVISIBLE.test(s)) return "보이지 않는 글자(폭 없는 문자·방향 제어 문자 등)";
  return "";
}

// An assignment key as stored: "/"-separated, no slashes at the ends; for
// file/name keys (rotation keys) the early stage-3 ".*" ending is dropped.
export function assignKey(raw: string, rotation: boolean): string {
  const key = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return rotation ? legacyRotationKey(key) : key;
}

function normalizeAssignMap(raw: any, rename: Map<string, string>, rotation: boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue;
    const names = [
      ...new Set(
        v
          .filter((x): x is string => typeof x === "string")
          .map((x) => rename.get(x) ?? normalizeTagName(x))
          .filter((x) => x !== COMMON)
      ),
    ];
    out[assignKey(k, rotation)] = names;
  }
  return out;
}

// A store from tags.json text (or parsed value): `common` always present and
// first. A tag whose name breaks the rules, or repeats an earlier name once
// both are NFC, is kept under a repaired name (repairTagName) — never dropped;
// `notes` (when given) receives one Korean line per such rename.
export function normalizeTagStore(raw: any, notes?: string[]): TagStore {
  const tags: Tag[] = [];
  const seen: string[] = [];
  const rename = new Map<string, string>(); // stored name → name used (first occurrence)
  for (const t of Array.isArray(raw?.tags) ? raw.tags : []) {
    if (!t || typeof t.name !== "string") continue;
    let name = normalizeTagName(t.name);
    if (tagNameProblem(name, seen)) {
      name = repairTagName(t.name, seen);
      notes?.push(`태그 이름 「${t.name}」을(를) 쓸 수 없어 「${name}」(으)로 바꿨습니다.`);
    }
    if (!rename.has(t.name)) rename.set(t.name, name);
    seen.push(name);
    tags.push({
      name,
      rules: Array.isArray(t.rules) ? normalizeLogRules(t.rules) : [],
      updated: typeof t.updated === "string" ? t.updated : "",
    });
  }
  const ci = tags.findIndex((t) => t.name === COMMON);
  if (ci < 0) tags.unshift({ name: COMMON, rules: DEFAULT_LOG_RULES, updated: "" });
  else if (ci > 0) tags.unshift(...tags.splice(ci, 1));
  const a = raw?.assign;
  const d = raw?.defaults;
  return {
    version: TAGS_VERSION,
    tags,
    assign: {
      dir: normalizeAssignMap(a?.dir, rename, false),
      file: normalizeAssignMap(a?.file, rename, true),
      name: normalizeAssignMap(a?.name, rename, true),
    },
    // no common at all: it was just made from the current defaults
    ...(ci < 0 ? { defaults: DEFAULTS_REV } : Number.isInteger(d) && d >= 1 ? { defaults: d } : {}),
  };
}

// First run: common from the old session's `logRules` (or the defaults).
export function migratedStore(sessionLogRules: unknown, now = new Date().toISOString()): TagStore {
  // an old session's rules are revision 1 (brought up to date by commonDefaults.ts)
  if (Array.isArray(sessionLogRules))
    return { version: TAGS_VERSION, tags: [{ name: COMMON, rules: normalizeLogRules(sessionLogRules), updated: now }], assign: emptyAssign() };
  return { version: TAGS_VERSION, tags: [{ name: COMMON, rules: DEFAULT_LOG_RULES, updated: now }], assign: emptyAssign(), defaults: DEFAULTS_REV };
}

export const serializeTags = (s: TagStore) => JSON.stringify(s, null, 2);

// Error codes of the Go SaveTags (tags.go TagsErr*): its error text starts with
// "[CODE] ". Tell the cases apart with tagsErrorCode, not by the Korean words.
export const TAGS_ERR = {
  INVALID: "TAGS_INVALID", // the data sent is not a valid tag store
  NEWER_FORMAT: "TAGS_NEWER_FORMAT", // the data sent has a version this build doesn't know
  NEWER_ON_DISK: "TAGS_NEWER_ON_DISK", // tags.json on disk was written by a newer chipper
  BACKUP: "TAGS_BACKUP_FAILED", // .bak/.bak2 could not be kept, nothing written
  NO_DATA_DIR: "TAGS_NO_DATA_DIR",
} as const;
export function tagsErrorCode(e: unknown): string {
  const m = /^\[([A-Z_]+)\] /.exec(String((e as any)?.message ?? e));
  return m ? m[1] : "";
}

// --- which tags apply to a file ------------------------------------------------

export interface BundleRef {
  root: string;
  servers: string[];
}

const isWin = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
// Lower-case without changing the length ("İ".toLowerCase() is two characters,
// which would shift every index after it).
const fold = (s: string) =>
  s.replace(/[A-Z]|[^\x00-\x7f]/g, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  });

// The bundle server and the "/"-path under it, when `path` lies inside a
// bundle server folder; null otherwise.
export function bundleRel(path: string, bundle: BundleRef | null | undefined): { server: string; rel: string } | null {
  if (!bundle || !path) return null;
  const win = isWin(bundle.root) || isWin(path);
  const norm = (p: string) => (win ? fold(p.replace(/\\/g, "/")) : p);
  const root = norm(bundle.root).replace(/\/+$/, "");
  const p = norm(path);
  if (!(p.length > root.length + 1 && p.startsWith(root) && p[root.length] === "/")) return null;
  // keep the original case of the part after the root
  const rest = path.replace(/\\/g, "/").slice(root.length + 1).split("/").filter(Boolean);
  if (rest.length < 2) return null; // a file directly in the bundle folder belongs to no server
  if (rest.some((x) => x === "." || x === "..")) return null; // not a plain path under the server
  const server = bundle.servers.find((s) => (win ? fold(s) === fold(rest[0]) : s === rest[0]));
  if (!server) return null;
  return { server, rel: rest.slice(1).join("/") };
}

// Assignment lookup: exact key first; for a Windows path (case-insensitive file
// system) then a case-insensitive match. Linux paths match exactly only —
// "logs" and "Logs" are different folders there.
function lookup(map: Record<string, string[]>, key: string, win: boolean): [string, string[]] | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return [key, map[key]];
  if (!win) return undefined;
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
// `bundle` may also be a list (the current bundle first, then bundles opened
// earlier): the first one the path lies in is used, so a tab opened from an
// earlier bundle keeps its folder/file tags after switching bundles.
export function tagsFor(store: TagStore, path: string, bundle?: BundleRef | BundleRef[] | null): AppliedTags {
  const exists = new Set(store.tags.map((t) => t.name));
  const pick = (v: string[], source: TagSource): AppliedTags => ({
    names: [COMMON, ...v.filter((n, i) => n !== COMMON && exists.has(n) && v.indexOf(n) === i)],
    source,
  });
  let br: { server: string; rel: string } | null = null;
  let win = isWin(path);
  for (const b of Array.isArray(bundle) ? bundle : bundle ? [bundle] : []) {
    br = bundleRel(path, b);
    if (br) {
      win = win || isWin(b.root);
      break;
    }
  }
  if (br) {
    const fileKey = rotationKey(br.rel);
    const direct = lookup(store.assign.file, fileKey, win);
    if (direct) return pick(direct[1], { kind: "file", key: direct[0] });
    const parts = br.rel.split("/");
    for (let n = parts.length - 1; n >= 0; n--) {
      const key = parts.slice(0, n).join("/");
      const v = lookup(store.assign.dir, key, win);
      if (v) return pick(v[1], { kind: "dir", key: v[0] });
    }
    return pick([], { kind: "none" });
  }
  const base = path.split(/[\\/]/).pop() || "";
  if (base) {
    const key = rotationKey(base);
    const v = lookup(store.assign.name, key, win);
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

// The same rules in layers for the highlighter (logHighlighter): one layer per
// applied tag, highest priority first, common last. Between layers the higher
// wins; inside a layer colours behave as in v1.2.0 (see logHighlight.ts).
export function layersFor(store: TagStore, names: string[]): LogRule[][] {
  const byName = new Map(store.tags.map((t) => [t.name, t]));
  const order = [...names.filter((n) => n !== COMMON), ...(names.includes(COMMON) ? [COMMON] : [])];
  return order.map((n) => byName.get(n)?.rules ?? []);
}

// common in the old session format (`logRules`, regex true/false), written to
// the session on every save so that going back to v1.2.0 still shows the
// user's rules. 「글자 그대로」 becomes an escaped regex, 「단어」 regex:false.
// Edits made in v1.2.0 are NOT read back: once tags.json exists it wins.
export function legacyLogRules(store: TagStore): object[] {
  const common = store.tags.find((t) => t.name === COMMON);
  return (common?.rules ?? []).map((r) => ({
    id: r.id,
    on: r.on,
    label: r.label,
    pattern: r.kind === "text" ? r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : r.pattern,
    regex: r.kind !== "word",
    caseSensitive: r.caseSensitive,
    color: r.color,
    line: r.line,
    filter: r.filter,
  }));
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
