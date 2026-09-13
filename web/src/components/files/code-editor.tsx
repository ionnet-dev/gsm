/**
 * CodeMirror 6 for the Files tab. Loaded lazily (it is the tab's biggest dependency), and each
 * language only when a file needs it. Colours come from the app's CSS variables, so it follows the
 * light and dark themes without a second theme.
 */
import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  type LanguageSupport,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const legacy = (load: () => Promise<StreamParser<unknown>>) => async () =>
  StreamLanguage.define(await load());

/** File name (or shebang) → a loader for its language. */
function languageFor(path: string, firstLine: string): (() => Promise<Extension>) | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const shebang = firstLine.startsWith("#!") ? firstLine : "";
  if (/python/.test(shebang)) {
    return () => import("@codemirror/lang-python").then((m) => m.python());
  }
  if (/\b(ba|z|k|da)?sh\b/.test(shebang)) {
    return legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
  }
  if (name === "dockerfile" || name === "containerfile" || name.startsWith("dockerfile.")) {
    return legacy(() =>
      import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)
    );
  }
  if (name === "nginx.conf" || path.includes("/nginx/")) {
    return legacy(() => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx));
  }
  if (
    /^\.(bash|zsh)(rc|_profile|_logout)$|^\.profile$|^profile$|^\.env$/.test(name) ||
    ["sh", "bash", "zsh"].includes(ext)
  ) {
    return legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
  }
  switch (ext) {
    case "json":
    case "jsonc":
      return () => import("@codemirror/lang-json").then((m) => m.json());
    case "yaml":
    case "yml":
      return () => import("@codemirror/lang-yaml").then((m) => m.yaml());
    case "py":
      return () => import("@codemirror/lang-python").then((m) => m.python());
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
    case "ts":
    case "mts":
    case "tsx":
      return () =>
        import("@codemirror/lang-javascript").then((m) =>
          m.javascript({ typescript: true, jsx: ext === "tsx" })
        );
    case "md":
    case "markdown":
      return () => import("@codemirror/lang-markdown").then((m) => m.markdown());
    case "xml":
    case "svg":
    case "plist":
    case "xsd":
      return () => import("@codemirror/lang-xml").then((m) => m.xml());
    case "html":
    case "htm":
      return () => import("@codemirror/lang-html").then((m) => m.html());
    case "css":
    case "scss":
      return () => import("@codemirror/lang-css").then((m) => m.css());
    case "sql":
      return () => import("@codemirror/lang-sql").then((m) => m.sql());
    case "toml":
      return legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml));
    case "lua":
      return legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua));
    case "go":
      return legacy(() => import("@codemirror/legacy-modes/mode/go").then((m) => m.go));
    case "rb":
      return legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby));
    case "pl":
    case "pm":
      return legacy(() => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl));
    case "rs":
      return legacy(() => import("@codemirror/legacy-modes/mode/rust").then((m) => m.rust));
    case "ps1":
      return legacy(() =>
        import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)
      );
    case "diff":
    case "patch":
      return legacy(() => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff));
    case "ini":
    case "cfg":
    case "conf":
    case "cnf":
    case "properties":
    case "env":
    case "service":
    case "timer":
    case "socket":
    case "mount":
    case "target":
    case "path":
    case "network":
    case "netdev":
    case "desktop":
    case "repo":
      return legacy(() =>
        import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties)
      );
  }
  return null;
}

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword],
    color: "var(--syntax-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [t.propertyName, t.attributeName, t.definition(t.variableName)],
    color: "var(--syntax-property)",
  },
  { tag: [t.typeName, t.className, t.tagName, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.meta, t.processingInstruction, t.heading, t.labelName], color: "var(--syntax-meta)" },
  { tag: t.heading, fontWeight: "600" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.invalid, color: "var(--destructive)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in oklch, var(--primary) 28%, transparent) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 16%, transparent)" },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--status-degraded) 35%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--status-degraded) 60%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "4px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--secondary)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--accent)",
    border: "none",
    color: "var(--muted-foreground)",
  },
  ".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--border)" },
});

export interface CodeEditorProps {
  /** Replaces the document when it changes (a new file, or after a reload). */
  docKey: string;
  value: string;
  path: string;
  readOnly: boolean;
  wrap: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export default function CodeEditor(
  { docKey, value, path, readOnly, wrap, onChange, onSave }: CodeEditorProps,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const compartments = useRef({
    readOnly: new Compartment(),
    wrap: new Compartment(),
    language: new Compartment(),
  });
  // Callbacks change every render; the editor reads them through refs.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const c = compartments.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        theme,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        c.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        c.wrap.of(wrap ? EditorView.lineWrapping : []),
        c.language.of([]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    let alive = true;
    const nl = value.indexOf("\n");
    const load = languageFor(path, value.slice(0, nl < 0 ? 200 : nl));
    load?.().then((ext) => {
      if (alive) v.dispatch({ effects: c.language.reconfigure(ext as LanguageSupport) });
    }).catch(() => {/* plain text */});
    return () => {
      alive = false;
      v.destroy();
      view.current = null;
    };
    // A new document gets a new editor (and a fresh undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    const c = compartments.current;
    view.current?.dispatch({
      effects: [
        c.readOnly.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        c.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
      ],
    });
    if (!readOnly) view.current?.focus();
  }, [readOnly, wrap]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
