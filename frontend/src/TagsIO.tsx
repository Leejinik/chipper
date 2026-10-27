import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { COMMON, TAGS_ERR, normalizeTagStore, serializeTags, tagsErrorCode, type TagStore } from "./logTags";
import {
  exportAssign,
  exportFileName,
  exportPayload,
  importLimitProblem,
  placeCount,
  runImport,
  summaryDetails,
  summaryLine,
  type ImportChoice,
  type ImportConflict,
  type ImportFile,
  type ImportSummary,
} from "./logTagsIO";
import { BackupTagsBefore, ExportTagsDialog, ExportTagsTo, ImportTagsDialog, ListTagsBackups, ReadTagsBackup } from "../wailsjs/go/main/App";
import type { main } from "../wailsjs/go/models";

// Tag export / import / 「가져오기 전으로 되돌리기」 for the tag window
// (TagsDialog): its buttons, the result band, and the small windows over it
// (export, clash question, backups). Kept apart from TagsDialog so the tag
// window itself only wires it in.
//
// Order of an import: write pending edits (stop if that fails) → pick files →
// questions (the window under them is inert) → keep the store as it is in
// tags-backup/before-import-<time>.json (stop if that fails) → apply + save
// (on failure the window goes back to the store before the import).

interface Opts {
  store: TagStore;
  onChange: (s: TagStore) => void;
  // write the tags now (`next` first, when given): "" = saved, else why not
  onSaveNow: (next?: TagStore) => Promise<string>;
  current: string; // tag selected in the window
  select: (name: string) => void;
}

interface ExportState {
  checked: string[];
  name: string; // file name typed (used once typed)
  typed: boolean;
  withAssign: boolean; // 「붙인 곳도 같이」
}

interface ImportResult {
  summary: ImportSummary;
  before: TagStore;
  after: TagStore; // undo only while the store is still this
  backup: string; // tags-backup file holding `before` ("" = nothing changed)
}

// Error text without "Error: " and the Go error code ("[TAGS_…] ").
const rawErr = (e: unknown) => String((e as any)?.message ?? e).replace(/^(Error: )+/, "");
const errText = (e: unknown) => rawErr(e).replace(/^\[[A-Z_]+\] /, "");
// Told by the Go error code, not by words (tags.go TagsErr*).
const newerHint = (e: unknown) => {
  const c = tagsErrorCode(rawErr(e));
  return c === TAGS_ERR.NEWER_ON_DISK || c === TAGS_ERR.NEWER_FORMAT ? " 더 새 버전의 chipper 가 쓴 태그 파일입니다 — chipper 를 업데이트한 뒤 다시 하세요." : "";
};
const KEEP_NOTE = "종류마다 최근 5개 보관"; // tags_backup.go keepTagsBackups

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A small modal window over the tag window: everything else in the tag window
// is inert while it is up, Tab stays inside, focus returns where it was.
function SubPanel({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const overlay = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ov = overlay.current;
    const prev = document.activeElement as HTMLElement | null;
    const others = ov?.parentElement ? ([...ov.parentElement.children] as HTMLElement[]).filter((e) => e !== ov) : [];
    const was = others.map((e) => e.hasAttribute("inert"));
    others.forEach((e) => e.setAttribute("inert", ""));
    (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current)?.focus();
    // a browser without `inert`: pull the focus back in
    const onFocusIn = (e: FocusEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) box.current.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      others.forEach((e, i) => (was[i] ? e.setAttribute("inert", "") : e.removeAttribute("inert")));
      if (prev?.isConnected) prev.focus();
    };
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? i <= 0 : i < 0 || i === f.length - 1) {
      e.preventDefault();
      (e.shiftKey ? f[f.length - 1] : f[0]).focus();
    }
  };
  return (
    <div className="tags-sub-overlay" ref={overlay} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={box} className={"tags-sub " + className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}

function DiffList({ title, sign, items }: { title: string; sign: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="tags-diff-group">
      <b>
        {title} {items.length}
      </b>
      <ul>
        {items.slice(0, 5).map((x, i) => (
          <li key={i}>
            {sign} {x}
          </li>
        ))}
        {items.length > 5 && <li className="dim">외 {items.length - 5}개</li>}
      </ul>
    </div>
  );
}

export function useTagsIO({ store, onChange, onSaveNow, current, select }: Opts) {
  const storeRef = useRef(store);
  storeRef.current = store;
  const [exporting, setExporting] = useState<ExportState | null>(null);
  const [conflict, setConflict] = useState<{
    c: ImportConflict;
    resolve: (a: { choice: ImportChoice; all: boolean } | null) => void;
  } | null>(null);
  const [conflictAll, setConflictAll] = useState(false);
  const [restoring, setRestoring] = useState<{ list: main.TagsBackupInfo[] | null; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ioMsg, setIoMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const exportingRef = useRef(exporting);
  exportingRef.current = exporting;
  const restoringRef = useRef(restoring);
  restoringRef.current = restoring;
  // window closed with a clash question up (e.g. by the app): stop that import
  useEffect(() => () => conflictRef.current?.resolve(null), []);

  // Esc with one of the small windows up closes only it (a clash question:
  // stops the import) — before the tag window's own Esc (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (conflictRef.current) {
        conflictRef.current.resolve(null);
        setConflict(null);
      } else if (exportingRef.current) setExporting(null);
      else if (restoringRef.current) setRestoring(null);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Apply `next` and write it; when the write fails, go back to `prev` (the
  // window never shows what is not on disk). "" = saved, else why not.
  const commit = async (next: TagStore, prev: TagStore): Promise<string> => {
    onChange(next);
    storeRef.current = next;
    const err = await onSaveNow(next);
    if (err) {
      onChange(prev);
      storeRef.current = prev;
    }
    return err;
  };
  // Pending edits first: what follows starts from what is on disk.
  const saveFirst = async (what: string): Promise<boolean> => {
    const pre = await onSaveNow();
    if (pre) setIoMsg({ text: `지금 태그를 먼저 저장하지 못해 ${what} 않았습니다(바뀐 것 없음): ${errText(pre)}.${newerHint(pre)}`, bad: true });
    return !pre;
  };

  // ---- export
  const names = store.tags.map((t) => t.name);
  const exportNames = exporting ? names.filter((n) => exporting.checked.includes(n)) : [];
  const exportName = exporting ? (exporting.typed ? exporting.name : exportNames.length === 1 ? exportNames[0] : "") : "";
  const exportFile = exportFileName(exportName);
  const exportPlaces = exporting ? placeCount(exportAssign(store, exportNames)) : 0;
  const startExport = () => {
    setIoMsg(null);
    setRestoring(null);
    setExporting({ checked: [current], name: "", typed: false, withAssign: false });
  };
  const doExport = async () => {
    if (!exporting || !exportNames.length || !exportFile || busy) return;
    // what the receiver could not import is not written
    const limit = importLimitProblem(store.tags.filter((t) => exportNames.includes(t.name)));
    if (limit) {
      setIoMsg({ text: "받는 쪽에서 가져올 수 없는 크기라 내보내지 않았습니다: " + limit.replace(/ — 이 파일은 가져오지 않습니다$/, ""), bad: true });
      return;
    }
    const withAssign = exporting.withAssign && exportPlaces > 0;
    const payload = exportPayload(store, exportNames, undefined, withAssign);
    setBusy(true);
    try {
      const r = await ExportTagsDialog(exportFile, payload);
      let path = r?.path ?? "";
      if (path && r.confirm) {
        // the name was completed to .chipper-tags.json and that file exists
        const base = path.split(/[\\/]/).pop();
        if (!window.confirm(`「${base}」 파일이 이미 있습니다. 덮어쓸까요?\n${path}`)) {
          setIoMsg({ text: `내보내기를 그만뒀습니다. 「${base}」 는 그대로입니다.` });
          return;
        }
        path = await ExportTagsTo(path, payload);
      }
      if (path) {
        setExporting(null);
        setIoMsg({
          text:
            `태그 ${exportNames.length}개(${exportNames.map((n) => `「${n}」`).join(", ")})` +
            (withAssign ? `와 붙인 곳 ${exportPlaces}곳` : "") +
            `를 ${path} 로 내보냈습니다.`,
        });
      }
    } catch (e) {
      setIoMsg({ text: "내보내기 실패: " + errText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  // ---- import
  const ask = (c: ImportConflict) =>
    new Promise<{ choice: ImportChoice; all: boolean } | null>((resolve) => {
      setConflictAll(false);
      setConflict({ c, resolve });
    });
  const answer = (choice: ImportChoice) => {
    if (!conflict) return;
    conflict.resolve({ choice, all: conflictAll });
    setConflict(null);
  };
  const doImport = async () => {
    if (busy) return;
    setIoMsg(null);
    setExporting(null);
    setRestoring(null);
    setBusy(true);
    try {
      if (!(await saveFirst("가져오지"))) return;
      let files: ImportFile[] | null;
      try {
        files = (await ImportTagsDialog()) as ImportFile[] | null;
      } catch (e) {
        setIoMsg({ text: "가져오기 실패: " + errText(e), bad: true });
        return;
      }
      if (!files || !files.length) return;
      const before = storeRef.current;
      const { store: after, summary } = await runImport(before, files, ask);
      if (summary.canceled) {
        setIoMsg({ text: "가져오기를 그만뒀습니다. 바뀐 것은 없습니다." });
        return;
      }
      if (storeRef.current !== before) {
        // the window under the questions is inert; this is the safety net
        setIoMsg({ text: "가져오는 동안 태그가 바뀌어 가져오기를 그만뒀습니다(바뀐 것 없음). 다시 가져오세요.", bad: true });
        return;
      }
      let backup = "";
      if (after !== before) {
        try {
          backup = await BackupTagsBefore("import", serializeTags(before));
        } catch (e) {
          setIoMsg({ text: `가져오기 직전 태그를 백업하지 못해 가져오지 않았습니다(바뀐 것 없음): ${errText(e)}`, bad: true });
          return;
        }
        const err = await commit(after, before);
        if (err) {
          setIoMsg({ text: `가져온 태그를 tags.json 에 저장하지 못해 가져오기 전으로 되돌렸습니다(바뀐 것 없음): ${errText(err)}.${newerHint(err)}`, bad: true });
          return;
        }
        const first = summary.added[0] ?? summary.renamed[0]?.to ?? summary.overwritten[0];
        if (first) select(first);
      }
      setResult({ summary, before, after, backup });
    } finally {
      setBusy(false);
    }
  };
  const canUndo = !!result && result.after !== result.before && store === result.after;
  const undoImport = async () => {
    if (!result || !canUndo || busy) return;
    setBusy(true);
    try {
      const err = await commit(result.before, result.after);
      if (err) {
        setIoMsg({ text: `가져오기 전으로 되돌리지 못했습니다(가져온 그대로): ${errText(err)}.${newerHint(err)}`, bad: true });
        return;
      }
      if (!result.before.tags.some((t) => t.name === current)) select(COMMON);
      setResult(null);
      setIoMsg({ text: "가져오기 전으로 되돌렸습니다." });
    } finally {
      setBusy(false);
    }
  };

  // ---- 가져오기 전으로 되돌리기 (backups in tags-backup)
  const openRestore = async () => {
    setIoMsg(null);
    setExporting(null);
    setRestoring({ list: null, error: "" });
    try {
      setRestoring({ list: (await ListTagsBackups()) ?? [], error: "" });
    } catch (e) {
      setRestoring({ list: [], error: "백업 목록을 읽지 못했습니다: " + errText(e) });
    }
  };
  const restoreFrom = async (b: main.TagsBackupInfo) => {
    if (busy) return;
    const when = `${b.time} ${b.kind === "import" ? "가져오기" : "되돌리기"} 직전`;
    if (!window.confirm(`태그를 ${when} 상태로 되돌릴까요?\n태그와 붙인 곳이 모두 그때 상태(태그 ${b.tags}개, 붙인 곳 ${b.places}곳)로 바뀝니다. 지금 상태는 따로 백업해 둡니다.`))
      return;
    setBusy(true);
    try {
      let next: TagStore;
      try {
        next = normalizeTagStore(JSON.parse(await ReadTagsBackup(b.file)));
      } catch (e) {
        setRestoring((r) => r && { ...r, error: `${b.file} 를 읽지 못했습니다: ${errText(e)}` });
        return;
      }
      if (!(await saveFirst("되돌리지"))) return;
      const cur = storeRef.current;
      let kept = "";
      try {
        kept = await BackupTagsBefore("restore", serializeTags(cur));
      } catch (e) {
        setIoMsg({ text: `지금 태그를 백업하지 못해 되돌리지 않았습니다(바뀐 것 없음): ${errText(e)}`, bad: true });
        return;
      }
      const err = await commit(next, cur);
      if (err) {
        setIoMsg({ text: `되돌린 태그를 tags.json 에 저장하지 못해 그대로 두었습니다(바뀐 것 없음): ${errText(err)}.${newerHint(err)}`, bad: true });
        return;
      }
      setRestoring(null);
      setResult(null);
      if (!next.tags.some((t) => t.name === current)) select(COMMON);
      setIoMsg({ text: `${when} 상태(${b.file})로 되돌렸습니다. 되돌리기 직전 태그는 tags-backup 폴더의 ${kept} 에 남겼습니다.` });
    } finally {
      setBusy(false);
    }
  };

  // ---- pieces for the tag window
  const buttons = (
    <div className="tags-side-actions tags-io-actions">
      <button className="tb-btn tags-export" disabled={busy} title="고른 태그를 파일 하나로 내보냅니다 (다른 사람에게 주기)" onClick={startExport}>
        내보내기…
      </button>
      <button className="tb-btn tags-import" disabled={busy} title="태그 파일을 가져옵니다 (여러 파일 선택 가능)" onClick={() => void doImport()}>
        가져오기…
      </button>
      <button
        className="tb-btn tags-restore"
        disabled={busy}
        title={`태그를 가져오기(또는 되돌리기) 직전 상태로 되돌립니다 (${KEEP_NOTE})`}
        onClick={() => void openRestore()}
      >
        가져오기 전으로 되돌리기…
      </button>
    </div>
  );

  const banner = (
    <>
      {ioMsg && (
        <div className={"tags-io-msg" + (ioMsg.bad ? " bad" : "")}>
          <span>{ioMsg.text}</span>
          <button className="mp-x" title="닫기" onClick={() => setIoMsg(null)}>
            ✕
          </button>
        </div>
      )}
      {result && (
        <div className="tags-import-result">
          <div className="tags-import-head">
            <b>가져오기 결과</b>
            <span className="tags-import-line">{summaryLine(result.summary)}</span>
            {result.after !== result.before && (
              <button
                className="tb-btn tags-undo"
                disabled={!canUndo || busy}
                title={canUndo ? "이번 가져오기를 통째로 취소합니다" : "가져온 뒤 태그를 고쳐서 여기서는 되돌릴 수 없습니다 — 「가져오기 전으로 되돌리기…」를 쓰세요"}
                onClick={() => void undoImport()}
              >
                되돌리기
              </button>
            )}
            <button className="mp-x" title="닫기" onClick={() => setResult(null)}>
              ✕
            </button>
          </div>
          <ul className="tags-import-details">
            {summaryDetails(result.summary).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {result.backup && (
              <li className="dim tags-import-backup">
                가져오기 직전 태그는 tags-backup 폴더의 {result.backup} 에 남겼습니다 — 「가져오기 전으로 되돌리기…」로 언제든 되돌릴 수 있습니다({KEEP_NOTE}).
              </li>
            )}
          </ul>
        </div>
      )}
    </>
  );

  const c = conflict?.c;
  const panels = (
    <>
      {exporting && (
        <SubPanel className="tags-export-panel" label="태그 내보내기">
          <div className="chips-title">태그 내보내기</div>
          <div className="chips-sub">고른 태그와 그 규칙을 파일 하나로 저장합니다.</div>
          <div className="tags-export-list">
            {store.tags.map((t) => (
              <label key={t.name} className="tags-export-item">
                <input
                  type="checkbox"
                  data-tag={t.name}
                  checked={exporting.checked.includes(t.name)}
                  onChange={(e) =>
                    setExporting({
                      ...exporting,
                      checked: e.target.checked ? [...exporting.checked, t.name] : exporting.checked.filter((n) => n !== t.name),
                    })
                  }
                />
                <span className="tag-name">{t.name}</span>
                <span className="tag-count">규칙 {t.rules.length}</span>
              </label>
            ))}
          </div>
          <label className="tags-export-assign" title="고른 태그를 붙인 폴더·파일(모든 서버의 같은 경로)도 파일에 넣습니다">
            <input
              type="checkbox"
              className="tags-export-assign-box"
              checked={exporting.withAssign}
              disabled={!exportPlaces}
              onChange={(e) => setExporting({ ...exporting, withAssign: e.target.checked })}
            />
            <span>
              붙인 곳도 같이 ({exportPlaces}곳)
              <span className="dim"> — 받는 사람에게 이미 지정이 있는 곳은 그 사람 것이 남습니다</span>
            </span>
          </label>
          <label className="tags-export-name">
            <span>파일 이름</span>
            <input
              className="tags-export-file"
              data-autofocus
              value={exportName}
              placeholder={exportNames.length > 1 ? "여러 태그 — 파일 이름을 정해 주세요" : "파일 이름"}
              onChange={(e) => setExporting({ ...exporting, name: e.target.value, typed: true })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doExport();
              }}
            />
            <span className="dim tags-export-preview">{exportFile || "(이름 필요)"}</span>
          </label>
          <div className="chips-actions">
            <button className="tb-btn" onClick={() => setExporting(null)}>
              취소
            </button>
            <button
              className="tb-btn primary tags-export-go"
              disabled={busy || !exportNames.length || !exportFile}
              title={!exportNames.length ? "내보낼 태그를 하나 이상 고르세요" : !exportFile ? "파일 이름을 정해 주세요" : "저장할 곳을 고릅니다"}
              onClick={() => void doExport()}
            >
              내보내기…
            </button>
          </div>
        </SubPanel>
      )}
      {conflict && c && (
        <SubPanel key={c.file + "\u0000" + c.name} className="tags-conflict" label="태그 덮어쓰기 질문">
          <div className="chips-title tags-conflict-q">
            {c.mineFrom ? `「${c.name}」 태그를 방금 가져왔습니다. 덮어쓰시겠습니까?` : `「${c.name}」 태그가 이미 있습니다. 덮어쓰시겠습니까?`}
          </div>
          <div className="chips-sub tags-conflict-text">
            가져올 파일 {c.file} 의 「{c.name}」(규칙 {c.theirs}개)이{" "}
            {c.mineFrom ? `방금 ${c.mineFrom} 에서 가져온 「${c.name}」(규칙 ${c.mine}개)` : `내 「${c.name}」(규칙 ${c.mine}개)`}과 내용이 다릅니다.
            {c.dropped > 0 && ` 가져올 파일의 이 태그 규칙 중 ${c.dropped}개는 잘못돼 빼고 셌습니다(덮어써도 들어오지 않습니다).`}
            {c.isCommon && " common 은 모든 로그에 쓰이는 태그라, 덮어쓰면 모든 로그의 색이 바뀝니다."} 덮어써도 가져오기가 끝난 뒤
            「되돌리기」로 통째로 취소할 수 있고, 가져오기 직전 태그는 tags-backup 폴더에 따로 남습니다(「가져오기 전으로 되돌리기…」).
          </div>
          <div className={"tags-conflict-diff" + (c.isCommon ? " common" : "")}>
            <div className="tags-diff-line">
              규칙 차이: 추가 {c.diff.added.length} · 빠짐 {c.diff.removed.length} · 바뀜 {c.diff.changed.length}
              {c.diff.reordered && " · 순서 다름"}
              {c.dropped > 0 && ` · 잘못돼 뺀 규칙 ${c.dropped}`}
            </div>
            <DiffList title="가져오면 생김" sign="+" items={c.diff.added} />
            <DiffList title="가져오면 없어짐" sign="−" items={c.diff.removed} />
            <DiffList title="바뀜" sign="~" items={c.diff.changed} />
            {c.diff.reordered && <div className="dim">규칙 순서가 다릅니다(같은 글자에 여러 규칙이 걸리면 순서가 색을 정합니다).</div>}
          </div>
          {c.left > 0 && (
            <label className="tags-conflict-all">
              <input type="checkbox" checked={conflictAll} onChange={(e) => setConflictAll(e.target.checked)} />
              나머지 {c.left}개도 모두 같게
            </label>
          )}
          <div className="chips-actions">
            <button className="tb-btn primary tags-c-overwrite" onClick={() => answer("overwrite")}>
              덮어쓰기
            </button>
            <button className="tb-btn tags-c-skip" onClick={() => answer("skip")}>
              건너뛰기
            </button>
            <button className="tb-btn tags-c-rename" title={`「${c.renameTo}」 로 추가합니다`} onClick={() => answer("rename")}>
              다른 이름으로 ({c.renameTo})
            </button>
          </div>
          <div className="dim tags-conflict-esc">Esc: 가져오기 그만두기 (아무것도 바꾸지 않음)</div>
        </SubPanel>
      )}
      {restoring && (
        <SubPanel className="tags-restore-panel" label="가져오기 전으로 되돌리기">
          <div className="chips-title">가져오기 전으로 되돌리기</div>
          <div className="chips-sub">
            태그를 가져오거나 되돌리기 직전에 남긴 백업입니다({KEEP_NOTE}). 고르면 태그와 붙인 곳이 모두 그때 상태로 바뀝니다.
          </div>
          {restoring.error && <div className="tags-import-save">{restoring.error}</div>}
          {restoring.list === null ? (
            <div className="dim">불러오는 중…</div>
          ) : restoring.list.length === 0 ? (
            <div className="dim tags-restore-empty">백업이 없습니다. 태그를 가져오면 그 직전 상태가 여기 남습니다.</div>
          ) : (
            <div className="tags-restore-list">
              {restoring.list.map((b) => (
                <div className="tags-restore-item" key={b.file} data-file={b.file}>
                  <div className="tags-restore-info">
                    <b>{b.time}</b> {b.kind === "import" ? "가져오기 직전" : "되돌리기 직전"}
                    <div className="dim">
                      {b.problem ||
                        `태그 ${b.tags}개 (${b.names.join(", ")}${b.tags > b.names.length ? " …" : ""}) · 붙인 곳 ${b.places}곳 · ${b.file}`}
                    </div>
                  </div>
                  <button className="tb-btn tags-restore-go" disabled={busy || !!b.problem} onClick={() => void restoreFrom(b)}>
                    되돌리기
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chips-actions">
            <button className="tb-btn" onClick={() => setRestoring(null)}>
              닫기
            </button>
          </div>
        </SubPanel>
      )}
    </>
  );

  return { buttons, banner, panels, blocking: busy || !!conflict || !!exporting || !!restoring };
}
