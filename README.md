
# BextEditor

!!This project is still incomplete!!

BextEditor is a simple, lightweight text editor built with Electron and CodeMirror. It's designed for a clean, focused writing experience, primarily for Markdown files.

## Features

*   **Markdown Support:** Enhanced for Markdown editing with syntax highlighting.
*   **File Operations:** Create new files, open existing files, and save your work.
*   **Cross-Platform:** Works on macOS.
*   **Task Lists:** Supports GFM-style task lists (`- [ ]` and `- [x]`).
*   **Line Movement:** Move lines up and down with `Cmd/Ctrl+Alt+ArrowUp/Down`.

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

## Keyboard Shortcuts

| Command | Shortcut (macOS) |
| :--- | :--- |
| Move Line Up | `Cmd` + `Alt` + `↑` |
| Move Line Down | `Cmd` + `Alt` + `↓` |
| New File | `Cmd` + `N` |
| Open File | `Cmd` + `O` |
| Save File | `Cmd` + `S` |

## Tech Stack

*   **Framework:** [Electron](https://www.electronjs.org/)
*   **Editor Component:** [CodeMirror](https://codemirror.net/)
*   **Bundler:** [esbuild](https://esbuild.github.io/)
*   **Packaging:** [electron-builder](https://www.electron.build/)

## License

This project is licensed under the ISC License.
