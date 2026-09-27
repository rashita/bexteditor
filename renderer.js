import { lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap} from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { EditorState ,StateEffect,Compartment} from "@codemirror/state";
import { RangeSetBuilder  } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab,deleteCharBackward} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { foldGutter, indentOnInput, HighlightStyle, syntaxHighlighting, foldKeymap } from '@codemirror/language';
import { tags } from "@lezer/highlight";
import { searchKeymap } from '@codemirror/search';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { syntaxTree , indentUnit,foldService} from "@codemirror/language";
import { foldCode, unfoldCode,foldEffect, unfoldEffect,foldable } from "@codemirror/language"; //下位項目の開閉
import { markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data"; // GFMを含む各種定義
//セルフ拡張
import { editingKeymap } from './lib/keybindings.js';
import NavigationHistory from './lib/NavigationHistory.js';
import { resolveImageSrc } from './lib/imagePath.js';

import dayjs from 'dayjs';//日付の操作用

console.log("%cBextEditor Developer Console", "color:#7f6df2; font-size:40px; font-weight:bold;");


// 履歴インスタンスを作る（このウィンドウ専用）
const NaviHistory = new NavigationHistory();

// 今の位置を表すオブジェクト（例として）
function currentEntry() {
  return {
    filePath: window.currentFilePath,
    cursorPos: editorView.state.selection.main.head,
    scrollTop: editorView.scrollDOM.scrollTop  
  };
}

// 履歴を戻る操作
async function goBack(view) {
  console.log("ブラウザバックを実行します")
  const prev = NaviHistory.back(currentEntry());
  if(prev){
    await window.electronAPI.openLink(prev.filePath,window.currentFilePath)
    console.log(prev)
    view.dispatch({
      selection: { anchor: prev.cursorPos },
      effects: EditorView.scrollIntoView(prev.cursorPos)
    });
    view.scrollDOM.scrollTop = prev.scrollTop;
    //ファイルを開く
  }
  
  return true;
}

// 履歴を進む操作
async function goForward(view) {
    console.log("ブラウザフォワードを実行します")
    const next = NaviHistory.forward(currentEntry());
    if(next){
      await window.electronAPI.openLink(next.filePath,window.currentFilePath)
      console.log(next)
      view.dispatch({
        selection: { anchor: next.cursorPos },
        effects: EditorView.scrollIntoView(next.cursorPos)
      });
      view.scrollDOM.scrollTop = next.scrollTop;
      //ファイルを開く
    }
    return true;
}

const isAUtoSave = false //自動保存機能のトグル

const fontCompartment = new Compartment();//
const lineNumbersCompartment = new Compartment();
const hiddenLineNumbersTheme = EditorView.theme({
  ".cm-lineNumbers .cm-gutterElement": { color: "transparent" }
});

class LinkWidget extends WidgetType {
  constructor(linkText, url) {
    super()
    this.linkText = linkText
    this.url = url
  }

  eq(other) {
    return this.linkText === other.linkText && this.url === other.url
  }

  toDOM() {
    const a = document.createElement("a")
    a.textContent = this.linkText
    a.href = this.url
    a.target = "_blank"
    a.style.color = "blue"
    a.style.textDecoration = "underline"
    a.style.cursor = "pointer"
  // クリック時にエディタへの伝播を止め、リンクを開く
  a.addEventListener("mousedown", (e) => {
    e.preventDefault()  // カーソル移動を防ぐ
    e.stopPropagation()
  })
  a.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(this.url, "_blank")  // または shell.openExternal(this.url)
  })
    return a
  }

  // クリックイベントをエディタに渡さない
ignoreEvent(event) {
  return event.type === "mousedown" || event.type === "click"
}
  destroy() { /* Widget が削除されるときに呼ばれる */ }
}

// Markdownリンクを <a> に変換するプラグイン
const linkWidgetPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view)
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view) {
    const widgets = []
    const cursorPos = view.state.selection.main.head
    const { from, to } = view.viewport
    const tree = syntaxTree(view.state)

    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== "Link") return

        // カーソルがノード範囲内にある場合はスキップ
        if (cursorPos >= node.from && cursorPos <= node.to) return

        // 子ノードを走査して Image と URL を探す
        let hasImage = false
        let urlNode = null
        let child = node.node.firstChild
        while (child) {
          if (child.name === "Image") { hasImage = true; break }
          if (child.name === "URL") urlNode = child
          child = child.nextSibling
        }

        // Image を含む Link は imagePlugin に任せる
        if (hasImage || !urlNode) return

        const url = view.state.doc.sliceString(urlNode.from, urlNode.to)

        // http/https のみ対象
        if (!/^https?:\/\//.test(url)) return

        // リンクテキストを取得（ノード先頭の [text] から抽出）
        const nodeText = view.state.doc.sliceString(node.from, node.to)
        const m = nodeText.match(/^\[([^\]]+)\]/)
        if (!m) return
        const linkText = m[1]

        widgets.push(Decoration.replace({
          widget: new LinkWidget(linkText, url),
          inclusive: false,
        }).range(node.from, node.to))
      }
    })

    return Decoration.set(widgets, true)
  }
}, {
  decorations: v => v.decorations
})


//ハッシュタグ用のプラグイン
const hashtagRegex = /#[\w\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

class HashtagWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "cm-hashtag-span";
    span.textContent = this.text;
    span.dataset.tag = this.text.slice(1); // "#hoge" → "hoge"
    span.contentEditable = "false"; // ← 重要ポイント！
    span.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation(); // mousedownを停止
    });
    span.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Tag clicked:", this.text);
      // 将来的に → 検索/別ペイン表示/フィルタなど
    };
    return span;
  }
  ignoreEvent() {
    return false; // クリックを拾うため
  }
}

const hashtagPlugin = ViewPlugin.fromClass(class {
  decorations;

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

    const cursorPositions = view.state.selection.ranges.map(r => r.head);

    for (let { from, to } of view.visibleRanges) {
      let text = view.state.doc.sliceString(from, to);
      let match;
      while ((match = hashtagRegex.exec(text)) !== null) {
        const start = from + match.index;
        const end = start + match[0].length;

        const cursorInside = cursorPositions.some(pos => pos >= start && pos <= end);
        if (!cursorInside) {
          builder.add(
            start,
            end,
            Decoration.replace({
              widget: new HashtagWidget(match[0]),
              inclusive: false
            })
          );
        }
      }
    }
    return builder.finish();
  }
}, {
  decorations: v => v.decorations
});

export const hashtagSpanTheme = EditorView.baseTheme({
  ".cm-hashtag-span": {
    color: "#1da1f2",
    cursor: "pointer",
    backgroundColor: "rgba(29,161,242,0.1)",
    borderRadius: "4px",
    padding: "0 2px"
  }
});

// （必要ならより正確な文字数にするヘルパー）
// function countChars(str) {
//   // Intl.Segmenter が使える環境なら結合文字も1文字として数えられる
//   if (typeof Intl !== "undefined" && Intl.Segmenter) {
//     const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
//     let n = 0; for (const _ of seg.segment(str)) n++; return n;
//   }
//   // フォールバック（サロゲートペア対応/結合文字は分割）
//   return Array.from(str).length;
// }

//文字数カウント用のプラグイン
const charCountPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    // 既存の status-bar を取得
    const statusBar = document.getElementById("status-bar");
    if (!statusBar) return; // なければ終了

    this.statusBar = statusBar

    // 文字数カウント用の要素を作成
    this.dom = document.createElement("div");
    this.dom.className = "cm-char-count";
    this.dom.style.cssText = "padding: 4px; font-size: 12px; background: #f5f5f5;";
    this.update(view);
    statusBar.appendChild(this.dom);
    //view.dom.parentNode.appendChild(this.dom);
  }

  update(update) {
    if (update.docChanged || update.selectionSet) {
      this.updateDisplay(update.view);
    }
  }

  updateDisplay(view) {
    if (!this.dom) return;

    const sel = view.state.selection;
    const hasSelection = sel.ranges.some(r => !r.empty);

    if (hasSelection) {
      // 複数レンジ選択にも対応して合計を表示
      let total = 0;
      for (const r of sel.ranges) {
        if (!r.empty) {
          const piece = view.state.doc.sliceString(r.from, r.to);
          // total += countChars(piece); // より正確に数えたい場合はこちら
          total += piece.length;         // 高速（UTF-16単位）
        }
      }
      this.dom.textContent = `文字数: ${total}（選択中）`;
    } else {
      // 全文
      // const all = countChars(view.state.doc.toString()); // 正確版
      const all = view.state.doc.length;                   // 高速版
      this.dom.textContent = `文字数: ${all}`;
    }
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
        console.log("コントロールクリックです")
        window.electronAPI.openFile(this.linkText,window.currentFilePath)
        // 新規ウィンドウなど
      } else {
        
        const entry = currentEntry(); // 現在の状態を取る
        const ok = await window.electronAPI.openLink(this.linkText,window.currentFilePath)
        console.log(ok)
        if (ok) {
          NaviHistory.visit(entry); //hisutoryに追加
        } else {
          console.log("ヒストリーに追加していません")
          // 読み込み失敗 → 何も追加しない
        }
        
        
        console.log("ヒストリーに追加しました" + currentEntry())
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
  codeLanguages: languages// ← GFMなど含まれる
});

// --- 基礎的な変数 ---

window.currentFilePath = null;
let isDirty = false;
let editorView; // To hold the EditorView instance


// --- オートセーブ周りの設定 ---
let saveTimeout = null;
const AUTO_SAVE_DELAY = 2000; // 2秒

function autoSaveHandler() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async() => {
    if (!window.currentFilePath) return;
    if (!isDirty) return;
    console.log("自動保存します")
    await　saveCurrentFile();          // 保存処理
    setDirtyState(false);       // 保存後に isDirty をリセットしてタイトル更新
  }, AUTO_SAVE_DELAY);
}


// --- 1. タイトル更新をメインプロセスに依頼する関数 ---
function updateTitle() {
  const shouldShowAsterisk = isAUtoSave?isDirty && !window.currentFilePath:isDirty;

  window.electronAPI.updateTitle({
    filePath: window.currentFilePath,
    isDirty: shouldShowAsterisk
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
    if(isAUtoSave)autoSaveHandler()
  }
});

// --- カスタム要素の定義 ---

// --- カスタムハイライトスタイルの定義 ---
const myHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'cm-comment' },
  { tag: tags.heading, class: 'cm-header' },
  { tag: tags.strong,  class: 'cm-strong' },
  { tag: tags.list, class: 'cm-bullet-list-mark' },
  // コードブロック用のスタイル
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.monospace, class: 'cm-code-inline' }, 
  
]);


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

// カスタムのキーバインディング
const customKeymap = keymap.of([
  ...editingKeymap,
  {
    key: "Mod-Ctrl-ArrowUp",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      console.log("Mod-Alt-@です")
      const entry = currentEntry(); // 現在の状態を取る
      const ok = window.electronAPI.levelFile(currentFilePath,true);
      if (ok) {
          NaviHistory.visit(entry); //hisutoryに追加
      } else {
          // 読み込み失敗 → 何も追加しない
      }


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
    key: "Mod-[",
    preventDefault: true,
    run: goBack
  },
  {
    key: "Mod-]",
    preventDefault: true,
    run: goForward
  },
  {
    key: "Mod-Alt-[",
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return
      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      const entry = currentEntry(); // 現在の状態を取る
      const ok = window.electronAPI.shiftFile(currentFilePath,-1);
      if (ok) {
          NaviHistory.visit(entry); //hisutoryに追加
      } else {
          // 読み込み失敗 → 何も追加しない
      }
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
    key: "Mod-Shift-Alt-]", //次のカードを強制作成する
    preventDefault: true,
    run: async () => {
      if (!window.currentFilePath) return

      if (isDirty) {
        await saveCurrentFile();  // 自動で保存
      }
      window.electronAPI.insertFile(currentFilePath,+1);
 
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
        window.electronAPI.openFile(linkText,window.currentFilePath)

        // Electron の IPC で新規ウィンドウを開く例
        // window.electronAPI.openInNewWindow(linkText);

        return true;  // キーイベントを処理済みとして伝える
      }
      return false;  // そうでなければ通常のEnter動作へ
    }
  },
  {//挿入コマンド
    key: "Ctrl-t",
    preventDefault: true,
    run:  (view) => {
      console.log("Ctrl-t")
      insertText(view)
      return true;
    }
  },
  {//タスクのトグル
    key: "Mod-l",
    //run: (view) => toggleTaskAt(view, view.state.selection.main.from)
    run: (view) => toggleTasksForSelection(view)
  }
  // ,
  // {key: "Backspace", run: deleteIndentation }
]);

// カスタムのセット
const mySetup = [
    lineNumbers(),
    lineNumbersCompartment.of(hiddenLineNumbersTheme),
    EditorView.theme({
      ".cm-lineNumbers .cm-gutterElement": {
        // 3桁分に標準の左右パディング（5px + 3px）を加える。
        minWidth: "calc(3ch + 8px)"
      },
      ".cm-foldGutter": {
        // ボタンの有無や開閉記号の字幅によらず、標準パディング込みで固定する。
        width: "calc(1em + 2px)"
      }
    }),
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
function initializeEditor(initialText="") {
  const state = EditorState.create({
    doc: initialText,
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
      linkWidgetPlugin,
      internalLinkPlugin,
      charCountPlugin,
      hashtagPlugin,
      hashtagSpanTheme,
      bulletListPlugin,
      bulletListTheme,
      fontCompartment.of(EditorView.theme({
        "&": { fontSize: "16px", fontFamily: "serif" },
        ".cm-content": {
          fontFamily: '"Roboto",Helvetica,Arial,"Hiragino Sans",sans-serif'
        }
      }))
    ]
  });

  editorView = new EditorView({
    state,
    parent: document.getElementById('editor')
  });

  // 作成後、エディタにフォーカスしてそのまま入力できるようにする
  editorView.focus();
}

// --- ファイルを開く処理 ---
window.electronAPI.onLoadFile(async ({ filePath, content }) => {
  window.currentFilePath = filePath;

  // エディタの内容を新しいファイルの内容で更新
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content }
  });

  setDirtyState(false);
  updateTitle();

  // ワークスペース復元: スクロール位置・カーソル行を適用
  try {
    const restoreState = await window.electronAPI.getRestoreState(filePath);
    if (restoreState) {
      // scrollTop を復元
      if (restoreState.scrollTop != null) {
        editorView.scrollDOM.scrollTop = restoreState.scrollTop;
      }
      // カーソル行を復元
      const targetLine = restoreState.cursorLine || 1;
      const safeLineNum = Math.min(targetLine, editorView.state.doc.lines);
      const line = editorView.state.doc.line(safeLineNum);
      editorView.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
    }
  } catch (e) {
    // ワークスペースが未設定の場合は何もしない
  }
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
      toggleTaskAt(this.view, this.from);
      // const newText = this.checked ? "[ ]" : "[x]";
      // this.view.dispatch({
      //   changes: {
      //     from: this.from,
      //     to: this.to,
      //     insert: newText
      //   }
      // });
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
          // カーソルがチェックボックスないに入ったら表示を戻す
            return;
          
          }

          const line = view.state.doc.lineAt(node.from);
          const lineText = view.state.doc.sliceString(line.from, node.to);
          if (!/^\s*[-*]\s+\[[ xX]\]/.test(lineText)) {
            return;
          }


          const text = view.state.doc.sliceString(node.from, node.to);
          const checked = /\[x\]/i.test(text);
          //const checked = /\[x\]/i.test(text);
          widgets.push(
            Decoration.replace({
              widget: new CheckboxWidget(checked, node.from, node.to, view),
              inclusive: false
            }).range(node.from, node.to)//node.fromから変更
          );

          //親要素操作のテスト.以下を参照。
          //https://chatgpt.com/c/688fe965-95d4-8011-bd4f-b39fc9181e03 
          // widgets.push(
          //   Decoration.line({
          //     attributes: { style: "padding-left: 0.5em;"}
          //   }).range(line.from)
          // );


        }
      }
    });

    return Decoration.set(widgets, true);
  }
}, {
  decorations: v => v.decorations
});


function toggleTasksForSelection(view) {
  const linesDone = new Set();
  const affectedLines = [];

  const result = view.state.changeByRange(range => {
    const changes = [];

    const start = view.state.doc.lineAt(range.from).number;
    const end   = view.state.doc.lineAt(range.to).number;

    for (let ln = start; ln <= end; ln++) {
      if (linesDone.has(ln)) continue;
      linesDone.add(ln);

      const line = view.state.doc.line(ln);
      const change = toggleTaskLine(line);
      if (change) {
        changes.push(change);
        affectedLines.push(ln);
      }
    }

    return changes.length
      ? { changes, range }
      : { range };
  });

  view.dispatch(result);
}

function toggleTaskLine(line) {
  const text = line.text;

  const m = text.match(/^(\s*)([-*])(?:\s+(\[(?: |x|-)\]))?\s*(.*)$/);
  if (!m) {
    // リストでもタスクでもない → prepend だけする
    const newText = `- [ ] ${text}`;
    return { from: line.from, to: line.to, insert: newText };
  }

  const indent = m[1];
  const marker = m[2];
  const checkbox = m[3];
  const body = m[4];

  // すでにタスク → トグル
  if (checkbox) {
    const newCheckbox = checkbox === "[ ]" ? "[x]" : "[ ]";
    const newText = `${indent}${marker} ${newCheckbox} ${body}`;
    return { from: line.from, to: line.to, insert: newText };
  }

  // リストだがタスクでない → タスク化
  const newText = `${indent}${marker} [ ] ${body}`;
  return { from: line.from, to: line.to, insert: newText };
}

function toggleTaskAt(view, from) {
  const line = view.state.doc.lineAt(from);
  const change = toggleTaskLine(line);

  if (!change) return false;

  view.dispatch({
    changes: change
  });

  const indent = line.text.match(/^(\s*)/)[1].length;
  updateParentTasks(view, line.number, indent);

  return true;
}

function updateParentTasks(view, lineNumber, childIndent) {
  let currentLineNum = lineNumber - 1;

  while (currentLineNum > 0) {
    const line = view.state.doc.line(currentLineNum);
    const match = line.text.match(/^(\s*)[-*]\s+\[( |x|-)\]/i);

    if (!match) break; // タスクじゃない → 親探し終了

    const parentIndent = match[1].length;
    if (parentIndent < childIndent) {
      // 親の行が見つかった → 子の状態チェック
      const allChildrenChecked = areAllChildrenChecked(view, currentLineNum, parentIndent);
      const newMark = allChildrenChecked ? "[x]" : "[ ]";

      const replaceFrom = line.from + parentIndent + 2;
      const replaceTo = replaceFrom + 3;

      view.dispatch({
        changes: { from: replaceFrom, to: replaceTo, insert: newMark }
      });

      // 再帰的にさらに上の親へ
      updateParentTasks(view, currentLineNum, parentIndent);
      break;
    }

    currentLineNum--;
  }
}



function areAllChildrenChecked(view, parentLineNum, parentIndent) {
  let checked = true;
  for (let i = parentLineNum + 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const match = line.text.match(/^(\s*)[-*]\s+\[( |x|-)\]/i);
    if (!match) break; // 子リスト終わり

    const indent = match[1].length;
    if (indent <= parentIndent) break; // 階層戻ったら終了

    if (match[2].toLowerCase() !== "x") {
      checked = false;
      break;
    }
  }
  return checked;
}
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
    const cursorPos = view.state.selection.main.head
    const { from, to } = view.viewport
    const tree = syntaxTree(view.state)

    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== "Image") return

        // 親が Link なら Link 全体を置換対象にする（リンク付き画像に対応）
        const parent = node.node.parent
        const replaceFrom = (parent && parent.name === "Link") ? parent.from : node.from
        const replaceTo   = (parent && parent.name === "Link") ? parent.to   : node.to

        // カーソルが置換範囲内にある場合はスキップ
        if (cursorPos >= replaceFrom && cursorPos <= replaceTo) return

        // Image ノードのテキストから alt と URL を抽出
        const imageText = view.state.doc.sliceString(node.from, node.to)
        const m = imageText.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
        if (!m) return

        const resolvedSrc = resolveImageSrc(window.currentFilePath, m[2])

        widgets.push(Decoration.replace({
          widget: new ImagePreviewWidget(m[1], resolvedSrc),
          inclusive: false,
        }).range(replaceFrom, replaceTo))
      }
    })

    return Decoration.set(widgets, true)
  }
}, {
  decorations: v => v.decorations
})

///////////////////////////
// 箇条書きリスト Widget
///////////////////////////

class BulletWidget extends WidgetType {
  constructor(bullet) {
    super()
    this.bullet = bullet
  }

  eq(other) { return other.bullet === this.bullet }

  toDOM() {
    const span = document.createElement("span")
    span.textContent = this.bullet
    span.className = "cm-bullet-widget"
    return span
  }

  ignoreEvent() { return true }
}

const bulletListPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view)
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet)
      this.decorations = this.buildDecorations(update.view)
  }

  buildDecorations(view) {
    const widgets = []
    const cursorPos = view.state.selection.main.head
    const { from, to } = view.viewport
    const tree = syntaxTree(view.state)
    const BULLETS = ["•", "•", "•"]

    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== "ListItem") return

        // カーソルがこの行にある場合はスキップ
        const line = view.state.doc.lineAt(node.from)
        if (cursorPos >= line.from && cursorPos <= line.to) return

        // ListMark を探す
        let listMark = null
        let child = node.node.firstChild
        while (child) {
          if (child.name === "ListMark") { listMark = child; break }
          child = child.nextSibling
        }
        if (!listMark) return

        // - * + のみ対象（番号付きリストは除外）
        const markText = view.state.doc.sliceString(listMark.from, listMark.to)
        if (!/^[-*+]$/.test(markText)) return

        // ネストレベルに応じてbullet文字を切り替え
        let level = 0
        let p = node.node.parent
        while (p) {
          if (p.name === "BulletList") level++
          p = p.parent
        }
        const bullet = BULLETS[(level - 1) % BULLETS.length] + " "

        // マーカー直後のスペースも含めて置換
        const afterMark = view.state.doc.sliceString(listMark.to, listMark.to + 1)
        const replaceEnd = afterMark === " " ? listMark.to + 1 : listMark.to

        widgets.push(Decoration.replace({
          widget: new BulletWidget(bullet),
          inclusive: false,
        }).range(listMark.from, replaceEnd))
      }
    })

    return Decoration.set(widgets, true)
  }
}, {
  decorations: v => v.decorations
})

const bulletListTheme = EditorView.baseTheme({
  ".cm-bullet-widget": {
    color: "#555",
  }
})

// --- 初期化処理 ---
initializeEditor();

function setShowLineNumbers(visible) {
  editorView.dispatch({
    effects: lineNumbersCompartment.reconfigure(visible ? [] : hiddenLineNumbersTheme)
  });
}
window.electronAPI.onShowLineNumbersChanged(setShowLineNumbers);
window.electronAPI.getShowLineNumbers().then(setShowLineNumbers);
updateTitle();

//エディタ外のショートカットキー

//モーダル操作
const isMac = navigator.userAgent.includes("Mac");

// DOM取得// ---- Quick Open パレット ----
const modalOverlayP = document.getElementById('modalOverlayP');
const qoInput       = document.getElementById('qoInput');
const qoList        = document.getElementById('qoList');

let qoAllItems = [];  // { type, path, label, dir }
let qoCursor   = -1;

// main → renderer: パレットを開く
window.electronAPI.onShowQuickOpen(async () => {
  await qoOpen();
});

async function qoOpen() {
  qoAllItems = await window.electronAPI.getQuickOpenItems();
  qoCursor   = -1;
  qoInput.value = '';
  qoRender('');
  modalOverlayP.classList.remove('hidden');
  qoInput.focus();
}

function qoClose() {
  modalOverlayP.classList.add('hidden');
}

// --- 描画 ---
function qoRender(query) {
  const q = query.toLowerCase();
  const filtered = q
    ? qoAllItems.filter(i =>
        i.label.toLowerCase().includes(q) ||
        i.path.toLowerCase().includes(q))
    : qoAllItems;

  //現在のワークスペースを除外しておく
  const currentWsPath = filerState.rootFolder ?? null;

  const workspaces = filtered.filter(i =>
    i.type === 'workspace' && !i.isCurrent   // ← これだけ追加
  );
  console.log(workspaces)
  const files      = filtered.filter(i => i.type !== 'workspace');

  qoList.innerHTML = '';
  qoCursor = -1;

  if (workspaces.length) {
    const sec = document.createElement('li');
    sec.className = 'qo-section';
    sec.textContent = 'ワークスペース';
    qoList.appendChild(sec);
    workspaces.forEach(item => qoList.appendChild(qoMakeItem(item)));
  }
  if (files.length) {
    const sec = document.createElement('li');
    sec.className = 'qo-section';
    sec.textContent = '最近のファイル';
    qoList.appendChild(sec);
    files.forEach(item => qoList.appendChild(qoMakeItem(item)));
  }
  if (!workspaces.length && !files.length) {
    const li = document.createElement('li');
    li.className = 'filer-notice';
    li.textContent = '一致する項目がありません';
    qoList.appendChild(li);
  }
}

function qoShortenPath(p) {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function qoMakeItem(item) {
  const li = document.createElement('li');
  li.className = item.type === 'workspace' ? 'qo-workspace' : 'filer-file';
  li.dataset.path = item.path;
  li.dataset.type = item.type;

  const icon = item.type === 'workspace' ? '📁' : '📄';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'filer-name';
  nameSpan.textContent = icon + ' ' + item.label;

  const dirSpan = document.createElement('span');
  dirSpan.className = 'filer-first-line';
  dirSpan.textContent = qoShortenPath(item.dir);

  // 履歴から削除する × ボタン
  const removeBtn = document.createElement('button');
  removeBtn.className = 'qo-remove-btn';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = '\u5c65\u6b74\u304b\u3089\u524a\u9664';
  // mousedown でのフォーカス移動・リスト開閉を防ぐ
  removeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); // li の click（ファイルを開く処理）を止める
    await window.electronAPI.removeHistoryItem(item.path);
    qoAllItems = qoAllItems.filter(i => i.path !== item.path);
    qoRender(qoInput.value); // 現在の検索語を維持して再描画
  });

  li.appendChild(nameSpan);
  li.appendChild(dirSpan);
  li.appendChild(removeBtn);

  li.addEventListener('click', (e) => {
    qoExecute(item, e.metaKey || e.ctrlKey);
  });
  return li;
}

// --- 実行 ---
async function qoExecute(item, newWindow = false) {
  qoClose();
  if (item.type === 'workspace') {
    // rootFolder パスを直接渡してワークスペースを読み込み・復元する
    await window.electronAPI.openWorkspaceFromPath(item.path);
  } else {
    if (newWindow) {
      window.electronAPI.openSpecificFile(item.path);
    } else {
      window.electronAPI.openFile(item.path, window.currentFilePath ?? '');
    }
  }
}

// --- インクリメンタル検索 ---
qoInput.addEventListener('input', (e) => {
  qoRender(e.target.value);
});

// --- キーボード操作 ---
qoInput.addEventListener('keydown', (e) => {
  const items = [...qoList.querySelectorAll('li[data-path]')];
  if (!items.length) {
    if (e.key === 'Escape') qoClose();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    qoCursor = Math.min(qoCursor + 1, items.length - 1);
    qoUpdateCursor(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    qoCursor = Math.max(qoCursor - 1, 0);
    qoUpdateCursor(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = qoCursor >= 0 ? items[qoCursor] : items[0];
    if (!target) return;
    const item = qoAllItems.find(i => i.path === target.dataset.path);
    if (item) qoExecute(item, e.metaKey || e.ctrlKey);
  } else if (e.key === 'Escape') {
    qoClose();
  }
});

function qoUpdateCursor(items) {
  items.forEach((li, i) => li.classList.toggle('selected', i === qoCursor));
  if (qoCursor >= 0) items[qoCursor].scrollIntoView({ block: 'nearest' });
}

// 背景クリックで閉じる
modalOverlayP.addEventListener('click', (e) => {
  if (e.target === modalOverlayP) qoClose();
});

// キーボード操作（グローバル）
document.addEventListener('keydown', async (e) => {
  const isCmdO      = (isMac && e.metaKey && !e.shiftKey && e.key === 'o') || (!isMac && e.ctrlKey && !e.shiftKey && e.key === 'o');
  const isCmdP      = (isMac && e.metaKey && !e.shiftKey && e.key === 'p') || (!isMac && e.ctrlKey && !e.shiftKey && e.key === 'p');
  const isCmdShiftP = (isMac && e.metaKey &&  e.shiftKey && (e.key === 'P' || e.key === 'p')) || (!isMac && e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p'));

  if (isCmdO) {
    e.preventDefault();
    await filerOpen();
  }
  if (isCmdP) {
    e.preventDefault();
    await qoOpen();
  }
  if (isCmdShiftP) {
    e.preventDefault();
    if (cpOverlay.style.display === 'none' || cpOverlay.style.display === '') {
      await cpOpen();
    } else {
      cpClose();
    }
  }
  if (e.key === 'Escape') {
    modalOverlayO.classList.add('hidden');
    qoClose();
    cpClose();
  }
});

// 背景クリック（フィラー側）
modalOverlayO.addEventListener('click', (e) => {
  if (e.target === modalOverlayO) modalOverlayO.classList.add('hidden');
});

const fileLinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view) {
    const builder = new RangeSetBuilder();
    const regex = /\[\[([^\]]+)\]\]/g;

    for (let { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      let match;
      while ((match = regex.exec(text)) !== null) {
        const start = from + match.index;
        const end = start + match[0].length;
        const filePath = match[1];

        const deco = Decoration.mark({
          attributes: {
            class: 'file-link',
            'data-filepath': filePath
          }
        });

        builder.add(start, end, deco);
      }
    }

    return builder.finish();
  }

  destroy() {}

}, {
  decorations: v => v.decorations
});

function setupClick(view) {
  view.dom.addEventListener('click', (e) => {
    const target = e.target.closest('.file-link');
    if (target) {
      const filePath = target.dataset.filepath;
      console.log('開くファイル:', filePath);
      window.electronAPI.openFile(filePath);
      //モーダルが開いていたら閉じる
      const modalOverlayO = document.getElementById("modalOverlayO");
      modalOverlayO?.classList.contains('hidden') || modalOverlayO.classList.add('hidden');

    }
  });
}


// 外部変更通知を受け取る
window.electronAPI.onFileUpdated(({ filePath, newContent }) => {
  if (!editorView) return;

  const currentContent = editorView.state.doc.toString();
  if (currentContent === newContent) return
  
  if(isDirty){
    const confirmed = confirm(`ファイル ${filePath} が外部で変更されました。再読み込みしますか？`);
    if (!confirmed)  return
  }
  editorView.dispatch({
      changes: { from: 0, to: currentContent.length, insert: newContent }
    });
  setDirtyState(false)

});

// フォントの変更
function changeFont(size,family,padding=undefined) {
  console.log(family + "に変更します")
  editorView.dispatch({
    effects: fontCompartment.reconfigure(EditorView.theme({
      ".cm-content": { 
        fontFamily: family ,
        fontSize: size,
        paddingLeft: padding,
        paddingRight: padding
      },
      ".cm-line": {
        fontSize: size // 行の高さ調整にも有効
      },
      ".cm-activeLine.cm-line":{
          fontFamily: '"Roboto",Helvetica,Arial,"Hiragino Sans",sans-serif'
      }
    }))
  });
}

// main.js からの通知を受け取る
window.electronAPI.onChangeFont(({ size, family,padding }) => {
   console.log("call writing mode")
  changeFont(size, family,padding);
});

//今日の日付を返す ex. 2025-08-09
function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0"); // 月は0始まり
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

//今日の日付を挿入する
function insertData(view){
  const selection = view.state.selection.main;
  const text = getTodayDateString()

  editorView.dispatch({
    changes: selection.empty
      // 選択なし → カーソル位置に挿入
      ? { from: selection.from, insert: text }
      // 選択あり → 選択範囲を置き換え
      : { from: selection.from, to: selection.to, insert: text },
    selection: {
      // 挿入後にカーソルを挿入テキストの後ろに移動
      anchor: selection.from + text.length
    },
    scrollIntoView: true
  });

}

//テキストを挿入する
async function insertText(view,text=""){
  const selection = view.state.selection.main;
  const selectedText = view.state.sliceDoc(selection.from, selection.to);
  const date = dayjs().format('ddd, DD MMM YYYY HH:mm:ss');
  const timeStamp = dayjs().format('ddd, DD MMM YYYY HH:mm:ss'); //メモ用のタイムスタンプ
  const frontMatterSource = await insertTemplateByKey(view,"r-style_template")
  // 置き換えたい変数
  const URL = encodeURIComponent(selectedText)
  const vars = {
    title: selectedText,
    date: date,
    url: URL
  };
  const frontMatter = await renderTemplate(frontMatterSource, vars);

  const inserted = selection.empty ? date : frontMatter;

  

  editorView.dispatch({
    changes: selection.empty
      // 選択なし → カーソル位置に挿入
      ? { from: selection.from, insert: date }
      // 選択あり → 選択範囲を置き換え
      : { from: selection.from, to: selection.to, insert: frontMatter },
    selection: {
      // 挿入後にカーソルを挿入テキストの後ろに移動
      anchor: selection.from + inserted.length
    },
    scrollIntoView: true
  });
}
console.log('Renderer script with CodeMirror loaded.');

async function insertTemplateByKey(view, key) {
  const result = await window.electronAPI.loadMdFile(key);
  if (result.success) {
    const text = result.content;
    console.log(text)
    return text
    //insertText(view, text); // 以前定義したinsertText関数を呼ぶ
  } else {
    console.error('テンプレート読み込み失敗:', result.error);
    // 必要に応じてユーザーに通知
  }
}

//テンプレート展開の補助
function renderTemplate(templateText, vars) {
  return templateText.replace(/\$\{(\w+)\}/g, (match, p1) => {
    return vars[p1] !== undefined ? vars[p1] : match;
  });
}

// IPC: メインから選択テキスト要求が来たら取得して送信
window.electronAPI.onRequestSelectedText(() => {
  if (!editorView) {
    window.electronAPI.sendSelectedText("");
    return;
  }
  const state = editorView.state;
  const selection = state.sliceDoc(
    state.selection.main.from,
    state.selection.main.to
  );
  window.electronAPI.sendSelectedText(selection);
});

// IPC: 新規ウィンドウ初期テキスト設定
window.electronAPI.onInitText((text) => {
  if (editorView) {
    // 新しいドキュメント内容をセット
    const transaction = editorView.state.update({
      changes: { from: 0, to: editorView.state.doc.length, insert: text }
    });
    editorView.dispatch(transaction);
  } else {
    console.log("エディタはありません")
  }
});

// ワークスペース: main からのエディタ状態問い合わせに返答する
window.electronAPI.onGetEditorState(({ winId }) => {
  if (!editorView) return;
  window.electronAPI.sendEditorStateReply(winId, {
    scrollTop: editorView.scrollDOM.scrollTop,
    cursorLine: editorView.state.doc.lineAt(
      editorView.state.selection.main.head
    ).number,
  });
});

// Tab幅単位削除
function deleteIndentation(view) {
  const { state, dispatch } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);

  // 行頭スペースの範囲
  const indent = line.text.match(/^ +/);

  if (indent && range.head <= line.from + indent[0].length) {
    // Tab幅単位で削除
    const unit = state.facet(indentUnit).length || 2;
    const deleteFrom = Math.max(line.from, range.head - unit);
    dispatch(state.update({
      changes: { from: deleteFrom, to: range.head },
      selection: { anchor: deleteFrom }
    }));
    return true;
  }

  // 行頭以外は通常の Backspace に委譲
  return deleteCharBackward(view);
}
// ---- モーダルファイラー状態 ----
// ---- モーダルファイラー状態 ----
const filerState = {
  currentFolder: null,
  rootFolder: null,
  items: [],          // 絞り込み前の全アイテム
  filtered: [],       // 絞り込み後のアイテム（カーソル対象）
  cursorIndex: 0,
  sortBy: 'name',
  sortLabels: { name: '名前順', updatedAt: '更新日順', createdAt: '作成日順' },
  inlineMode: null,   // null | 'create' | 'rename'
};

// DOM参照
const filerOverlay    = document.getElementById('modalOverlayO');
const filerList       = document.getElementById('filerList');
const filerBreadcrumb = document.getElementById('filerBreadcrumb');
const filerMeta       = document.getElementById('filerMeta');
const filerSearchInput = document.getElementById('filerSearchInput');
const filerInlineInput = document.getElementById('filerInlineInput');
const filerInputField  = document.getElementById('filerInputField');

// ---- 起点フォルダの決定 ----
async function filerResolveStartFolder() {
  const ws = await window.electronAPI.getCurrentWorkspace();
  const currentFile = window.currentFilePath;

  if (ws && ws.rootFolder) {
    filerState.rootFolder = ws.rootFolder;
    if (currentFile && currentFile.startsWith(ws.rootFolder)) {
      return currentFile.substring(0, currentFile.lastIndexOf('/')) || ws.rootFolder;
    } else {
      return ws.rootFolder;
    }
  } else {
    filerState.rootFolder = null;
    if (currentFile && currentFile !== '') {
      return currentFile.substring(0, currentFile.lastIndexOf('/'));
    } else {
      return null;
    }
  }
}

// ---- モーダルを開く ----
async function filerOpen() {
  const startFolder = await filerResolveStartFolder();
  filerState.sortBy = 'name';
  filerSearchInput.value = '';

  if (!startFolder) {
    filerShowNotice('ファイルが保存されていないため、フォルダを特定できません。\nまずファイルを保存するか、ワークスペースを開いてください。');
    filerOverlay.classList.remove('hidden');
    filerSearchInput.focus();
    return;
  }

  await filerNavigateTo(startFolder);
  filerOverlay.classList.remove('hidden');

  // 現在開いているファイルにカーソルを合わせる
  if (window.currentFilePath) {
    const currentName = window.currentFilePath
      .split('/').pop()
      .replace(/\.[^/.]+$/, '');
    const idx = filerState.filtered.findIndex(
      item => item.type === 'file' && item.data.name === currentName
    );
    if (idx >= 0) filerSetCursor(idx);
  }

  filerSearchInput.focus();
}

// ---- 案内メッセージ表示 ----
function filerShowNotice(message) {
  filerList.innerHTML = `<li class="filer-notice">${message.replace(/\n/g, '<br>')}</li>`;
  filerBreadcrumb.textContent = '';
  filerMeta.textContent = '';
}

// ---- フォルダへ移動して一覧を描画 ----
async function filerNavigateTo(folderPath) {
  console.log('[filer] navigateTo:', folderPath);
  filerState.currentFolder = folderPath;
  filerHideInlineInput();
  filerSearchInput.value = '';

  const { folders, files } = await window.electronAPI.listFiles(folderPath, filerState.sortBy);
  console.log('[filer] listFiles result:', folders.length, 'folders,', files.length, 'files');

  const items = [];

  if (filerCanGoUp(folderPath)) {
    items.push({ type: 'up' });
  }

  items.push({ type: 'separator' });

  for (const f of folders) items.push({ type: 'folder', data: f });
  for (const f of files)   items.push({ type: 'file',   data: f });

  filerState.items = items;
  console.log('[filer] items.length:', filerState.items.length);
  filerApplyFilter('');
  console.log('[filer] filtered.length:', filerState.filtered.length);
  requestAnimationFrame(() => filerSearchInput.focus());
}

function filerCanGoUp(folderPath) {
  if (!filerState.rootFolder) return true;
  return folderPath !== filerState.rootFolder &&
         folderPath.startsWith(filerState.rootFolder + '/');
}

// ---- 絞り込み適用 ----
function filerApplyFilter(query) {
  const q = query.trim().toLowerCase();

  if (!q) {
    filerState.filtered = filerState.items;
  } else {
    // separatorとupは常に除外、フォルダ・ファイル名でフィルタ
    filerState.filtered = filerState.items.filter(item => {
      if (item.type === 'separator' || item.type === 'up') return false;
      const name = item.data.name.toLowerCase();
      return name.includes(q);
    });
  }

  // カーソルを先頭の選択可能な行にリセット
  const firstSelectable = filerState.filtered.findIndex(
    i => i.type === 'folder' || i.type === 'file'
  );
  filerState.cursorIndex = firstSelectable >= 0 ? firstSelectable : 0;

  filerRender();
}

// ---- 一覧を描画 ----
function filerRender() {
  filerList.innerHTML = '';

  const totalFolders = filerState.filtered.filter(i => i.type === 'folder').length;
  const totalFiles   = filerState.filtered.filter(i => i.type === 'file').length;

  filerBreadcrumb.textContent = filerMakeBreadcrumb(filerState.currentFolder);
  filerMeta.textContent =
    `フォルダ ${totalFolders}  ファイル ${totalFiles}　${filerState.sortLabels[filerState.sortBy]}`;

  filerState.filtered.forEach((item, idx) => {
    const li = document.createElement('li');

    if (item.type === 'up') {
      li.className = 'filer-up';
      li.textContent = '↑ 上に戻る';
      li.addEventListener('click', () => filerGoUp());

    } else if (item.type === 'separator') {
      li.className = 'filer-separator';

    } else if (item.type === 'folder') {
      li.className = 'filer-folder';
      if (idx === filerState.cursorIndex) li.classList.add('selected');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'filer-name';
      nameSpan.textContent = '▶ ' + item.data.name;
      li.appendChild(nameSpan);

      li.addEventListener('click', () => {
        filerSetCursor(idx);
        filerEnter();
      });

    } else if (item.type === 'file') {
      li.className = 'filer-file';
      if (idx === filerState.cursorIndex) li.classList.add('selected');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'filer-name';
      nameSpan.textContent = item.data.name + (item.data.ext || '');
      li.appendChild(nameSpan);

      if (item.data.firstLine) {
        const firstLineSpan = document.createElement('span');
        firstLineSpan.className = 'filer-first-line';
        firstLineSpan.textContent = item.data.firstLine;
        li.appendChild(firstLineSpan);
      }

      const dateSpan = document.createElement('span');
      dateSpan.className = 'filer-date';
      dateSpan.textContent = item.data.updatedAt;
      li.appendChild(dateSpan);

      li.addEventListener('click', (e) => {
        filerSetCursor(idx);
        if (e.shiftKey) filerOpenInNewWindow();
        else filerEnter();
      });
    }

    filerList.appendChild(li);
  });

  filerScrollToCursor();
}

// ---- パンくず生成 ----
function filerMakeBreadcrumb(folderPath) {
  if (!folderPath) return '';
  const root = filerState.rootFolder;
  if (root && folderPath.startsWith(root)) {
    const rootName = root.split('/').pop();
    const rel = folderPath.slice(root.length);
    const parts = rel.split('/').filter(Boolean);
    return [rootName, ...parts].join(' / ');
  }
  const parts = folderPath.split('/').filter(Boolean);
  return '…/' + parts.slice(-2).join('/');
}

// ---- カーソル操作 ----
function filerSetCursor(idx) {
  filerState.cursorIndex = idx;
  const lis = filerList.querySelectorAll('li');
  lis.forEach((li, i) => li.classList.toggle('selected', i === idx));
  filerScrollToCursor();
}

function filerMoveCursor(delta) {
  const items = filerState.filtered;
  let idx = filerState.cursorIndex + delta;
  while (idx >= 0 && idx < items.length && items[idx].type === 'separator') {
    idx += delta;
  }
  if (idx < 0) idx = 0;
  if (idx >= items.length) idx = items.length - 1;
  filerSetCursor(idx);
}

function filerScrollToCursor() {
  const lis = filerList.querySelectorAll('li');
  const selected = lis[filerState.cursorIndex];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ---- 上の階層へ ----
async function filerGoUp() {
  const current = filerState.currentFolder;
  if (!filerCanGoUp(current)) return;
  const parent = current.substring(0, current.lastIndexOf('/')) || '/';
  await filerNavigateTo(parent);
}

// ---- Enter ----
async function filerEnter() {
  const item = filerState.filtered[filerState.cursorIndex];
  if (!item) return;

  if (item.type === 'up') {
    await filerGoUp();
  } else if (item.type === 'folder') {
    await filerNavigateTo(item.data.path);
  } else if (item.type === 'file') {
    window.electronAPI.openFile(item.data.path, window.currentFilePath ?? '');
    filerClose();
  }
}

// ---- Shift+Enter: 新規ウィンドウで開く ----
// 第2引数(currentFilePath)を渡さないことで、main.js側が新規ウィンドウで開く
function filerOpenInNewWindow() {
  const item = filerState.filtered[filerState.cursorIndex];
  if (!item || item.type !== 'file') return;
  window.electronAPI.openFile(item.data.path);
  filerClose();
}

// ---- ソート切替 ----
async function filerToggleSort() {
  const order = ['name', 'updatedAt', 'createdAt'];
  const current = order.indexOf(filerState.sortBy);
  filerState.sortBy = order[(current + 1) % order.length];
  await filerNavigateTo(filerState.currentFolder);
}

// ---- 新規ファイル作成 ----
function filerStartCreate() {
  filerState.inlineMode = 'create';
  filerShowInlineInput('新規ファイル名（.md 省略可）:', '');
}

async function filerCommitCreate(fileName) {
  if (!fileName.trim()) { filerHideInlineInput(); return; }
  const result = await window.electronAPI.createFile(filerState.currentFolder, fileName.trim());
  if (result.success) {
    await filerNavigateTo(filerState.currentFolder);
    const baseName = fileName.trim().replace(/\.md$/, '');
    const idx = filerState.filtered.findIndex(
      i => i.type === 'file' && i.data.name === baseName
    );
    if (idx >= 0) filerSetCursor(idx);
  } else {
    alert(result.error || '作成に失敗しました');
  }
  filerHideInlineInput();
  filerSearchInput.focus();
}

// ---- 名前変更 ----
function filerStartRename() {
  const item = filerState.filtered[filerState.cursorIndex];
  if (!item || item.type !== 'file') return;
  filerState.inlineMode = 'rename';
  filerShowInlineInput('新しいファイル名:', item.data.name);
}

async function filerCommitRename(newName) {
  if (!newName.trim()) { filerHideInlineInput(); return; }
  const item = filerState.filtered[filerState.cursorIndex];
  if (!item || item.type !== 'file') { filerHideInlineInput(); return; }

  const result = await window.electronAPI.renameFile(item.data.path, newName.trim());
  if (result.success) {
    await filerNavigateTo(filerState.currentFolder);
    const baseName = newName.trim().replace(/\.md$/, '');
    const idx = filerState.filtered.findIndex(
      i => i.type === 'file' && i.data.name === baseName
    );
    if (idx >= 0) filerSetCursor(idx);
  } else {
    alert(result.error || '名前変更に失敗しました');
  }
  filerHideInlineInput();
  filerSearchInput.focus();
}

// ---- 削除 ----
async function filerDelete() {
  const item = filerState.filtered[filerState.cursorIndex];
  if (!item || item.type !== 'file') return;
  const result = await window.electronAPI.deleteFile(item.data.path);
  if (result.success) {
    await filerNavigateTo(filerState.currentFolder);
  }
  filerSearchInput.focus();
}

// ---- インライン入力UI ----
function filerShowInlineInput(placeholder, defaultValue) {
  filerInlineInput.classList.remove('hidden');
  filerInputField.placeholder = placeholder;
  filerInputField.value = defaultValue;
  filerInputField.focus();
  filerInputField.select();
}

function filerHideInlineInput() {
  filerState.inlineMode = null;
  filerInlineInput.classList.add('hidden');
  filerInputField.value = '';
}

// ---- 閉じる ----
function filerClose() {
  filerOverlay.classList.add('hidden');
  filerHideInlineInput();
  filerSearchInput.value = '';
  if (typeof editorView !== 'undefined') editorView.focus();
}

// ---- 検索inputのイベント ----

// 文字入力 → 絞り込み
filerSearchInput.addEventListener('input', () => {
  filerApplyFilter(filerSearchInput.value);
});

// キーボードナビゲーションはすべてここで処理
// （inputにフォーカスがある前提なので、document全体への干渉は最小限）
filerSearchInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    // インライン入力欄が開いていればそちらへ、なければ移動しない
    if (filerState.inlineMode) filerInputField.focus();
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      filerMoveCursor(+1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      filerMoveCursor(-1);
      break;
    case 'Enter':
      e.preventDefault();
      if (e.shiftKey) filerOpenInNewWindow();
      else await filerEnter();
      break;
    case 'ArrowRight': {
      e.preventDefault();
      const item = filerState.filtered[filerState.cursorIndex];
      if (item && item.type === 'folder') {
        await filerNavigateTo(item.data.path);
      }
      break;
    }
    case 'ArrowLeft':
      e.preventDefault();
      await filerGoUp();
      break;
    case 'Escape':
      e.preventDefault();
      if (filerSearchInput.value) {
        // 入力があればまずクリア
        filerSearchInput.value = '';
        filerApplyFilter('');
      } else {
        filerClose();
      }
      break;
    default:
      // Cmd+N/R/D/S: 修飾キー付きコマンド（文字入力と衝突しない）
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case 'n':
            e.preventDefault();
            filerStartCreate();
            break;
          case 'r':
            e.preventDefault();
            filerStartRename();
            break;
          case 'd':
            e.preventDefault();
            await filerDelete();
            break;
          case 's':
            e.preventDefault();
            await filerToggleSort();
            break;
        }
      }
      break;
  }
});

// ---- インライン入力のキーハンドラ ----
filerInputField.addEventListener('keydown', async (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    filerSearchInput.focus();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = filerInputField.value;
    if (filerState.inlineMode === 'create') await filerCommitCreate(val);
    else if (filerState.inlineMode === 'rename') await filerCommitRename(val);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    filerHideInlineInput();
    filerSearchInput.focus();
  }
});

// 背景クリックで閉じる
filerOverlay.addEventListener('click', (e) => {
  if (e.target === filerOverlay) filerClose();
});

/**
 * 現在のワークスペースフォルダでターミナルを開く。
 * ワークスペースにフォルダが設定されていなければ指定なしで開く。
 */
function openTerminalHere() {
  const dirPath = filerState.rootFolder ?? null;
  window.electronAPI.openTerminal(dirPath);
}

// ── コマンドパレット ────────────────────────────────────────────
const cpOverlay  = document.getElementById('command-palette-overlay');
const cpList     = document.getElementById('command-palette-list');
const cpStatus   = document.getElementById('command-palette-status');

let cpCommands    = [];
let cpSelectedIdx = 0;

async function cpOpen() {
  const workspaceRoot = filerState.rootFolder ?? null;
  try {
    cpCommands = await window.electronAPI.getCommands(workspaceRoot);
  } catch (e) {
    console.error('[CommandPalette] getCommands failed:', e);
    cpCommands = [];
  }
  cpSelectedIdx = 0;
  cpRender();
  cpStatus.textContent = '';
  cpOverlay.style.display = 'flex';
  cpOverlay.focus();
}

function cpClose() {
  if (!cpOverlay) return;
  cpOverlay.style.display = 'none';
  if (typeof editorView !== 'undefined') editorView.focus();
}

function cpRender() {
  cpList.innerHTML = '';
  if (cpCommands.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'コマンドが登録されていません';
    li.style.color = '#888';
    li.style.pointerEvents = 'none';
    cpList.appendChild(li);
    return;
  }
  cpCommands.forEach((cmd, i) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = cmd.name;
    li.appendChild(nameSpan);
    if (cmd.source === 'local') {
      const badge = document.createElement('span');
      badge.className   = 'cp-label-local';
      badge.textContent = 'local';
      li.appendChild(badge);
    }
    if (i === cpSelectedIdx) li.classList.add('cp-selected');
    li.addEventListener('click', () => cpExecute(i));
    cpList.appendChild(li);
  });
}

function cpUpdateSelection(newIdx) {
  const items = cpList.querySelectorAll('li');
  if (items[cpSelectedIdx]) items[cpSelectedIdx].classList.remove('cp-selected');
  cpSelectedIdx = Math.max(0, Math.min(newIdx, cpCommands.length - 1));
  if (items[cpSelectedIdx]) {
    items[cpSelectedIdx].classList.add('cp-selected');
    items[cpSelectedIdx].scrollIntoView({ block: 'nearest' });
  }
}

async function cpExecute(idx) {
  const cmd = cpCommands[idx];
  if (!cmd) return;
  cpClose();

  const filePath = window.currentFilePath ?? '';
  const context = {
    file:      filePath,
    dir:       filePath ? filePath.substring(0, filePath.lastIndexOf('/')) : '',
    basename:  filePath ? filePath.split('/').pop().replace(/\.[^.]+$/, '') : '',
    workspace: filerState.rootFolder ?? '',
  };

  let result;
  try {
    result = await window.electronAPI.runCommand(cmd, context);
  } catch (e) {
    result = { success: false, exitCode: -1, stdout: '', stderr: e.message };
  }

  cpShowToast(cmd.name, result);
}

cpOverlay.setAttribute('tabindex', '-1');
cpOverlay.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'Escape':    e.preventDefault(); cpClose();                             break;
    case 'ArrowDown': e.preventDefault(); cpUpdateSelection(cpSelectedIdx + 1); break;
    case 'ArrowUp':   e.preventDefault(); cpUpdateSelection(cpSelectedIdx - 1); break;
    case 'Enter':     e.preventDefault(); cpExecute(cpSelectedIdx);             break;
  }
});

cpOverlay.addEventListener('click', (e) => {
  if (e.target === cpOverlay) cpClose();
});
// ── コマンドパレット ここまで ───────────────────────────────────

// ── コマンド結果トースト ────────────────────────────────────────
let cpToastTimer = null;

function cpShowToast(commandName, result) {
  // 既存のトーストがあれば流用、なければ作成
  let toast = document.getElementById('cp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cp-toast';
    document.body.appendChild(toast);
  }

  // ヘッダー行（コマンド名 ＋ 成否）
  const icon   = result.success ? '✓' : '✗';
  const output = result.success ? result.stdout : result.stderr;
  const lines  = (output ?? '').trim();

  toast.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'cp-toast-header';
  header.textContent = `${icon} ${commandName}`;
  toast.appendChild(header);

  if (lines) {
    const body = document.createElement('pre');
    body.className = 'cp-toast-body';
    body.textContent = lines;
    toast.appendChild(body);
  }

  // 閉じるボタン
  const closeBtn = document.createElement('button');
  closeBtn.className = 'cp-toast-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => cpHideToast());
  toast.appendChild(closeBtn);

  toast.classList.remove('cp-toast-hidden');
  toast.classList.add('cp-toast-visible', result.success ? 'cp-toast-success' : 'cp-toast-error');

  // 出力がなければ3秒で自動的に消える、あれば手動で閉じるまで残す
  clearTimeout(cpToastTimer);
  if (!lines) {
    cpToastTimer = setTimeout(cpHideToast, 3000);
  }
}

function cpHideToast() {
  const toast = document.getElementById('cp-toast');
  if (!toast) return;
  toast.classList.remove('cp-toast-visible', 'cp-toast-success', 'cp-toast-error');
  toast.classList.add('cp-toast-hidden');
}
// ── コマンド結果トースト ここまで ──────────────────────────────
