import { keymap } from '@codemirror/view';
import { EditorView } from "@codemirror/view";
import { foldCode, unfoldCode ,foldable,foldService,foldEffect,unfoldEffect } from '@codemirror/language';

/**
 * カーソル行を一行上に移動します。
 * @param {object} view - CodeMirrorのviewオブジェクト
 * @returns {boolean}
 */
function moveLineUp({ state, dispatch }) {
  const selection = state.selection.main;
  const currentLine = state.doc.lineAt(selection.head);

  // 先頭行の場合は何もしない
  if (currentLine.number === 1) {
    return false;
  }

  const prevLine = state.doc.line(currentLine.number - 1);
  
  // 現在の行と前の行のテキストを入れ替える
  const newText = `${state.doc.sliceString(currentLine.from, currentLine.to)}\n${state.doc.sliceString(prevLine.from, prevLine.to)}`;

  dispatch({
    changes: { 
      from: prevLine.from, 
      to: currentLine.to, 
      insert: newText 
    },
    // カーソル位置を維持する
    selection: { anchor: prevLine.from + (selection.head - currentLine.from) }
  });

  return true;
}

/**
 * カーソル行を一行下に移動します。
 * @param {object} view - CodeMirrorのviewオブジェクト
 * @returns {boolean}
 */
function moveLineDown({ state, dispatch }) {
  const selection = state.selection.main;
  const currentLine = state.doc.lineAt(selection.head);

  // 最終行の場合は何もしない
  if (currentLine.number === state.doc.lines) {
    return false;
  }

  const nextLine = state.doc.line(currentLine.number + 1);
  
  const currentLineText = state.doc.sliceString(currentLine.from, currentLine.to);
  const nextLineText = state.doc.sliceString(nextLine.from, nextLine.to);

  // 現在の行と次の行のテキストを入れ替える
  const newText = `${nextLineText}\n${currentLineText}`;
  
  const posInLine = selection.head - currentLine.from;
  // 入れ替え後、カーソルは元の行内での相対位置を維持する
  const newCursorPos = currentLine.from + nextLineText.length + 1 + posInLine;

  dispatch({
    changes: { 
      from: currentLine.from, 
      to: nextLine.to, 
      insert: newText 
    },
    selection: { anchor: newCursorPos }
  });

  return true;
}

/**
 * コードの折りたたみ（fold/unfold）を賢く切り替えます。
 * 展開されている場合は折りたたみ、折りたたまれている場合は展開します。
 * @param {object} view - CodeMirrorのviewオブジェクト
 * @returns {boolean}
 */
function smartToggleFold(view) {
  // 展開を試みる (展開を優先)
  if (unfoldCode(view)) {
    return true;
  }
  // 展開できなければ、折りたたみを試みる
  if (foldCode(view)) {
    return true;
  }
  return false;
}

function foldAllHeading2 (view) {
  const { state } = view;
  const { doc } = state;

  // 全行を走査
  for (let pos = 0; pos < doc.length; ) {
    const line = doc.lineAt(pos);

    // 見出し2を発見
    if (line.text.startsWith("## ")) {
      const from = line.to

      // 次の同レベル以上の見出しを探す
      let to = doc.length; // 最後まで
      let nextPos = line.to + 1;
      while (nextPos < doc.length) {
        const nextLine = doc.lineAt(nextPos);
        const text = nextLine.text;
        if (text.startsWith("## ") || text.startsWith("# ")) {
          to = nextLine.from - 1; // 次の見出しの直前まで
          break;
        }
        nextPos = nextLine.to + 1;
      }

      // 折りたたみ実行
      view.dispatch({ effects: foldEffect.of({ from, to }) });
    }

    pos = line.to + 1;
  }

  return true;
};

/**
 * 指定レベルの見出しブロックをすべて展開する
 * @param {EditorView} view
 * @param {number} level - 展開対象の見出しレベル (#=1, ##=2, ...)
 */
function unfoldHeadingLevel(view, level = 2) {
  const cursorPos = view.state.selection.main.head; 

  const { state } = view;
  const { doc } = state;

  const headingPrefix = "#".repeat(level) + " ";

  for (let pos = 0; pos < doc.length; ) {
    const line = doc.lineAt(pos);
    const text = line.text;

    // 指定レベルの見出しを発見
    if (text.startsWith(headingPrefix)) {
      const from = line.to; // 見出し行自体は表示したまま
      // 次の同レベル以上の見出しまでを探す
      let to = doc.length;
      let nextPos = line.to + 1;
      while (nextPos < doc.length) {
        const nextLine = doc.lineAt(nextPos);
        const nextText = nextLine.text;
        if (/^#+ /.test(nextText) && nextText.match(/^#+/)[0].length <= level) {
          to = nextLine.from - 1;
          break;
        }
        nextPos = nextLine.to + 1;
      }

      if (from <= to) {
        view.dispatch({ effects: unfoldEffect.of({ from, to }) });
      }
    }

    pos = line.to + 1;
  }

  console.log(cursorPos + "スクロールします")

  view.dispatch({
    effects: EditorView.scrollIntoView(cursorPos, { y: "center" })
  });

  return true;
}


/**
 * テキスト編集関連のカスタムキーマップです。
 * Modは、Macの場合はCmd、Windows/Linuxの場合はCtrlを表します。
 */
export const editingKeymap = [
  {
    key: "Mod-Alt-ArrowUp",
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
    key: "Mod-Shift-Alt-ArrowUp", // macOS: Command + Shift + Option + ↑
    preventDefault: true,
    run: foldAllHeading2
  },
    {
    key: "Mod-Shift-Alt-ArrowDown", // macOS: Command + Shift + Option + ↑
    preventDefault: true,
    run: (view)=>unfoldHeadingLevel(view,2)
  }
]
