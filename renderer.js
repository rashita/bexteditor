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
    // a.addEventListener("click", (e) => {
    //   e.preventDefault()
    //   shell.openExternal(this.url)
    // })
    return a
  }

  ignoreEvent() { return false }
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
    const builder = new RangeSetBuilder()
    const selections = view.state.selection.ranges
    for (let { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to)
      //const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g
      //const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
      const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g
      const imgRegex = /!([^\]]+)\]\((https?:\/\/[^\)]+)\)/g 

      let match
      while ((match = regex.exec(text)) !== null) {

        const isImage = text[match.index + 1] === "!"
        console.log(match.index)
        console.log(text[match.index+ 1])
        if (isImage) continue

        const start = from + match.index

        const end = start + match[0].length
        const url = match[2]
        const linkText = match[1]

        // カーソルが範囲内にあれば Decoration を付けない
        const cursorInside = selections.some(sel => sel.from <= end && sel.to >= start)
        if (cursorInside) continue

        // Decoration.widget で <a> ノードを差し込む
         // WidgetType を継承したクラスで <a> を生成

        const widget = Decoration.widget({
          widget: new LinkWidget(linkText, url),
          side: 1
        })
        
       
        // 元のテキストを置き換えるように widget を配置
        builder.add(start, end, widget)
      }
    }
    return builder.finish()
  }
}, {
  decorations: v => v.decorations
})


//タイマー用のプラグイン
export const timerPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    const statusBar = document.getElementById("status-bar");
    if (!statusBar) return;

    this.dom = document.createElement("div");
    this.dom.className = "cm-timer";
    this.dom.style.cursor = "pointer";
    this.dom.style.display = "none";

    // タイマー表示
    this.timerDisplay = document.createElement("span");
    this.timerDisplay.id = "timer-display";
    this.timerDisplay.textContent = "▶ 00:00";
    this.dom.appendChild(this.timerDisplay);

    // タスク表示
    this.taskDisplay = document.createElement("span");
    this.taskDisplay.id = "task-display";
    this.taskDisplay.style.userSelect = "none";
    this.taskDisplay.textContent = "タスクを選択...";
    this.taskDisplay.style.cursor = "pointer";
    this.taskDisplay.style.marginLeft = "12px";
    this.taskDisplay.style.color = "#888";
    this.dom.appendChild(this.taskDisplay);

    // 候補リスト
    this.suggestionList = document.createElement("ul");
    this.suggestionList.style.position = "absolute";
    this.suggestionList.style.background = "#fff";
    this.suggestionList.style.border = "1px solid #ccc";
    this.suggestionList.style.listStyle = "none";
    this.suggestionList.style.padding = "0";
    this.suggestionList.style.margin = "0";
    this.suggestionList.style.minWidth = "120px"
    this.suggestionList.style.display = "none";
    this.suggestionList.style.zIndex = 1000;
    document.body.appendChild(this.suggestionList);

    // タスク表示クリックで候補表示
    this.taskDisplay.addEventListener("click", () => {
      if (this.suggestionList.style.display === "block") {
        // すでに表示されている場合は非表示に
        this.suggestionList.style.display = "none";
      } else {
        // 表示されていない場合は候補を生成して表示
        this.showTaskSuggestions();
      }
    });

    // ボタン兼タイマー表示
    this.view = view;
    this.isRunning = false;
    this.elapsed = 0;
    this.intervalId = null;

    // タイマークリックで開始/停止
    this.timerDisplay.addEventListener("click", () => {
      if (this.timer) this.stopTimer();
      else if (this.currentTaskLine) this.startTimer();
    });

    statusBar.appendChild(this.dom);
  }

  extractTasks() {
    const doc = this.view.state.doc;
    const tasks = [];
    for (let i = 0; i < doc.lines; i++) {
      const line = doc.line(i + 1);
      const match = line.text.match(/^\s*-\s\[ \]\s+(.*)$/);
      if (match) tasks.push({ lineNumber: i + 1, text: match[1] });
    }
    return tasks;
  }

  showTaskSuggestions() {
    const tasks = this.extractTasks();
    if (tasks.length === 0) return;

    this.suggestionList.innerHTML = "";
    tasks.forEach(task => {
      const li = document.createElement("li");
      li.textContent = task.text;
      li.style.padding = "4px 8px";
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        this.taskDisplay.textContent = task.text;
        this.taskDisplay.style.color = "#000";
        this.suggestionList.style.display = "none";
        this.currentTaskLine = task.lineNumber;
        this.startTimer();
      });
      this.suggestionList.appendChild(li);
    });

    const statusBar = document.getElementById("status-bar");

    //const rect = statusBar.getBoundingClientRect();
    const rect = this.taskDisplay.getBoundingClientRect();
    this.suggestionList.style.position = "absolute";
    this.suggestionList.style.bottom = `${window.innerHeight - rect.top}px`; // ステータスバー上端に揃える
    this.suggestionList.style.left = `${rect.left + window.scrollX}px`;
    this.suggestionList.style.width = `${rect.width}px`;
    this.suggestionList.style.display = "block";
  }

  startTimer() {
    if (!this.currentTaskLine) return;
    this.startTime = Date.now(); // 開始時刻を保存
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000); // 実時間との差
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      const icon = "■" ; // 停止■
      this.timerDisplay.textContent = `${icon} ${m}:${s}`;
    }, 500); // 500msごとに更新すると滑らか
  }
  stopTimer() { 
    clearInterval(this.timer);
    this.timer = null;
    this.timerDisplay.textContent = "▶ 00:00";

    if (this.currentTaskLine !== null) {
      // エディタ上の該当行を完了にする
      const line = this.view.state.doc.line(this.currentTaskLine);
      const newText = line.text.replace("- [ ]", "- [x]");
      this.view.dispatch({
        changes: { from: line.from, to: line.to, insert: newText }
      });

      // タスク表示をリセット
      this.taskDisplay.textContent = "タスクを選択...";
      this.taskDisplay.style.color = "#888";
      this.currentTaskLine = null;
    }
  }


  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.dom && this.dom.parentNode) {
      this.dom.parentNode.removeChild(this.dom);
    }
  }
});

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
      timerPlugin,
      charCountPlugin,
      hashtagPlugin,
      hashtagSpanTheme,
      fontCompartment.of(EditorView.theme({
        "&": { fontSize: "16px", fontFamily: "serif" },
        ".cm-content":{fontFamily: '"Roboto",Helvetica,Arial,"Hiragino Sans",sans-serif'}
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

//エディタ外のショートカットキー

//モーダル操作
const isMac = navigator.userAgent.includes("Mac");

// DOM取得
const modalOverlayO = document.getElementById("modalOverlayO");
const modalInputO = document.getElementById("modalInputO");
const modalSelectUlO = document.getElementById("modalResultsO");
const modalOverlayP = document.getElementById("modalOverlayP");
const modalInputP = document.getElementById("modalInputP");
let modalEditor = document.getElementById("modal-editor");

// キーボード操作
document.addEventListener("keydown", async (e) => {
  const isCmdO = (isMac && e.metaKey && e.key === "o") || (!isMac && e.ctrlKey && e.key === "o");
  const isCmdP = (isMac && e.metaKey && e.key === "p") || (!isMac && e.ctrlKey && e.key === "p");

  if (isCmdO) {
    e.preventDefault();
    //開いているファイルの名前をチェックする
    const result = await window.electronAPI.readMarkdownFile(window.currentFilePath);
    
    if (result) {
      console.log("読み込みは成功です")
      showModalWithContent(result);
    } else {
      alert("ファイル読み込み失敗: ");
    }
    modalOverlayO.classList.remove("hidden");
    modalInputO.focus();
  }

  if (isCmdP) {
    e.preventDefault();
    modalOverlayP.classList.remove("hidden");
    modalInputP.focus();
  }

  if (e.key === "Escape") {
    modalOverlayO.classList.add("hidden");
    modalOverlayP.classList.add("hidden");
  }
});

// 背景クリックでそれぞれ閉じる
modalOverlayO.addEventListener("click", (e) => {
  if (e.target === modalOverlayO) modalOverlayO.classList.add("hidden");
});
modalOverlayP.addEventListener("click", (e) => {
  if (e.target === modalOverlayP) modalOverlayP.classList.add("hidden");
});

function showModalWithContent(content) {
  //modalInputP
  modalSelectUlO.innerHTML = ""; // 初期化

  modalSelectUlO.classList.add("file-list");

  const lines = content.split("\n").filter(line => line.trim() !== "");

  // li 要素を最初に全部作っておく
  const items = lines.map((line, idx) => {
    const li = document.createElement("li");
    li.textContent = line;
    if (idx === 0) li.classList.add("selected");
    li.addEventListener("click", () => window.electronAPI.openFile(line));
    modalSelectUlO.appendChild(li);
    return li;
  });


  // フィルタリング処理
  modalInputO.oninput = (e) => {
    const query = e.target.value.toLowerCase();
    let firstVisible = null;
    items.forEach(li => {
      if (!query || li.textContent.toLowerCase().includes(query)) {
        li.style.display = "block";
        if (!firstVisible) firstVisible = li;
      } else {
        li.style.display = "none";
        li.classList.remove("selected");
      }
    });
    // 入力後、最初にマッチした項目を選択状態にする
    if (firstVisible) {
      items.forEach(li => li.classList.remove("selected"));
      firstVisible.classList.add("selected");
    }
  };

  // input のカーソル操作
  modalInputO.onkeydown = (e) => {
    const selected = modalSelectUlO.querySelector(".selected");
    console.log("hit key")
    if (!selected) return;
    if (e.key === "ArrowDown") {
          console.log("hit ArrowDown")
      e.preventDefault();
      const next = selected.nextElementSibling;
      if (next) {
        selected.classList.remove("selected");
        next.classList.add("selected");
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = selected.previousElementSibling;
      if (prev) {
        selected.classList.remove("selected");
        prev.classList.add("selected");
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      window.electronAPI.openFile(selected.textContent);
      //モーダルが開いていたら閉じる
      const modalOverlayO = document.getElementById("modalOverlayO");
      modalOverlayO?.classList.contains('hidden') || modalOverlayO.classList.add('hidden');
    }
  };
}


function showModalWithContent_old(content) {
  modalEditor.innerHTML = ""; // 再表示時の初期化

  const smallFontTheme = EditorView.theme({
    '&': {
    },
    '.cm-content': {
      fontSize: '12px',
      fontFamily: 'monospace',
    },
    '.cm-scroller': {
      fontSize: '12px',
    }

  });

  const view = new EditorView({
    doc: content,
    extensions: [
      smallFontTheme,
      EditorView.lineWrapping,
      fileLinkPlugin,
      markdown(),
      EditorView.editable.of(false), // 読み取り専用
    ],
    parent: modalEditor,
  });

  setupClick(view);


}

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

window.electronAPI.onToggleTimer(() => {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar) return;

  // タイマー表示部分の表示/非表示を切り替え
  const timerDom = statusBar.querySelector('.cm-timer');
  if (timerDom) {
    timerDom.style.display = timerDom.style.display === 'none' ? 'inline-block' : 'none';
  }

  const taskDom = statusBar.querySelector('.cm-task');
  if (taskDom) {
    taskDom.style.display = taskDom.style.display === 'none' ? 'inline-block' : 'none';
  }
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