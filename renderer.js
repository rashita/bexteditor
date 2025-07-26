import { lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap} from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { RangeSetBuilder  } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { foldGutter, indentOnInput, HighlightStyle, syntaxHighlighting, foldKeymap } from '@codemirror/language';
import { tags } from "@lezer/highlight";
import { searchKeymap } from '@codemirror/search';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { syntaxTree } from "@codemirror/language";
import { foldCode, unfoldCode,foldEffect, unfoldEffect,foldable } from "@codemirror/language"; //下位項目の開閉
import { markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data"; // GFMを含む各種定義

//文字数カウント用のプラグイン
const charCountPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement("div");
    this.dom.className = "cm-char-count";
    this.dom.style.cssText = "padding: 4px; font-size: 12px; background: #f5f5f5;";
    this.update(view);
    view.dom.parentNode.appendChild(this.dom);
  }

  update(update) {
    this.dom.textContent = `文字数: ${update.state.doc.length}`;
  }

  destroy() {
    this.dom.remove();
  }
});

function isCursorInsideInternalLink(state) {
  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(line.text)) !== null) {
    const start = line.from + match.index;
    const end = start + match[0].length;
    if (head >= start && head <= end) return match[1]; // 内部にいるならリンクテキストを返す
  }
  return null;
}

//内部リンク用のプラグイン
const internalLinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view) {
    const builder = new RangeSetBuilder();
    const regex = /\[\[([^\]]+)\]\]/g;

    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;

    for (let { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const isCursorLine = line.number === cursorLine;
        const text = line.text;

        let match;
        while ((match = regex.exec(text)) !== null) {
          const start = line.from + match.index;
          const end = start + match[0].length;
          const linkText = match[1];

          if (isCursorLine) {
            // カーソルがある行 → 色だけつける（リンク色）
            const mark = Decoration.mark({
              class: "cm-internal-link-active"
            });
            builder.add(start, end, mark);
          } else {
            // カーソルがない行 → ウィジェット表示
            const deco = Decoration.widget({
              widget: new InternalLinkWidget(linkText),
              side: 0
            });
            builder.add(start, end, deco);
          }
        }

        pos = line.to + 1;
      }
    }

    return builder.finish();
  }

}, {
  decorations: v => v.decorations
});

class InternalLinkWidget extends WidgetType{
  constructor(linkText) {
    super();
    this.linkText = linkText;
  }

  eq(other) {
    return other.linkText === this.linkText;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-hmd-internal-link";

    const a = document.createElement("a");
    a.className = "cm-underline";
    a.href = "#";
    a.textContent = this.linkText;
    a.addEventListener("mousedown", e => {
      e.stopPropagation(); // mousedownを停止
    });
    
    a.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation(); // ← エディタへのフォーカス移動などを防ぐ
      console.log("Internal link clicked:", this.linkText);
      const isModifierPressed = e.metaKey || e.ctrlKey; //MacとWinでcommand

      if (isModifierPressed) {
        // 新規ウィンドウなど
      } else {
        //ここにリンクの読み込みを追加
        await window.electronAPI.openLink(this.linkText,window.currentFilePath)
        //今開いているウィンドウを書き換えす
      }

    };

    span.appendChild(a);
    return span;
  }

  ignoreEvent() {
    return false;
  }

  destroy(dom) {
    // ウィジェットが消えるときのクリーンアップ処理
    // 通常は何もせずOK
  }
}


const markdownWithGFM = markdown({
  base: markdownLanguage,
  codeLanguages: languages, // ← GFMなど含まれる
});

window.currentFilePath = null;
let isDirty = false;
let editorView; // To hold the EditorView instance

// --- 1. タイトル更新をメインプロセスに依頼する関数 ---
function updateTitle() {
  window.electronAPI.updateTitle({
    filePath: window.currentFilePath,
    isDirty
  });
}

// --- 2. isDirty フラグの状態を変更し、タイトル更新をトリガーする関数 ---
function setDirtyState(dirty) {
  if (isDirty === dirty) return;
  isDirty = dirty;
  updateTitle();
}

// --- 3. CodeMirror の変更を監視し、isDirty を true にするリスナー ---
const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    setDirtyState(true);
  }
});

// --- カスタム要素の定義 ---

// --- カスタムハイライトスタイルの定義 ---
const myHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-header' },
  { tag: tags.strong,  class: 'cm-strong' },
  { tag: tags.list, class: 'cm-bullet-list-mark' },
]);


function smartToggleFold(view) {
  // unfoldを試行（展開優先）
  if (unfoldCode(view)) {
    return true
  }
  
  // foldを試行
  if (foldCode(view)) {
    return true
  }
  
  // どちらも失敗した場合は何もしない
  return false
}

//foldのトグル関数
function toggleFoldCode(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const range = foldable(state, line.from);
  console.log("toggleFoldCode start")

  if (!range) return false;
  console.log("rang has")


  // 折りたたまれているかを確認
  const isFolded = state.field(foldEffect, false)?.some(r =>
    r.from === range.from && r.to === range.to
  );

  console.log("hold ?" + isFolded)

  view.dispatch({
    effects: isFolded
      ? unfoldEffect.of(range)
      : foldEffect.of(range)
  });

  return true;
}

function slideUp(){
  console.log("slideUp")
}
function slideDown(){
  console.log("slideDown")
}
// カスタムのキーバインディング
const customKeymap = keymap.of([
  {
    key: "Mod-Alt-ArrowUp", // Mod = Mac: Command, Windows: Ctrl
    preventDefault: true,
    run: moveLineUp
  },
  {
    key: "Mod-Alt-ArrowDown",
    preventDefault: true,
    run: moveLineDown
  },
  {
    key: "Mod-Alt-ArrowLeft",  
    preventDefault: true,
    run: foldCode
  },
  {
    key: "Mod-Alt-ArrowRight",
    preventDefault: true,
    run: smartToggleFold
  },
  {
    key: "Mod-Ctrl-ArrowUp",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      console.log("Mod-Alt-@です")
      window.electronAPI.levelFile(currentFilePath,true);
      return true;
    }
  },
  {
    key: "Mod-Ctrl-ArrowDown",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      console.log("Mod-Alt-:です")
      window.electronAPI.levelFile(currentFilePath,false);
      return true;
    }
  },
  {
    key: "Mod-Alt-[",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      window.electronAPI.shiftFile(currentFilePath,-1);
      return true;
    }
  },
  {
    key: "Mod-Alt-]",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      window.electronAPI.shiftFile(currentFilePath,+1);
 
      return true;
    }
  },
  {
    key: "Mod-Enter", // Cmd+Enter または Ctrl+Enter
    run: (view) => {
      console.log("hit command + enter");
      const linkText = isCursorInsideInternalLink(view.state);
      if (linkText) {
        // Cmd+Enter かつ [[...]] 内にカーソルがある場合の処理
        console.log("Cmd+Enter inside internal link:", linkText);

        // Electron の IPC で新規ウィンドウを開く例
        // window.electronAPI.openInNewWindow(linkText);

        return true;  // キーイベントを処理済みとして伝える
      }
      return false;  // そうでなければ通常のEnter動作へ
    }
  }
]);


// カスタムのセット
const mySetup = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    keymap.of([
          indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap
    ])
];

// --- テキスト操作の関数群 ---
// 行を1つ上に移動する関数
function moveLineUp({ state, dispatch }) {
  const selection = state.selection.main;
  const currentLine = state.doc.lineAt(selection.head);
  if (currentLine.number === 1) return false; // 先頭行は移動不可

  const prevLine = state.doc.line(currentLine.number - 1);
  const from = prevLine.from;
  const to = currentLine.to;

  const newText =
    state.doc.sliceString(currentLine.from, currentLine.to) + "\n" +
    state.doc.sliceString(prevLine.from, prevLine.to);

  dispatch({
    changes: { from, to, insert: newText },
    selection: { anchor: from + (selection.head - currentLine.from) }
  });
  return true;
}

// 行を1つ下に移動する関数
function moveLineDown({ state, dispatch }) {
  const selection = state.selection.main;
  const currentLine = state.doc.lineAt(selection.head);
  if (currentLine.number === state.doc.lines) return false; // 最終行は移動不可

  const nextLine = state.doc.line(currentLine.number + 1);
  const from = currentLine.from;
  const to = nextLine.to;

  const nextLineText = state.doc.sliceString(nextLine.from, nextLine.to);
  const currentLineText = state.doc.sliceString(currentLine.from, currentLine.to);

  const newText = nextLineText + "\n" + currentLineText;

  const posInLine = selection.head - currentLine.from;
  // カーソルは newText の「後半(currentLineText)」に移動するので、
  // nextLineText + 改行の長さを足す
  const newCursorPos = from + nextLineText.length + 1 + posInLine;

  dispatch({
    changes: { from, to, insert: newText },
    selection: { anchor: newCursorPos }
  });
  return true;
}


// --- CodeMirrorの初期化 ---
function initializeEditor() {
  const state = EditorState.create({
    doc: '',
    extensions: [
      customKeymap,
      ...mySetup,
      //markdown(),
      markdownWithGFM,
      updateListener,
      syntaxHighlighting(myHighlightStyle),
      EditorView.lineWrapping,
      checklistPlugin,
      imagePlugin,
      internalLinkPlugin,
      charCountPlugin
    ]
  });

  editorView = new EditorView({
    state,
    parent: document.getElementById('editor')
  });
}

// --- ファイルを開く処理 ---
window.electronAPI.onLoadFile(({ filePath, content }) => {
  window.currentFilePath = filePath;

  // エディタの内容を新しいファイルの内容で更新
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content }
  });

  setDirtyState(false);
  updateTitle();
});

// --- ファイルを保存する処理 ---
window.electronAPI.onTriggerSaveFile(async (event, { id }) => {
  await saveCurrentFile(id);  
  return
  if (!editorView) return;

  const content = editorView.state.doc.toString();
  const returnedFilePath = await window.electronAPI.saveFile({
    filePath: window.currentFilePath,
    content
  });

  if (returnedFilePath) {
    window.currentFilePath = returnedFilePath;
    setDirtyState(false);
    updateTitle();
    window.electronAPI.fileSaved(id);
  }
});

async function saveCurrentFile(id = null) {
  if (!editorView) return false;

  const content = editorView.state.doc.toString();
  const returnedFilePath = await window.electronAPI.saveFile({
    filePath: window.currentFilePath,
    content
  });

  if (returnedFilePath) {
    window.currentFilePath = returnedFilePath;
    setDirtyState(false);
    updateTitle();

    if (id !== null) {
      window.electronAPI.fileSaved(id);
    }
    return true;
  }

  return false;
}

window.electronAPI.onBeforeClose((event, { id }) => {
  window.electronAPI.sendIsDirty(id, isDirty);
});

//リンク経由でファイルを開く処理（プロトタイプ）
document.addEventListener('click', async (e) => {
  if (e.target.matches('a[data-open-file]')) {
    e.preventDefault();
    const fileName = e.target.dataset.openFile;
    const filePath = `/Users/Tadanori/Desktop/${fileName}.md`; // 必要に応じて調整
    const result = await window.electronAPI.openSpecificFile(filePath);

    if (result.success) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: result.content }
      });
      window.currentFilePath = result.filePath;
      setDirtyState(false);
      updateTitle();
    } else {
      alert("ファイルを開けませんでした: " + result.error);
    }
  }
});

// チェックボックスウィジェット定義
class CheckboxWidget extends WidgetType {
  constructor(checked, from, to, view) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
    this.view = view;
  }

  toDOM() {
    const label = document.createElement("label");
    label.className = "task-list-label";
    label.contentEditable = "false"; // ← 重要ポイント！

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-list-item-checkbox";
    checkbox.checked = this.checked;
    checkbox.dataset.task = this.checked ? "x" : " ";

    checkbox.addEventListener("mousedown", e => {
      e.stopPropagation(); // mousedownを停止
    });

    // ✔️ チェック状態をMarkdownに反映
    checkbox.onclick = (e) => {
      console.log("クリックされました")
      e.preventDefault(); // ← ブラウザのデフォルトフォーカス移動を防ぐ
      e.stopPropagation(); // ← エディタへのフォーカス移動などを防ぐ
      const newText = this.checked ? "[ ]" : "[x]";
      this.view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: newText
        }
      });
    };

    label.appendChild(checkbox);

    return label;
  }

  ignoreEvent() {
    return false; // ← 必須：クリックを無視しない
  }
}

// ViewPluginで TaskMarkerノードの範囲を置き換え
const checklistPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged)
      this.decorations = this.buildDecorations(update.view);
  }
  buildDecorations(view) {
    const widgets = [];
    const { from, to } = view.viewport;
    const tree = syntaxTree(view.state);
    const selection = view.state.selection.main;

    // カーソルのある行の開始・終了オフセットを取得
    const line = view.state.doc.lineAt(selection.from);
    const lineFrom = line.from;
    const lineTo = line.to;

    tree.iterate({
      from, to,
      enter: (node) => {
        if (node.name === "TaskMarker") {
          if (selection.from >= node.from && selection.from <= node.to) {
          // カーソル行は元テキストを表示するのでスルー
          return;
        }

          // const overlap = !(node.to < lineFrom || node.from > lineTo);
          // if (overlap) {
          //   // カーソルのある行にTaskMarkerがあれば置換しない
          //   return;
          // }
          const text = view.state.doc.sliceString(node.from, node.to);
          const checked = /\[x\]/i.test(text);
          widgets.push(
            Decoration.replace({
              widget: new CheckboxWidget(checked, node.from, node.to, view),
              inclusive: false
            }).range(node.from, node.to)
          );
        }
      }
    });

    return Decoration.set(widgets, true);
  }
}, {
  decorations: v => v.decorations
});


///////////////////////////
// 🖼️ 画像表示 Widget
///////////////////////////

class ImagePreviewWidget extends WidgetType {
  constructor(alt,src) {
    super()
    this.src = src
    this.alt = alt
  }

  toDOM() {
    const img = document.createElement("img")
    img.src = this.src
    img.alt = this.alt
    img.style.maxHeight = "480px"
    img.style.marginLeft = "1em"
    return img
  }

  ignoreEvent() {
    return true
  }
}

const imagePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view)
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet)
      this.decorations = this.buildDecorations(update.view)
  }

  buildDecorations(view) {
    const widgets = []
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number
    const cursorPos = view.state.selection.main.head;

    for (let { from, to, text } of view.visibleRanges.map(range => ({
      from: range.from,
      to: range.to,
      text: view.state.doc.sliceString(range.from, range.to)
    }))) {
      let match;
      while ((match = imageRegex.exec(text)) !== null) {
        const matchStart = from + match.index;
        const matchEnd = matchStart + match[0].length;

        // カーソルがこの範囲内にある場合は、通常のMarkdown表示にする
        if (cursorPos >= matchStart && cursorPos <= matchEnd) continue;

        const [_, alt, url] = match;
        widgets.push(Decoration.replace({
          widget: new ImagePreviewWidget(alt, url),
          inclusive: false,
        }).range(matchStart, matchEnd));
      }
    }

    return Decoration.set(widgets, true)
  }
}, {
  decorations: v => v.decorations
})



// --- 初期化処理 ---
initializeEditor();
updateTitle();


console.log('Renderer script with CodeMirror loaded.');