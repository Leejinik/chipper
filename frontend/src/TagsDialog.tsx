import { useEffect, useRef, useState } from "react";
import { DEFAULT_LOG_RULES, ruleProblem, type LogRule, type RuleKind } from "./logHighlight";
import {
  COMMON,
  addTag,
  deleteTag,
  placesOf,
  renameTag,
  setTagRules,
  tagNameProblem,
  uniqueTagName,
  type TagStore,
} from "./logTags";
import {
  exportFileName,
  exportPayload,
  runImport,
  summaryDetails,
  summaryLine,
  type ImportChoice,
  type ImportConflict,
  type ImportFile,
  type ImportSummary,
} from "./logTagsIO";
import { ExportTagsDialog, ImportTagsDialog } from "../wailsjs/go/main/App";

// The log colour tag window (was the 「로그 색 규칙」 dialog): tag list on the
// left, the selected tag's rules on the right.

const KIND_LABEL: Record<RuleKind, string> = { text: "글자 그대로", word: "단어", regex: "정규식" };
const KIND_HINT: Record<RuleKind, string> = {
  text: "글자 (예: kafka rebalance)",
  word: "단어 (예: timeout)",
  regex: "정규식 (예: \\bTIMEOUT\\b)",
};

const ruleId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function newRule(): LogRule {
  return {
    id: ruleId(),
    on: true,
    label: "",
    pattern: "",
    kind: "text",
    caseSensitive: false,
    color: "#c678dd",
    line: false,
    filter: true,
  };
}

function placeLabel(kind: "dir" | "file" | "name", key: string): string {
  if (kind === "dir") return key === "" ? "📁 모든 서버의 전체 (서버 폴더 아래 모든 파일)" : `📁 모든 서버의 ${key}`;
  if (kind === "file") return `📄 모든 서버의 ${key}`;
  return `🏷 이름이 「${key}」 인 파일 (로그 묶음 밖)`;
}

interface Props {
  store: TagStore;
  onChange: (s: TagStore) => void;
  onClose: () => void;
  initial: string; // tag selected when the window opens
  applied: string[]; // tags applied to the current tab (marked in the list)
  notice: string; // save problem / read-only notice ("" = none)
  // Write the tags now (optionally `next` first): "" = saved (or nothing to
  // save), otherwise why not. Used around an import so tags.json.bak is the
  // store right before it.
  onSaveNow: (next?: TagStore) => Promise<string>;
}

interface ExportState {
  checked: string[];
  name: string; // file name typed (used once typed)
  typed: boolean;
}

interface ImportResult {
  summary: ImportSummary;
  before: TagStore;
  after: TagStore; // undo only while the store is still this
  saveError: string;
}

export default function TagsDialog({ store, onChange, onClose, initial, applied, notice, onSaveNow }: Props) {
  const names = store.tags.map((t) => t.name);
  const [sel, setSel] = useState<string>(names.includes(initial) ? initial : COMMON);
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [nameErr, setNameErr] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const tag = store.tags.find((t) => t.name === sel) ?? store.tags[0];
  const rules = tag.rules;
  const isCommon = tag.name === COMMON;
  const storeRef = useRef(store);
  storeRef.current = store;

  // --- export / import state
  const [exporting, setExporting] = useState<ExportState | null>(null);
  const [conflict, setConflict] = useState<{
    c: ImportConflict;
    resolve: (a: { choice: ImportChoice; all: boolean } | null) => void;
  } | null>(null);
  const [conflictAll, setConflictAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ioMsg, setIoMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const exportingRef = useRef(exporting);
  exportingRef.current = exporting;
  // window closed with a clash question up (e.g. by the app): stop that import
  useEffect(() => () => conflictRef.current?.resolve(null), []);

  // Esc closes the window wherever the focus is (not while renaming a tag);
  // with a clash question up it stops the import, with the export panel up it
  // closes only that panel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.classList?.contains("tag-rename")) return;
      e.preventDefault();
      if (conflictRef.current) {
        conflictRef.current.resolve(null);
        setConflict(null);
        return;
      }
      if (exportingRef.current) {
        setExporting(null);
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming?.from]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRules = (f: (prev: LogRule[]) => LogRule[]) => onChange(setTagRules(store, tag.name, f(rules)));
  const upd = (id: string, patch: Partial<LogRule>) => setRules((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const startRename = (name: string) => {
    if (name === COMMON) return;
    setNameErr("");
    setRenaming({ from: name, value: name });
  };
  const commitRename = () => {
    if (!renaming) return;
    const v = renaming.value;
    if (v === renaming.from) {
      setRenaming(null);
      return;
    }
    const p = tagNameProblem(v, names.filter((n) => n !== renaming.from));
    if (p) {
      setNameErr(p);
      return;
    }
    onChange(renameTag(store, renaming.from, v));
    if (sel === renaming.from) setSel(v);
    setRenaming(null);
    setNameErr("");
  };
  const create = () => {
    const name = uniqueTagName("새 태그", names);
    onChange(addTag(store, name));
    setSel(name);
    setNameErr("");
    setRenaming({ from: name, value: name });
  };
  const duplicate = () => {
    const name = uniqueTagName(`${tag.name} 복사`, names);
    onChange(addTag(store, name, tag.rules.map((r) => ({ ...r }))));
    setSel(name);
  };
  const remove = () => {
    const where = placesOf(store, tag.name).length;
    const msg =
      `「${tag.name}」 태그를 지울까요? 규칙 ${tag.rules.length}개가 사라집니다.` +
      (where ? `\n붙어 있던 ${where}곳에서도 빠집니다.` : "");
    if (!window.confirm(msg)) return;
    onChange(deleteTag(store, tag.name));
    setSel(COMMON);
  };
  const clearCommon = () => {
    if (!rules.length) return;
    if (window.confirm(`common 태그의 규칙 ${rules.length}개를 모두 지울까요? (common 은 모든 로그에 쓰이는 태그라 지울 수 없고 비우기만 됩니다)`))
      setRules(() => []);
  };

  const places = placesOf(store, tag.name);

  // ---- export
  const exportNames = exporting ? names.filter((n) => exporting.checked.includes(n)) : [];
  const exportName = exporting ? (exporting.typed ? exporting.name : exportNames.length === 1 ? exportNames[0] : "") : "";
  const exportFile = exportFileName(exportName);
  const startExport = () => {
    setIoMsg(null);
    setExporting({ checked: [tag.name], name: "", typed: false });
  };
  const doExport = async () => {
    if (!exporting || !exportNames.length || !exportFile || busy) return;
    setBusy(true);
    try {
      const path = await ExportTagsDialog(exportFile, exportPayload(store, exportNames));
      if (path) {
        setExporting(null);
        setIoMsg({ text: `태그 ${exportNames.length}개(${exportNames.map((n) => `「${n}」`).join(", ")})를 ${path} 로 내보냈습니다.` });
      }
    } catch (e) {
      setIoMsg({ text: "내보내기 실패: " + String(e), bad: true });
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
    setBusy(true);
    try {
      let files: ImportFile[] | null;
      try {
        files = (await ImportTagsDialog()) as ImportFile[] | null;
      } catch (e) {
        setIoMsg({ text: "가져오기 실패: " + String(e), bad: true });
        return;
      }
      if (!files || !files.length) return;
      // pending edits first, so tags.json.bak ends up being exactly the store
      // right before this import
      await onSaveNow();
      const before = storeRef.current;
      const { store: after, summary } = await runImport(before, files, ask);
      if (summary.canceled) {
        setIoMsg({ text: "가져오기를 그만뒀습니다. 바뀐 것은 없습니다." });
        return;
      }
      let saveError = "";
      if (after !== before) {
        onChange(after);
        storeRef.current = after;
        const err = await onSaveNow(after);
        if (err)
          saveError =
            `가져온 태그를 tags.json 에 저장하지 못했습니다: ${err}. 이번 실행 동안에는 쓰이지만 다시 켜면 사라집니다.` +
            (/새 버전|newer|version/i.test(err) ? " 디스크의 tags.json 이 더 새 버전 chipper 의 것이면 chipper 를 업데이트한 뒤 다시 가져오세요." : "");
        const first = summary.added[0] ?? summary.renamed[0]?.to ?? summary.overwritten[0];
        if (first) setSel(first);
      }
      setResult({ summary, before, after, saveError });
    } finally {
      setBusy(false);
    }
  };
  const canUndo = !!result && result.after !== result.before && store === result.after;
  const undoImport = async () => {
    if (!result || !canUndo) return;
    onChange(result.before);
    storeRef.current = result.before;
    const err = await onSaveNow(result.before);
    if (!result.before.tags.some((t) => t.name === sel)) setSel(COMMON);
    setResult(null);
    setIoMsg(err ? { text: "가져오기 전으로 되돌렸지만 저장하지 못했습니다: " + err, bad: true } : { text: "가져오기 전으로 되돌렸습니다." });
  };

  return (
    <div className="chips-overlay" onMouseDown={() => !conflict && !busy && onClose()}>
      <div
        className="keys-dialog rules-dialog tags-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="chips-title">🏷 로그 색 태그</div>
        <div className="chips-sub">
          태그는 로그 색 규칙 묶음입니다. common 은 모든 로그에, 다른 태그는 붙인 곳의 로그에만 쓰입니다. 같은 글자에 두 규칙이 걸리면
          태그 쪽 색이 이깁니다. 태그 이름은 대소문자를 구분합니다(collector 와 Collector 는 다른 태그).
        </div>
        {notice && <div className="tags-notice">{notice}</div>}
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
                  disabled={!canUndo}
                  title={canUndo ? "이번 가져오기를 통째로 취소합니다" : "가져온 뒤 태그를 고쳐서 되돌릴 수 없습니다"}
                  onClick={() => void undoImport()}
                >
                  되돌리기
                </button>
              )}
              <button className="mp-x" title="닫기" onClick={() => setResult(null)}>
                ✕
              </button>
            </div>
            {result.saveError && <div className="tags-import-save">{result.saveError}</div>}
            <ul className="tags-import-details">
              {summaryDetails(result.summary).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
              {result.after !== result.before && !result.saveError && (
                <li className="dim">가져오기 전 태그는 tags.json.bak 에도 남아 있습니다.</li>
              )}
            </ul>
          </div>
        )}
        <div className="tags-body">
          <div className="tags-side">
            <div className="tags-list">
              {store.tags.map((t) =>
                renaming && renaming.from === t.name ? (
                  <input
                    key={t.name}
                    ref={renameInput}
                    className="tag-rename"
                    value={renaming.value}
                    autoFocus
                    onChange={(e) => {
                      setRenaming({ ...renaming, value: e.target.value });
                      setNameErr("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                        setNameErr("");
                      }
                    }}
                    onBlur={() => {
                      // keep the box open while the name is not acceptable
                      if (!tagNameProblem(renaming.value, names.filter((n) => n !== renaming.from)) || renaming.value === renaming.from)
                        commitRename();
                    }}
                  />
                ) : (
                  <button
                    key={t.name}
                    data-tag={t.name}
                    className={"tag-item" + (t.name === tag.name ? " sel" : "") + (applied.includes(t.name) ? " applied" : "")}
                    title={applied.includes(t.name) ? "지금 탭에 쓰이는 태그" : t.name}
                    onClick={() => {
                      setSel(t.name);
                      setRenaming(null);
                      setNameErr("");
                    }}
                    onDoubleClick={() => startRename(t.name)}
                  >
                    <span className="tag-name">{t.name}</span>
                    <span className="tag-count">{t.rules.length}</span>
                  </button>
                )
              )}
            </div>
            <div className="tags-name-error">{nameErr}</div>
            <div className="tags-side-actions">
              <button className="tb-btn" onClick={create}>
                ＋ 새 태그
              </button>
              <button className="tb-btn" disabled={isCommon} title={isCommon ? "common 은 이름을 바꿀 수 없습니다" : "이름 바꾸기 (더블클릭도 됨)"} onClick={() => startRename(tag.name)}>
                이름 바꾸기
              </button>
              <button className="tb-btn" onClick={duplicate}>
                복제
              </button>
              {isCommon ? (
                <button className="tb-btn" title="common 의 규칙을 모두 지웁니다 (태그는 남음)" onClick={clearCommon}>
                  비우기
                </button>
              ) : (
                <button className="tb-btn" onClick={remove}>
                  삭제
                </button>
              )}
            </div>
            <div className="tags-side-actions tags-io-actions">
              <button className="tb-btn tags-export" disabled={busy} title="고른 태그를 파일 하나로 내보냅니다 (다른 사람에게 주기)" onClick={startExport}>
                내보내기…
              </button>
              <button className="tb-btn tags-import" disabled={busy} title="태그 파일을 가져옵니다 (여러 파일 선택 가능)" onClick={() => void doImport()}>
                가져오기…
              </button>
            </div>
          </div>
          <div className="tags-main">
            <div className="tags-where">
              <b>어디에 붙어 있나</b>
              {isCommon ? (
                <span className="tags-place">모든 로그 (붙일 필요 없음)</span>
              ) : places.length ? (
                places.map((p) => (
                  <span className="tags-place" key={p.kind + ":" + p.key}>
                    {placeLabel(p.kind, p.key)}
                  </span>
                ))
              ) : (
                <span className="tags-place dim">아직 어디에도 붙어 있지 않습니다</span>
              )}
            </div>
            <div className="chips-sub tags-rules-sub">
              위 규칙부터 칠합니다. 「글자 그대로」는 넣은 글자가 들어간 곳 전부(공백 포함 가능), 「단어」는 앞뒤가 글자·숫자가 아닐 때만,
              「정규식」은 JavaScript 정규식입니다. 「줄만」은 태그에 걸린 줄만 보는 화면에서 이 규칙을 쓸지입니다.
            </div>
            <div className="rules-list">
              {rules.length === 0 && <div className="tags-place dim">규칙이 없습니다. ＋ 규칙 추가로 만드세요.</div>}
              {rules.map((r, i) => {
                const problem = ruleProblem(r);
                return (
                  <div className={r.on ? "rule-row" : "rule-row off"} key={r.id}>
                    <input type="checkbox" checked={r.on} title="이 규칙 켜기" onChange={(e) => upd(r.id, { on: e.target.checked })} />
                    <input className="rule-label" value={r.label} placeholder="이름" onChange={(e) => upd(r.id, { label: e.target.value })} />
                    <input
                      className={problem ? "rule-pattern bad" : "rule-pattern"}
                      value={r.pattern}
                      placeholder={KIND_HINT[r.kind]}
                      title={
                        problem === "slow"
                          ? "반복이 겹친 정규식(예: (a+)+, (a|aa)+)은 화면을 멈출 수 있어 쓰지 않습니다"
                          : problem === "invalid"
                            ? "정규식이 잘못됐거나 빈 문자열에 맞습니다 — 이 규칙은 쓰이지 않습니다"
                            : r.pattern
                      }
                      data-problem={problem}
                      style={{ color: r.color }}
                      onChange={(e) => upd(r.id, { pattern: e.target.value })}
                    />
                    <select className="rule-kind" value={r.kind} onChange={(e) => upd(r.id, { kind: e.target.value as RuleKind })}>
                      {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <label title="대소문자 구분">
                      <input type="checkbox" className="rule-case" checked={r.caseSensitive} onChange={(e) => upd(r.id, { caseSensitive: e.target.checked })} />
                      Aa
                    </label>
                    <input type="color" value={r.color} title="글자색" onChange={(e) => upd(r.id, { color: e.target.value })} />
                    <label title="줄 전체에 옅은 배경색">
                      <input type="checkbox" className="rule-line" checked={r.line} onChange={(e) => upd(r.id, { line: e.target.checked })} />
                      줄
                    </label>
                    <label title="줄만 보기에 씀 — 태그에 걸린 줄만 보는 화면에서 이 규칙에 걸린 줄을 보여 줍니다">
                      <input type="checkbox" className="rule-filter" checked={r.filter} onChange={(e) => upd(r.id, { filter: e.target.checked })} />
                      줄만
                    </label>
                    <button
                      className="mp-x"
                      title="위로"
                      disabled={i === 0}
                      onClick={() =>
                        setRules((prev) => {
                          const n = [...prev];
                          [n[i - 1], n[i]] = [n[i], n[i - 1]];
                          return n;
                        })
                      }
                    >
                      ↑
                    </button>
                    <button className="mp-x" title="이 규칙 지우기" onClick={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}>
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="tags-main-actions">
              <button className="tb-btn rule-add" onClick={() => setRules((prev) => [...prev, newRule()])}>
                ＋ 규칙 추가
              </button>
              {isCommon && (
                <button
                  className="tb-btn"
                  onClick={() => {
                    if (window.confirm("common 규칙을 기본값으로 되돌릴까요? 추가하거나 고친 규칙은 사라집니다.")) setRules(() => DEFAULT_LOG_RULES);
                  }}
                >
                  기본값으로
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="chips-actions">
          <button className="tb-btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
        {exporting && (
          <div className="tags-sub-overlay">
            <div className="tags-sub tags-export-panel">
              <div className="chips-title">태그 내보내기</div>
              <div className="chips-sub">고른 태그와 그 규칙을 파일 하나로 저장합니다. 어디에 붙였는지(폴더·파일 지정)는 넣지 않습니다.</div>
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
              <label className="tags-export-name">
                <span>파일 이름</span>
                <input
                  className="tags-export-file"
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
            </div>
          </div>
        )}
        {conflict && (
          <div className="tags-sub-overlay">
            <div className="tags-sub tags-conflict" role="alertdialog">
              <div className="chips-title tags-conflict-q">「{conflict.c.name}」 태그가 이미 있습니다. 덮어쓰시겠습니까?</div>
              <div className="chips-sub">
                가져올 파일 {conflict.c.file} 의 「{conflict.c.name}」(규칙 {conflict.c.theirs}개)이 내 「{conflict.c.name}」(규칙 {conflict.c.mine}개)과
                내용이 다릅니다.
                {conflict.c.isCommon && " common 은 모든 로그에 쓰이는 태그라, 덮어쓰면 모든 로그의 색이 바뀝니다."} 덮어써도 가져오기가 끝난 뒤
                「되돌리기」로 통째로 취소할 수 있고, 지금 태그는 tags.json.bak 에도 남습니다.
              </div>
              {conflict.c.left > 0 && (
                <label className="tags-conflict-all">
                  <input type="checkbox" checked={conflictAll} onChange={(e) => setConflictAll(e.target.checked)} />
                  나머지 {conflict.c.left}개도 모두 같게
                </label>
              )}
              <div className="chips-actions">
                <button className="tb-btn primary tags-c-overwrite" onClick={() => answer("overwrite")}>
                  덮어쓰기
                </button>
                <button className="tb-btn tags-c-skip" onClick={() => answer("skip")}>
                  건너뛰기
                </button>
                <button className="tb-btn tags-c-rename" title={`「${conflict.c.renameTo}」 로 추가합니다`} onClick={() => answer("rename")}>
                  다른 이름으로 ({conflict.c.renameTo})
                </button>
              </div>
              <div className="dim tags-conflict-esc">Esc: 가져오기 그만두기 (아무것도 바꾸지 않음)</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
