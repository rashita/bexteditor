/**
 * workspace.js
 * ワークスペースの読み書き・管理を担当するモジュール
 * main.js から require('./workspace') して使う
 */

const fs = require('fs');
const pfs = require('fs').promises;
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const log = require('electron-log');
const { addToHistory } = require('./history');

// ワークスペースファイルの名前
const WORKSPACE_FILENAME = '.bext-workspace.json';

// ========================================
// ワークスペースファイルの読み書き
// ========================================

/**
 * 指定フォルダのワークスペースファイルを読み込む
 * ファイルがなければ新規ワークスペースオブジェクトを返す（書き込みはしない）
 * @param {string} rootFolder - プロジェクトフォルダのフルパス
 * @returns {Object} ワークスペースオブジェクト
 */
async function loadWorkspace(rootFolder) {
  const workspacePath = path.join(rootFolder, WORKSPACE_FILENAME);
  try {
    const raw = await pfs.readFile(workspacePath, 'utf-8');
    const data = JSON.parse(raw);
    log.info(`ワークスペースを読み込みました: ${workspacePath}`);
    return data;
  } catch (e) {
    // ファイルが存在しない、またはJSONパース失敗 → 新規として扱う
    log.info(`ワークスペースファイルが見つかりません。新規作成します: ${workspacePath}`);
    return createEmptyWorkspace(rootFolder);
  }
}

/**
 * ワークスペースオブジェクトをファイルに書き込む
 * @param {Object} workspace - ワークスペースオブジェクト
 */
async function saveWorkspace(workspace) {
  const workspacePath = path.join(workspace.rootFolder, WORKSPACE_FILENAME);
  workspace.updatedAt = new Date().toISOString();
  await pfs.writeFile(workspacePath, JSON.stringify(workspace, null, 2), 'utf-8');
  log.info(`ワークスペースを保存しました: ${workspacePath}`);
}

/**
 * 空のワークスペースオブジェクトを生成する
 * @param {string} rootFolder
 * @returns {Object}
 */
function createEmptyWorkspace(rootFolder) {
  return {
    name: path.basename(rootFolder),
    rootFolder,
    openFiles: [],
    updatedAt: new Date().toISOString(),
  };
}

// ========================================
// ウィンドウ状態のスナップショット
// ========================================

/**
 * 現在開いているすべてのエディタウィンドウの状態を収集する
 * レンダラー側から scrollTop / cursorLine を取得するため、
 * 各ウィンドウに問い合わせて Promise.all で待つ
 *
 * @param {Set<BrowserWindow>} windows - main.js の windows Set
 * @param {string} rootFolder - 相対パス計算のベースフォルダ
 * @returns {Promise<Array>} openFiles 配列
 */
async function collectWindowStates(windows, rootFolder) {
  const results = [];

  for (const win of windows) {
    if (win.isDestroyed()) continue;
    const filePath = win.currentFilePath;
    if (!filePath) continue;

    // rootFolder からの相対パスに変換（フォルダ外のファイルはフルパスのまま）
    const relativePath = isInsideFolder(filePath, rootFolder)
      ? path.relative(rootFolder, filePath)
      : filePath;

    // レンダラーにスクロール位置・カーソル行を問い合わせる
    const state = await requestEditorState(win);

    // ウィンドウの位置・サイズを取得
    const { x, y, width, height } = win.getBounds();

    results.push({
      filePath: relativePath,
      scrollTop: state.scrollTop ?? 0,
      cursorLine: state.cursorLine ?? 0,
      x,
      y,
      width,
      height,
    });
  }

  return results;
}

/**
 * ウィンドウのレンダラーにエディタ状態を問い合わせる
 * レンダラー側で 'get-editor-state' を受信し、
 * 'editor-state-reply-{winId}' で { scrollTop, cursorLine } を返す必要がある
 *
 * @param {BrowserWindow} win
 * @returns {Promise<{scrollTop: number, cursorLine: number}>}
 */
function requestEditorState(win) {
  return new Promise((resolve) => {
    const channel = `editor-state-reply-${win.id}`;
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(channel);
      resolve({ scrollTop: 0, cursorLine: 0 }); // タイムアウト時はデフォルト値
    }, 1000);

    ipcMain.once(channel, (_e, state) => {
      clearTimeout(timeout);
      resolve(state);
    });

    win.webContents.send('get-editor-state', { winId: win.id });
  });
}

// ========================================
// ワークスペースの復元
// ========================================

/**
 * ワークスペースの openFiles をもとにウィンドウを復元する
 * 既存ウィンドウはすべて閉じてから開き直す
 *
 * @param {Object} workspace
 * @param {Function} openFileFromPath - main.js の openFileFromPath 関数
 * @param {Set<BrowserWindow>} windows
 */
async function restoreWorkspace(workspace, openFileFromPath, windows, createWindow) {
  // 既存のエディタウィンドウをすべて破棄
  for (const win of [...windows]) {
    if (!win.isDestroyed()) win.destroy();
  }

  const { rootFolder, openFiles } = workspace;

  if (!openFiles || openFiles.length === 0) {
    // 開くファイルがない場合は空ウィンドウを1枚作る
    log.info('ワークスペースに開くファイルがありません。空ウィンドウを作成します');
    createWindow();
    return;
  }

  for (const entry of openFiles) {
    const fullPath = path.isAbsolute(entry.filePath)
      ? entry.filePath
      : path.join(rootFolder, entry.filePath);

    if (!fs.existsSync(fullPath)) {
      log.warn(`復元対象ファイルが存在しません: ${fullPath}`);
      continue;
    }

    // openFileFromPath はウィンドウを作ってファイルを読み込む（win を返す）
    const win = openFileFromPath(fullPath);

    // ウィンドウの位置・サイズを復元（保存データがあれば適用）
    if (win && entry.x != null && entry.y != null) {
      win.setBounds({
        x: entry.x,
        y: entry.y,
        width: entry.width ?? 800,
        height: entry.height ?? 600,
      });
    }

    // スクロール・カーソル位置の復元は、ウィンドウ側の load-file 完了後に
    // レンダラーが workspace:get-restore-state を呼んで行う。
    // ここでは情報をキューに積む形で渡す。
    pendingRestoreStates.set(fullPath, {
      scrollTop: entry.scrollTop ?? 0,
      cursorLine: entry.cursorLine ?? 0,
    });
  }
}

/**
 * ファイルパスごとの復元状態キュー
 * openFileFromPath → load-file 完了後にレンダラーが参照する
 * @type {Map<string, {scrollTop: number, cursorLine: number}>}
 */
const pendingRestoreStates = new Map();

// ========================================
// プロジェクトフォルダのファイル一覧
// ========================================

/**
 * 指定フォルダ内のフォルダ・ファイルを返す
 * @param {string} folderPath
 * @param {'name'|'updatedAt'|'createdAt'} sortBy
 * @returns {{ folders: Array, files: Array }}
 */
async function listProjectFiles(folderPath, sortBy = 'name') {
  const fs = require('fs');
  const path = require('path');

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });

  const folders = [];
  const files = [];

  for (const entry of entries) {
    // 隠しファイル・隠しフォルダをスキップ
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      folders.push({
        name: entry.name,
        path: fullPath,
      });
    } else {
      const stat = fs.statSync(fullPath);
      const ext = path.extname(entry.name);
      const nameWithoutExt = path.basename(entry.name, ext);

      // 1行目の取得（.md ファイルのみ）
      let firstLine = '';
      if (ext === '.md') {
        try {
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const lines = raw.split('\n');

          // frontmatter（--- で囲まれたブロック）をスキップ
          let startIndex = 0;
          if (lines[0] && lines[0].trim() === '---') {
            const closingIndex = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
            if (closingIndex !== -1) startIndex = closingIndex + 1;
          }

          // frontmatter以降の最初の非空行を取得
          const firstRaw = lines.slice(startIndex).find(l => l.trim() !== '') || '';

          // Markdown記法の除去
          firstLine = firstRaw
            .replace(/^#+\s*/, '')              // 見出し
            .replace(/\*\*(.+?)\*\*/g, '$1')    // 太字
            .replace(/\*(.+?)\*/g, '$1')        // イタリック
            .replace(/`(.+?)`/g, '$1')          // インラインコード
            .replace(/^>\s*/, '')               // 引用
            .replace(/^-{3,}$/, '')             // 水平線
            .replace(/\[\[(.+?)\]\]/g, '$1')    // 内部リンク
            .replace(/\[(.+?)\]\(.+?\)/g, '$1') // 外部リンク
            .trim();
        } catch (_) { /* 読めなければ空 */ }
      }

      // 更新日（MM-DD形式）
      const updatedAt = formatDateMMDD(stat.mtime);
      const createdAt = formatDateMMDD(stat.birthtime || stat.mtime);

      files.push({
        name: nameWithoutExt,
        ext,
        path: fullPath,
        firstLine,
        updatedAt,
        createdAt,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: (stat.birthtimeMs || stat.mtimeMs),
      });
    }
  }

  // ソート
  const sortFolders = (a, b) => a.name.localeCompare(b.name, 'ja');
  folders.sort(sortFolders);

  const sortFiles = (() => {
    switch (sortBy) {
      case 'updatedAt': return (a, b) => b.mtimeMs - a.mtimeMs;
      case 'createdAt': return (a, b) => b.birthtimeMs - a.birthtimeMs;
      default:          return (a, b) => a.name.localeCompare(b.name, 'ja');
    }
  })();
  files.sort(sortFiles);

  return { folders, files };
}

function formatDateMMDD(date) {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/**
 * ファイル名から先頭の数字を抽出する
 * "chapter01.md" → 1、"01_intro.md" → 1、"intro.md" → null
 */
function extractLeadingNumber(filename) {
  const m = filename.match(/^[a-zA-Z_\-]*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ========================================
// ユーティリティ
// ========================================

/**
 * filePath が folder の中にあるか判定する
 */
function isInsideFolder(filePath, folder) {
  const rel = path.relative(folder, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ========================================
// IPCハンドラの登録
// ========================================

/**
 * ワークスペース関連のすべてのIPCハンドラを登録する
 * main.js の app.whenReady().then() 内で呼ぶ
 *
 * @param {object} opts
 * @param {Set<BrowserWindow>} opts.windows - main.js の windows Set
 * @param {Function} opts.openFileFromPath - main.js の openFileFromPath 関数
 * @param {Function} opts.createWindow - main.js の createWindow 関数
 */
function registerWorkspaceHandlers({ windows, openFileFromPath, createWindow }) {

  // 現在アクティブなワークスペースをメモリに保持
  let currentWorkspace = null;

  // --------------------------------------------------
  // workspace:open
  // フォルダ選択ダイアログ → ワークスペース読み込み
  // --------------------------------------------------
  ipcMain.handle('workspace:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      message: 'プロジェクトフォルダを選択してください',
    });

    if (canceled || filePaths.length === 0) return { canceled: true };

    const rootFolder = filePaths[0];
    const workspace = await loadWorkspace(rootFolder);
    currentWorkspace = workspace;

    log.info(`ワークスペースを開きました: ${rootFolder}`);
    return { canceled: false, workspace };
  });

  // --------------------------------------------------
  // workspace:save
  // 現在のウィンドウ状態をワークスペースファイルに書き込む
  // --------------------------------------------------
  ipcMain.handle('workspace:save', async () => {
    if (!currentWorkspace) {
      return { success: false, error: 'ワークスペースが開かれていません' };
    }

    try {
      const openFiles = await collectWindowStates(windows, currentWorkspace.rootFolder);
      currentWorkspace.openFiles = openFiles;
      await saveWorkspace(currentWorkspace);
      return { success: true };
    } catch (e) {
      log.error('ワークスペース保存失敗:', e);
      return { success: false, error: e.message };
    }
  });

  // --------------------------------------------------
  // workspace:restore
  // ワークスペースの openFiles をもとにウィンドウを復元する
  // --------------------------------------------------
  ipcMain.handle('workspace:restore', async (_e, workspace) => {
    const target = workspace ?? currentWorkspace;
    if (!target) return { success: false, error: 'ワークスペースが指定されていません' };

    try {
      currentWorkspace = target;
      await restoreWorkspace(target, openFileFromPath, windows, createWindow);
      return { success: true };
    } catch (e) {
      log.error('ワークスペース復元失敗:', e);
      return { success: false, error: e.message };
    }
  });

  // --------------------------------------------------
  // workspace:open-from-path
  // rootFolder パスを直接受け取り、ワークスペースを読み込んで復元する
  // Quick Open パレットの履歴からの復元に使用
  //
  // 引数は文字列（後方互換）またはオブジェクト { rootFolder, saveBeforeSwitch } を受け付ける
  // saveBeforeSwitch: true（デフォルト）のとき、切り替え前に現在のWSを自動保存する
  // --------------------------------------------------
  ipcMain.handle('workspace:open-from-path', async (_e, arg) => {
    // 後方互換: 文字列で渡された場合はオブジェクトに正規化
    const rootFolder = typeof arg === 'string' ? arg : arg?.rootFolder;
    const saveBeforeSwitch = typeof arg === 'object' ? (arg.saveBeforeSwitch ?? true) : true;

    if (!rootFolder) return { success: false, error: 'rootFolder が指定されていません' };

    try {
      // 切り替え前に現在のワークスペースを保存する
      if (saveBeforeSwitch && currentWorkspace) {
        log.info('ワークスペース切り替え前に保存します:', currentWorkspace.rootFolder);
        const openFiles = await collectWindowStates(windows, currentWorkspace.rootFolder);
        currentWorkspace.openFiles = openFiles;
        await saveWorkspace(currentWorkspace);
      }

      const workspace = await loadWorkspace(rootFolder);
      currentWorkspace = workspace;
      addToHistory(rootFolder, path.basename(rootFolder), 'workspace');
      await restoreWorkspace(workspace, openFileFromPath, windows, createWindow);
      log.info('workspace:open-from-path 完了:', rootFolder);
      return { success: true };
    } catch (e) {
      log.error('workspace:open-from-path 失敗:', e);
      return { success: false, error: e.message };
    }
  });

  // --------------------------------------------------
  // workspace:get-current
  // 現在のワークスペース情報をレンダラーに返す（サイドパネル用）
  // --------------------------------------------------
  ipcMain.handle('workspace:get-current', () => {
    return currentWorkspace ?? null;
  });

  // --------------------------------------------------
  // workspace:get-restore-state
  // openFileFromPath → load-file 完了後にレンダラーが呼ぶ
  // スクロール・カーソル復元情報を返して、キューから削除する
  // --------------------------------------------------
  ipcMain.handle('workspace:get-restore-state', (_e, fullPath) => {
    const state = pendingRestoreStates.get(fullPath) ?? null;
    if (state) pendingRestoreStates.delete(fullPath);
    return state;
  });

  // --------------------------------------------------
  // workspace:list-files  (Phase 5)
  // 指定フォルダのフォルダ・ファイル一覧を返す
  // --------------------------------------------------
  ipcMain.handle('workspace:list-files', async (_e, { folderPath, sortBy = 'name' }) => {
    try {
      return await listProjectFiles(folderPath, sortBy);
    } catch (e) {
      log.error('workspace:list-files error:', e);
      return { folders: [], files: [] };
    }
  });

  // --------------------------------------------------
  // workspace:create-file  (Phase 5)
  // --------------------------------------------------
  ipcMain.handle('workspace:create-file', async (_e, { folderPath, fileName }) => {
    try {
      const filePath = path.join(folderPath, fileName.endsWith('.md') ? fileName : fileName + '.md');
      if (fs.existsSync(filePath)) {
        return { success: false, error: '同名のファイルが既に存在します' };
      }
      fs.writeFileSync(filePath, '', 'utf-8');
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --------------------------------------------------
  // workspace:rename-file  (Phase 5)
  // --------------------------------------------------
  ipcMain.handle('workspace:rename-file', async (_e, { oldPath, newName }) => {
    try {
      const dir = path.dirname(oldPath);
      const ext = path.extname(oldPath);
      const newFileName = newName.endsWith(ext) ? newName : newName + ext;
      const newPath = path.join(dir, newFileName);
      if (fs.existsSync(newPath)) {
        return { success: false, error: '同名のファイルが既に存在します' };
      }
      fs.renameSync(oldPath, newPath);
      return { success: true, newPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --------------------------------------------------
  // workspace:delete-file  (Phase 5)
  // --------------------------------------------------
  ipcMain.handle('workspace:delete-file', async (_e, { filePath }) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['削除', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: `${path.basename(filePath)} を削除しますか？`,
        detail: 'この操作は取り消せません。',
      });
      if (response !== 0) return { success: false, canceled: true };
      fs.unlinkSync(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });


  // --------------------------------------------------
  // エディタ状態の返信（collectWindowStates から使われる）
  // レンダラー側で 'get-editor-state' を受けて返信する
  // このハンドラは workspace.js 側では不要（レンダラー側の実装）
  // ここに書くのは設計メモとして残すのみ
  // --------------------------------------------------

  // registerWorkspaceHandlers の最後の return として追加
  return {
    openWorkspace: async ({ saveBeforeSwitch = true } = {}) => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        message: 'プロジェクトフォルダを選択してください',
      });
      if (canceled || filePaths.length === 0) return { canceled: true };

      // 切り替え前に現在のワークスペースを保存する
      if (saveBeforeSwitch && currentWorkspace) {
        log.info('ワークスペース切り替え前に保存します:', currentWorkspace.rootFolder);
        const openFiles = await collectWindowStates(windows, currentWorkspace.rootFolder);
        currentWorkspace.openFiles = openFiles;
        await saveWorkspace(currentWorkspace);
      }

      const workspace = await loadWorkspace(filePaths[0]);
      currentWorkspace = workspace;
      addToHistory(filePaths[0], path.basename(filePaths[0]), 'workspace');

      // 既存ウィンドウを破棄し、openFiles があれば復元、なければ空ウィンドウを1枚作る
      // （新規フォルダの場合も既存ウィンドウは必ず破棄する）
      await restoreWorkspace(workspace, openFileFromPath, windows, createWindow);

      log.info('ワークスペースを開きました:', workspace.rootFolder);
      return { canceled: false, workspace };
    },
    saveCurrentWorkspace: async () => {
      if (!currentWorkspace) return { success: false };
      const openFiles = await collectWindowStates(windows, currentWorkspace.rootFolder);
      currentWorkspace.openFiles = openFiles;
      await saveWorkspace(currentWorkspace);
      return { success: true };
    },
    getCurrentWorkspace: () => currentWorkspace,  // ← 追加
  };
}

// ========================================
// エクスポート
// ========================================

module.exports = {
  registerWorkspaceHandlers,
  loadWorkspace,
  saveWorkspace,
  listProjectFiles,
  pendingRestoreStates,
};
