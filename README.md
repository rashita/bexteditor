
# BextEditor

!!This project is still incomplete!!

BextEditor is a simple, lightweight text editor built with Electron and CodeMirror. It's designed for a clean, focused writing experience, primarily for Markdown files.

## Features

*   **Markdown Support:** Enhanced for Markdown editing with syntax highlighting.
*   **File Operations:** Create new files, open existing files, and save your work.
*   **Cross-Platform:** Works on macOS.
*   **macOSの終了動作:** 最後のウィンドウを閉じてもアプリは終了しません。Dockアイコンをクリックすると、編集ウィンドウがなければ空のウィンドウを開きます。アプリを終了するにはメニューの「終了」または `Cmd+Q` を使用してください。
*   **Task Lists:** Supports GFM-style task lists (`- [ ]` and `- [x]`).
*   **Line Movement:** Move lines up and down with `Cmd/Ctrl+Alt+ArrowUp/Down`.
*   **Line Numbers:** Hidden on startup. Toggle **View → 行番号を表示** to show or hide them in all editor windows during the current session. The gutter keeps the same width when numbers are hidden, with room for at least three digits.

## Getting Started

### Prerequisites

*   [Node.js](https://nodejs.org/)

### Installation & Launch

1.  Clone the repository:
    ```bash
    git clone https://github.com/your-username/bext-editor.git
    ```
2.  Navigate to the project directory:
    ```bash
    cd bext-editor
    ```
3.  Install dependencies:
    ```bash
    npm install
    ```
4.  Start the application:
    ```bash
    npm start
    ```

## Building the Application

To create a distributable application package, run the following command:

```bash
npm run build
```

This will generate an application file in the `dist` directory.

## URLスキーム

`bexteditor://`（`bext-editor://` も使用可能）で次の操作ができます。

| URL | 動作 |
| :--- | :--- |
| `bexteditor://launch` | アプリを起動し、既存の編集ウィンドウを前面に表示。なければ空の文書を開く。 |
| `bexteditor://new` | 新しい未保存の文書を開く。 |
| `bexteditor://new?path=/Users/yourname/Documents/note.md` | 指定した絶対パスに空のファイルを作成して開く。 |
| `bexteditor://open?path=/Users/yourname/Documents/note.md` | 既存のファイルを開く。 |

`new` には任意の `content` パラメータで初期本文を渡せます。
`path` を指定する場合、親フォルダはあらかじめ作成してください。
同名ファイルが存在する場合はエラーを表示し、上書きしません。
パラメータの値は `encodeURIComponent` などでURLエンコードしてください（特に `&`、`#`、改行）。

```javascript
const url = 'bexteditor://new?path=' + encodeURIComponent('/Users/yourname/Documents/note.md')
  + '&content=' + encodeURIComponent('# 新しいメモ\n');
```

変更をインストール済みアプリに反映するには、`npm run build` で再ビルドし、アプリを入れ替えてください。

## Keyboard Shortcuts

See the complete list in [KEYBINDINGS.md](KEYBINDINGS.md).

| Command | Shortcut (macOS) | Shortcut (Win/Linux) |
| :--- | :--- | :--- |
| Move Line Up | `Cmd + Option + ↑` | `Ctrl + Alt + ↑` |
| Move Line Down | `Cmd + Option + ↓` | `Ctrl + Alt + ↓` |
| Toggle Heading Fold | `Cmd + Option + →` | `Ctrl + Alt + →` |
| Toggle Task (`- [ ]` / `- [x]`) | `Cmd + L` | `Ctrl + L` |
| Open File / Filer | `Cmd + O` | `Ctrl + O` |
| Quick Open | `Cmd + P` | `Ctrl + P` |
| Command Palette | `Cmd + Shift + P` | `Ctrl + Shift + P` |
| Save File | `Cmd + S` | `Ctrl + S` |

## Tech Stack

*   **Framework:** [Electron](https://www.electronjs.org/)
*   **Editor Component:** [CodeMirror](https://codemirror.net/)
*   **Bundler:** [esbuild](https://esbuild.github.io/)
*   **Packaging:** [electron-builder](https://www.electron.build/)

## License

This project is licensed under the ISC License.
