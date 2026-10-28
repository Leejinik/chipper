import { useEffect, useId, useMemo, useRef, useState } from "react";
import { compileRule, ruleCheck, stripAnsi, type LogRule, type RuleKind } from "./logHighlight";
import { COMMON, type TagStore } from "./logTags";
import { addTextRule, defaultRuleTag, sameRuleIn, type TextRuleDraft } from "./textRule";
import "./RuleFromText.css";

// 「이 글자로 로그 색 규칙 만들기…」: the small window the editor's right-click
// menu opens with the selected text. Choose the tag (default: the tag put on
// this file, else common), the colour and the line background — 만들기. Kind
// (default 글자 그대로) and case are there but need not be touched.

export { selectionForRule } from "./textRule";

const KIND_LABEL: Record<RuleKind, string> = { text: "글자 그대로", word: "단어", regex: "정규식" };
const START_COLOR = "#c678dd"; // the tag window's new-rule colour

interface Props {
  text: string; // the pattern (selectionForRule)
  sample: string; // the line the text was picked from (preview)
  store: TagStore;
  applied: string[]; // tags applied to the tab (common first)
  logOn: boolean; // the tab shows log colours
  onCreate: (next: TagStore, tag: string, updated: boolean) => void;
  onClose: () => void;
}

export default function RuleFromText({ text, sample, store, applied, logOn, onCreate, onClose }: Props) {
  const [pattern, setPattern] = useState(text);
  const [tag, setTag] = useState(() => defaultRuleTag(applied));
  const [kind, setKind] = useState<RuleKind>("text");
  const [cs, setCs] = useState(false);
  const [color, setColor] = useState(START_COLOR);
  const [line, setLine] = useState(false);
  const [label, setLabel] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const draft: TextRuleDraft = { pattern, kind, caseSensitive: cs, color, line, label };
  const check = ruleCheck(draft);
  const twin = pattern ? sameRuleIn(store, tag, draft) : undefined;
  const notOnFile = !applied.includes(tag);
  // does the rule colour something on the line it came from?
  const preview = useMemo(() => {
    const m = check.problem ? null : compileRule({ ...draft, id: "", on: true, filter: true } as LogRule);
    return m ? m.ranges(stripAnsi(sample)?.text ?? sample).length / 2 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, kind, cs, sample, check.problem]);
  const can = !!pattern && !check.problem;

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>(".rft-tag")?.focus();
  }, []);
  useEffect(() => {
    const back = (e: FocusEvent) => {
      const box = boxRef.current;
      if (box && e.target instanceof Node && !box.contains(e.target)) tabbables()[0]?.focus();
    };
    document.addEventListener("focusin", back);
    return () => document.removeEventListener("focusin", back);
  }, []);
  const tabbables = () =>
    [...(boxRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), select") ?? [])].filter((el) => el.offsetParent !== null);

  const create = () => {
    if (!can) return;
    const r = addTextRule(store, tag, draft);
    if (!r) return;
    onCreate(r.store, tag, r.updated);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      create();
    } else if (e.key === "Tab") {
      const els = tabbables();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const at = document.activeElement;
      if (e.shiftKey ? at === first || !boxRef.current?.contains(at) : at === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
    e.stopPropagation(); // the app's shortcuts don't run under the window
  };

  const notes: { cls: string; text: string }[] = [];
  if (check.problem) notes.push({ cls: "err", text: "쓸 수 없음: " + check.reason });
  else if (pattern && !preview) notes.push({ cls: "warn", text: "고른 줄에서 이 규칙에 걸리는 글자가 없습니다 (대소문자·종류를 확인하세요)." });
  if (twin) notes.push({ cls: "info", text: `「${tag}」 태그에 같은 규칙이 이미 있습니다 — 만들면 그 규칙의 색·줄 배경을 바꿉니다.` });
  if (notOnFile)
    notes.push({
      cls: "warn",
      text: `이 파일에는 「${tag}」 태그가 붙어 있지 않아 이 탭에는 색이 안 보입니다 (탭 메뉴 「🏷 태그 지정…」으로 붙일 수 있음).`,
    });
  if (!logOn && !notOnFile) notes.push({ cls: "info", text: "이 탭은 로그 색이 꺼져 있습니다 — 만들면 켭니다." });

  return (
    <div className="chips-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className="keys-dialog rule-from-text"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="chips-title" id={titleId}>
          🎨 이 글자로 로그 색 규칙 만들기
        </div>
        <div className="rft-row">
          <label className="rft-field">
            글자
            <input className="rft-pattern" value={pattern} style={{ color }} onChange={(e) => setPattern(e.target.value)} />
          </label>
        </div>
        <div className="rft-row">
          <label className="rft-field">
            태그
            <select className="rft-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
              {store.tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.name === COMMON ? " (모든 로그)" : applied.includes(t.name) ? " (이 파일에 붙음)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="rft-field" title="글자색">
            색
            <input type="color" className="rft-color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="rft-check" title="이 글자가 있는 줄 전체에 옅은 배경색">
            <input type="checkbox" className="rft-line" checked={line} onChange={(e) => setLine(e.target.checked)} />
            줄 배경
          </label>
        </div>
        <div className="rft-row rft-more">
          <label className="rft-field">
            종류
            <select className="rft-kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
              {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="rft-check" title="대소문자 구분">
            <input type="checkbox" className="rft-case" checked={cs} onChange={(e) => setCs(e.target.checked)} />
            Aa
          </label>
          <label className="rft-field">
            이름
            <input className="rft-label" value={label} placeholder="(없어도 됨)" maxLength={100} onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
        {notes.map((n, k) => (
          <div key={k} className={"rft-note " + n.cls}>
            {n.text}
          </div>
        ))}
        <div className="chips-sub">
          「{tag}」 태그 규칙 끝에 붙고, 태그 창(🏷)에서 언제든 고칠 수 있습니다. 「줄만」(태그 줄만 보기에 씀)은 켜진 채로 만들어집니다.
        </div>
        <div className="chips-actions">
          <button className="tb-btn" onClick={onClose}>
            취소
          </button>
          <button className="tb-btn primary rft-ok" disabled={!can} onClick={create}>
            {twin ? "같은 규칙 고치기" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
