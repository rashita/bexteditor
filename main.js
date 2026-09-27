const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const fs = require('fs');
const pfs = require('fs').promises;
const os = require('os');
const path = require('path');
const log = require('electron-log')
const { exec, spawn } = require('child_process');
const { program } = require ("commander")
const { addToHistory, loadHistory, removeFromHistory } = require('./history.js');
const { registerWorkspaceHandlers } = require('./workspace');
const chokidar = require('chokidar');
console.log = (...args) => log.info(...args)
console.error = (...args) => log.error(...args)
console.warn = (...args) => log.warn(...args)

//const envPath = path.join(app.getPath('userData'), '.env');

const isDev = !app.isPackaged;
const envPath = path.join(isDev ? __dirname : app.getPath('userData'), '.env');

program
  .option("--allow-file-access-from-files")
  .option("--enable-avfoundation");

  // --- ここでプロトコル登録 ---
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('bexteditor', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('bexteditor')
}

function parseArguments(args) {
  program.parse(args, {from: "user"})
  const binary = args[0];
  return path.basename(binary) === "Electron" ? program.args.slice(2) : program.args.slice(1)
}

// アプリ開始ログ
log.info('App is starting...')

//テンプレート処理
const tempBaseDir = isDev ? __dirname : app.getPath('userData');
const templateJsonPath = path.join(tempBaseDir, 'template.json');

const templateMenuItem = {
  label: 'Set Template…',
  click: async () => {
    // ファイル選択ダイアログを表示
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Markdown Files', extensions: ['md', 'markdown'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return; // キャンセルされたら何もしない
    }

    const selectedPath = result.filePaths[0];
    await registerTemplate(selectedPath);
  }
};

const isAppUrl = value => /^bext(?:-)?editor:\/\//i.test(value);
const pendingUrls = process.argv.filter(isAppUrl);
let urlHandlingReady = false;

function focusEditor() {
  const win = [...windows].find(win => win.isFocused()) || [...windows][0] || createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function handleAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['bexteditor:', 'bext-editor:'].includes(parsed.protocol)) return;
    const action = parsed.hostname;
    const filePath = parsed.searchParams.get('path');
    if (action === 'launch') {
      focusEditor();
    } else if (action === 'new') {
      const content = parsed.searchParams.get('content') || '';
      if (parsed.searchParams.has('path')) {
        if (!filePath || !path.isAbsolute(filePath)) {
          throw new Error('path にはファイルの絶対パスを指定してください。');
        }
        fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
        openFileFromPath(filePath);
      } else {
        createWindow(null, content);
      }
    } else if (action === 'open') {
      if (!filePath || !path.isAbsolute(filePath)) {
        throw new Error('path にはファイルの絶対パスを指定してください。');
      }
      openFileFromPath(filePath);
    } else {
      throw new Error(`未対応のURL操作です: ${action}`);
    }
  } catch (error) {
    console.error('URLの処理に失敗しました', error);
    dialog.showErrorBox('URLの処理に失敗しました', error.message);
  }
}

function receiveAppUrl(url) {
  if (urlHandlingReady) handleAppUrl(url);
  else pendingUrls.push(url);
}

let fileToOpen = null

if (!process.defaultApp && process.argv.length >= 2) {
  fileToOpen = isAppUrl(process.argv[1]) ? null : process.argv[1];
}


const windows = new Set();
let showLineNumbers = false;
ipcMain.handle('get-show-line-numbers', () => showLineNumbers);
const watcherMap = new Map(); // filePath → fs.FSWatcher
//複数のウィンドウで同じファイルを開いたときに、このやり方はうまくいかない気がする
//ウィンドウごとにwatcherを登録した方がよい

let openWorkspace = null;
let saveCurrentWorkspace = null;
let getCurrentWorkspace = null; // ← ワークスペースのフォルダ参照用


function createWindow(parent = null,initialText="") {
  const [parentX, parentY] = parent
  ? [parent.getBounds().x + parent.getBounds().width, parent.getBounds().y] // 親の横にぴたりとつける
  : [null, null]; // fallback
  const toggleWidth = 800 //子ウィンドウなら半分に
  const win = new BrowserWindow({
    width: toggleWidth,
    height: 600,
    //parent:parent, //いったんペアレントは消す
    x: parentX ,  // 親の右下に少しずらす
    y: parentY ,
    currentFont : 'sans-serif',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    if (initialText) {
      win.webContents.send('init-text', initialText);
    }
  });


  win.on('close', (event) => {
    event.preventDefault(); // ウィンドウが閉じるのを一旦キャンセル

    // レンダラープロセスに問い合わせて、ファイルのダーティ状態を確認
    win.webContents.send('before-close', { id: win.id });

    ipcMain.once(`is-dirty-${win.id}`, (e, isDirty) => {
      if (isDirty) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'question',
          buttons: ['Save', 'Don\'t Save', 'Cancel'],
          title: 'Confirm',
          message: 'You have unsaved changes. Do you want to save them?'
        });

        if (choice === 0) { // Save
          win.webContents.send('trigger-save-file', { id: win.id });
          ipcMain.once(`file-saved-${win.id}`, () => {
            win.destroy();
          });
        } else if (choice === 1) { // Don\'t Save
          win.destroy();
        }
        // choice === 2 (Cancel) の場合は何もしない
      } else {
        win.destroy();
      }
    });
  });

  win.on('closed', () => {
    //ウォッチャーを削除したい
    if (win.currentWatcher) {
      win.currentWatcher.close();
      win.currentWatcher = null;
    }

    windows.delete(win);
  });

  windows.add(win);
  return win;
}

// ファイルを新しいウィンドウで開く関数
async function openFileInNewWindow() {
  console.log("ダイアログからファイルを開きます")
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Text Files', extensions: ['txt', 'md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!canceled && filePaths.length > 0) {
    const filePath = filePaths[0];
    app.addRecentDocument(filePath);
    const newWindow = createWindow();
    newWindow.webContents.once('did-finish-load', () => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        newWindow.webContents.send('load-file', { filePath, content });
        //開いているファイルをmain.jsでも扱えるように
        newWindow.currentFilePath = filePath;
        const firstLine = content.split('\n')[0].trim();
        const title = firstLine || path.basename(filePath); 
        addToHistory(filePath, title);
      } catch (e) {
        console.error('Failed to read file', e);
        // ここでユーザーにエラーを通知することもできます
      }
    });
  }
}


/**
 * 指定フォルダから親フォルダに遡って rules.json を探す
 * @param {string} startDir - 探索を開始するフォルダ
 * @returns {Promise<string|null>} - 見つかったrules.jsonのパス or null
 */
async function findRulesFile(startDir) {
  let currentDir = startDir;

  while (true) {
    const rulesPath = path.join(currentDir, 'rules.json');
    try {
      await pfs.access(rulesPath);
      return rulesPath; // 見つかったら即返す（優先）
    } catch {
      // 見つからなかった場合は親フォルダへ
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // ルートまで到達
      break;
    }
    currentDir = parentDir;
  }

  return null; // 見つからなかった
}

// ファイルを保存する処理
async function handleFileSave(event, { filePath, content }) {
  console.log("ファイルを保存します")

  const webContents = event.sender
  const win = BrowserWindow.fromWebContents(webContents)



  if (filePath) {
    fs.writeFileSync(filePath, content);
    app.addRecentDocument(filePath);
    return filePath;
  } else {
    const firstLine = content.split('\n')[0].trim();
    let defaultName = '';
    if (firstLine) {
      // ファイル名に使えない文字を削除
      defaultName = firstLine.replace(/[/\\?%*:|"<>]/g, '') + '.md';
    }

    const ws = getCurrentWorkspace?.();
    const defaultDir = ws?.rootFolder ?? app.getPath('documents');

    const { canceled, filePath: newFilePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(defaultDir, defaultName),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text Document', extensions: ['txt'] },
      ]
    });

    if (canceled) {
      return;
    } else {
      const contentToSave = content.replace(/\u200B/g, '');
      fs.writeFileSync(newFilePath, contentToSave);
      return newFilePath;
    }
  }
}


// --- Step 3: レンダラープロセスからの通知を受け取り、タイトルを更新 ---
ipcMain.on('update-title', (event, { filePath, isDirty }) => {
  // 通知元のウィンドウを取得
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    let title = "BextEditor"; // デフォルトタイトル
    if (filePath) {
      title = path.basename(filePath);
    }
    if (isDirty) {
      title = `*${title}`;
    }
    win.setTitle(title);
  }
});

//内部リンクの呼び出し（同期処理）
ipcMain.on("open-link", async (event, linkText, currentFilePath) => {
  if (!currentFilePath) return false;
  //処理を変えたい
  //フルパスでファイル名がやってくるようにすればいいのではないか

  const dirName = path.dirname(currentFilePath);   // 例: Dropbox/logtext
  const NewFileName = linkText + ".md"
  const newPath = path.isAbsolute(linkText)? linkText :path.resolve(dirName, linkText + ".md");
  //const newPath = path.join(dirName , NewFileName)
  console.log(newPath + "を内部リンクとして処理します");
  if (fs.existsSync(newPath)) {
    // ファイルを開く
    console.log(newPath + "は存在しています");
    try {
      await linkOpenAndLoadFile(event, newPath); // Promise 対応済み
      event.sender.send("open-link-done");       // 読み込み完了を通知
      } catch (err) {
       console.error(err);
      // 必要ならエラー通知
      // event.sender.send("open-link-error", err);
      }
    return true;
  } 
  console.log(newPath + "は存在しないので子フォルダを探します");

  const entries = fs.readdirSync(dirName, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childIndex = path.join(dirName, entry.name, NewFileName);
      if (fs.existsSync(childIndex)) {
        try {
          await linkOpenAndLoadFile(event, childIndex); // Promise 対応済み
          event.sender.send("open-link-done");       // 読み込み完了を通知
          } catch (err) {
          console.error(err);
          // 必要ならエラー通知
          // event.sender.send("open-link-error", err);
          }
        return true;
      }
    }
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["作成", "キャンセル"],
    defaultId: 0,
    cancelId: 1,
    message: `${path.basename(newPath)} は存在しません。作成しますか？`
  });
    if (response === 0) {
      console.log("ファイルの作成を行う直前です")
      fs.writeFileSync(newPath, ""); // 空ファイル作成
      openFileFromPath(newPath)
      //event.sender.send("open-file", newPath);
      return false;
    }

});

app.setName('bextEditor');

//引き数を使った起動への対応
let openFileQueue = []

function openFileFromPath(filePath,parent=null) {
  console.log("ファイルから" + filePath + "ウィンドウを作成します")
  const newWindow = createWindow(parent);
  newWindow.webContents.once('did-finish-load', () => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      newWindow.webContents.send('load-file', { filePath, content });
      app.addRecentDocument(filePath);

      //開いているファイルをmain.jsでも扱えるように
      newWindow.currentFilePath = filePath;
      const firstLine = content.split('\n')[0].trim();
      const title = firstLine || path.basename(filePath); 
      addToHistory(filePath, title);

      //file wachterの追加
      if(!newWindow.currentWacher){
        console.log("ウォッチャーを登録します")
        newWindow.currentWacher = chokidar.watch(filePath, {
          usePolling: false,
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
          }
        });
        newWindow.currentWacher.on('change', () => {
          if (newWindow.isDestroyed()) return; // 念のため安全策
          const newContent = fs.readFileSync(filePath, 'utf-8');
          newWindow.webContents.send('file-updated', {filePath,newContent});
        });
      }


    } catch (e) {
      console.error('Failed to read file', e);
    }
  });
  return newWindow;
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  console.log('open-file received:', filePath)
  if (windows.size === 0) {
    //ウィンドウがないときの処理
    console.log('ウィンドウがありません')
  }
  //open コマンド起動時はこれが即座に開く
  if (app.isReady()) {
    console.log("アプリは起動しています")
    openFileFromPath(filePath)
    } else {
    console.log("アプリは起動していません")
    openFileQueue.push(filePath)
  }
  
});


app.on('will-finish-launching', () => {
  console.log('will-finish-launching');
});

app.on('ready', () => {
  console.log('ready event');
});


//フォーカスしているウィンドウのフォントを返す
function getFocusedWindowFont() {
  const focused = BrowserWindow.getFocusedWindow();
  return focused?.currentFont || null;
}

function buildMenu() {
  const focusedFont = getFocusedWindowFont();

  const windowMenuItems = BrowserWindow.getAllWindows().map((win, index) => {
    const title = win.getTitle() || `ウィンドウ ${index + 1}`;
    return {
      label: title,
      type: "normal",
      click: () => {
        if (win.isMinimized()) win.restore();
        win.focus();
      },
    };
  });


  const menuTemplate = [
    // {appMenu}
    ...(process.platform === 'darwin' ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: async (menuItem, browserWindow) => {
            if (!browserWindow) {
              createWindow();
              return;
            }
            browserWindow.webContents.send('request-selected-text');

          }
        },
        {
          label: 'Open File',
          accelerator: 'CmdOrCtrl+O',
          click: openFileInNewWindow
        },
        {
          label: 'Quick Open',
          accelerator: 'CmdOrCtrl+P',
          click: (menuItem, browserWindow) => {
            if (browserWindow) browserWindow.webContents.send('show-quick-open');
          }
        },
        {
          label: 'Open Recent',
          role: 'recentDocuments',
          submenu: [
            {
              label: 'Clear Recent',
              role: 'clearRecentDocuments'
            }
          ]
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: (menuItem, browserWindow) => {
            if (browserWindow) {
              browserWindow.webContents.send('trigger-save-file', { id: browserWindow.id });
            }
          }
        },
        { type: 'separator' },
          {
            label: 'Open Workspace…',
            accelerator: 'CmdOrCtrl+Shift+O',
            click: async () => {
              await openWorkspace();
            }
          },
        {
          label: 'Save Workspace',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            if (saveCurrentWorkspace) await saveCurrentWorkspace();
          }
        },
        { type: 'separator' },
        templateMenuItem,
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: '行番号を表示',
          type: 'checkbox',
          checked: showLineNumbers,
          click: (menuItem) => {
            showLineNumbers = menuItem.checked;
            for (const win of windows) {
              win.webContents.send('show-line-numbers-changed', showLineNumbers);
            }
          }
        },
        { label:"Mode",
          submenu:[
            {label:'Jounal',
              type: 'radio',
              checked:  (focusedFont ?? 'sans-serif') === 'sans-serif',
              click:(menuItem, browserWindow)=> {
                if(!browserWindow)return
                browserWindow.currentFont = 'sans-serif';
                browserWindow.webContents.send('change-font', {
                size: '18px',
                family: '"Roboto",Helvetica,Arial,"Hiragino Sans",sans-serif'
                });
              }
            },
            {label:"Writing",
              type: 'radio',
              checked: focusedFont === 'serif',
              click:(menuItem, browserWindow)=> {
                if(!browserWindow)return
                browserWindow.currentFont = 'serif';
                browserWindow.webContents.send('change-font', {
                  size: '22px',
                  family: '"Noto Serif JP", "Hiragino Mincho ProN", "Hiragino Mincho", serif',
                  padding:"30px"
                });
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label:'Insert',
      submenu:[
        {label:'FrontMatter',
          click:()=>{
            console.log("click FrontMatter menu")
          }
        }
      ]
    },
    {
      label:'Tool',
      submenu: [
        {
          label: 'ターミナルを開く',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            const termApp = loadTerminalApp();
            const ws = getCurrentWorkspace?.();
            const dirPath = ws?.rootFolder ?? null;
            openTerminal(dirPath, termApp);
          }
        },
        {
          label: 'コマンドパレット',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: (menuItem, browserWindow) => {
            if (browserWindow) browserWindow.webContents.send('show-command-palette');
          }
        },
      ]
    },{
      role: "windowMenu", // macOS 標準の「ウィンドウ」メニューに統合される
      submenu: [
        ...windowMenuItems,
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
      ],
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}




app.whenReady().then(() => {
  console.log("when ready start");

  ipcMain.handle('dialog:saveFile', handleFileSave);

  ipcMain.handle('open-specific-file', async (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, filePath, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });



  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const iconimage = nativeImage.createFromPath(iconPath)
    app.dock.setIcon(iconimage);
  }


  app.on('activate', () => {
    if (windows.size === 0) {
      createWindow();
    }
  });



  // ワークスペースのIPCハンドラを登録
({ openWorkspace, saveCurrentWorkspace , getCurrentWorkspace } = registerWorkspaceHandlers({ 
  windows, openFileFromPath, createWindow 
}));

  buildMenu()
  urlHandlingReady = true;
  if (fileToOpen) openFileFromPath(fileToOpen);
  openFileQueue.splice(0).forEach(file => openFileFromPath(file));
  const startupUrls = pendingUrls.splice(0);
  startupUrls.forEach(handleAppUrl);
  if (windows.size === 0) createWindow();

});

app.on('second-instance', (_event, argv) => {
  argv.filter(isAppUrl).forEach(receiveAppUrl);
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('bext-editor', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('bext-editor')
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveAppUrl(url);
});

app.on('window-all-closed', () => {
  // macOSではワークスペース切り替え中も含め、窓がなくても終了しない。
  // 明示的な「終了」や Cmd+Q では通常どおり終了する。
  if (process.platform !== 'darwin') app.quit();
});


function shiftpagination(filePath, direction = 1){
  const fileName = path.basename(filePath); 
  const dirName = path.dirname(filePath);  
  const match = fileName.match(/^([a-zA-Z_\-]+)(\d{2,3})\.md$/);
  if (!match) return null;

  const prefix = match[1];          // "chapter"
  const numberStr = match[2];       // "05" or "001"
  const number = parseInt(numberStr, 10);
  const newNumber = number + direction;

  if (newNumber < 0) return null;   // マイナスは禁止など任意で制限

  // ゼロ埋めの桁数を保つ
  const padded = String(newNumber).padStart(numberStr.length, '0');

  const newFileName = `${prefix}${padded}.md`;
  return path.join(dirName, newFileName);

}
//ファイルの日付を動かす
function shiftDateInFilename(filePath, offsetDays) {
  const fileName = path.basename(filePath); // 例: 20250725.md
  const dirName = path.dirname(filePath);   // 例: Dropbox/logtext
  const match = fileName.match(/(\d{4})(\d{2})(\d{2})\.md$/);

  if (!match) return null;

  const [_, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}`);
  date.setDate(date.getDate() + offsetDays);

  const newDateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const newFileName = `${newDateStr}.md`;
  return path.join(dirName, newFileName); 
}

//連番ファイルに強制的に新しいファイルを割り込ませる
ipcMain.on("insert-file", async (event, currentPath,offsetDays) => {
    console.log(currentPath,offsetDays)
    const insertPagePath = shiftpagination(currentPath,offsetDays)
    if (!insertPagePath) return
    console.log(insertPagePath + "の移動を開始します")
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["作成", "キャンセル"],
      defaultId: 0,
      cancelId: 1,
      message: `${path.basename(newPath)} ファイルを挿入しますか？？`
    });
    if (response === 0) {
      try {
        insertNumberedFileByFullPath(insertPagePath)
        //openFileFromPath(newPath);
      } catch (err) {
        console.error("ファイル作成またはオープンに失敗:", err);
      }

    }
    

})

ipcMain.on("shift-file", async (event, currentPath,offsetDays) => {

  const newPath = (() => {
    const shifted = shiftDateInFilename(currentPath, offsetDays);
    if (shifted) return shifted;

    const numbered = shiftpagination(currentPath, offsetDays);
    if (numbered) return numbered;

    return null;
  })();

  if (!newPath) {
    console.log("ファイル名に数字が含まれていません。");
    return;
  }

  if (fs.existsSync(newPath)) {
    // 既存ファイルを開く
    console.log(newPath + "は存在しています");
    linkOpenAndLoadFile(event,newPath)

  } else {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["作成", "キャンセル"],
      defaultId: 0,
      cancelId: 1,
      message: `${path.basename(newPath)} は存在しません。作成しますか？`
    });

    if (response === 0) {
      try {
        fs.writeFileSync(newPath, ""); // 空ファイル作成
        openFileFromPath(newPath);
      } catch (err) {
        console.error("ファイル作成またはオープンに失敗:", err);
      }

    }
  }
});

//ファイル上下移動のためのイベントリスナ
ipcMain.on("level-file", async (event, currentPath,isUp) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  if(isUp){
    const newPath = levelDateInFilename(currentPath);
    if (newPath) {
      linkOpenAndLoadFile(event,newPath)
      return true;
    }
  }else{
    const newPath = getSnakememo(currentPath)
    if (fs.existsSync(newPath)) {
      for (const win of windows) {
       if (win.currentFilePath === newPath) {
        console.log("すでにそのファイルは開かれています")
        win.close()
        return false;
        }
      }
      openFileFromPath(newPath,parentWindow)//開いていなければ新しく開く
      return true;
    }else{//ファイルが存在していない
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["作成", "キャンセル"],
        defaultId: 0,
        cancelId: 1,
        message: `${newPath} は存在しません。作成しますか？`
      });
      if (response === 0) {
        console.log("作成を受諾しました")
        fs.writeFileSync(newPath, ""); // 空ファイル作成
        openFileFromPath(newPath,parentWindow)
      }


    }

  }

  
  return

});

//_がついたファイル名を取得
function getSnakememo(filePath){
  const fileName = path.basename(filePath); // 例: 20250725.md
  const dirName = path.dirname(filePath);   // 例: Dropbox/logtext
  const parentDir = path.dirname(dirName);  // 例: Dropbox/
  const snakeFilePath = path.join(dirName,"_"+fileName)// 例: -20250725.md
  return snakeFilePath
}

//上のファイルに移動
function levelDateInFilename(filePath) {
  const fileName = path.basename(filePath); // 例: 20250725.md
  const dirName = path.dirname(filePath);   // 例: Dropbox/logtext
  const parentDir = path.dirname(dirName);  // 例: Dropbox/
  const matchData = fileName.match(/(\d{4})(\d{2})(\d{2})\.md$/);
  if (matchData) {//日付ノートの場合は、月ノートに移動 ただし現状はフォルダ構造にあっていない
    const [_, year, month, day] = matchData;
    const newFileName = `${year}${month}.md`;
    const monthIndex = path.join(dirName, newFileName)
    console.log(monthIndex)
    if (fs.existsSync(monthIndex)) {
      return monthIndex;
    }else{
      console.log("月ノートはありません")
    }
  }

  //同じフォルダでindex.mdを探す
  const indexInCurrent = path.join(dirName, "index.md");
   if (fs.existsSync(indexInCurrent)) {
    return indexInCurrent;
  }

  //親フォルダでindex.mdを探す
  const indexInParent = path.join(parentDir, "index.md");
  if (fs.existsSync(indexInParent)) {
    return indexInParent;
  }

  return null;

}

//イベントを発生させたウィンドウの中身をファイル内容で上書きする
function linkOpenAndLoadFile(event, filePath) {
  return pfs.readFile(filePath, "utf-8")
    .then((content) => {
      // ファイル内容をレンダラに送信
      event.sender.send("load-file", { filePath, content });

      const startWindow = BrowserWindow.fromWebContents(event.sender);
      startWindow.currentFilePath = filePath;
      console.log(startWindow.currentFilePath);

      // 古いウォッチャーを解除
      if (startWindow.currentWatcher) {
        console.log("古いウォッチャーを解除します");
        startWindow.currentWatcher.close();
      }

      console.log("ウォッチャーを再設定します");
      startWindow.currentWatcher = chokidar.watch(filePath, {
        usePolling: false,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      startWindow.currentWatcher.on("change", async () => {
        try {
          const newContent = await fs.readFile(filePath, "utf-8");
          startWindow.webContents.send("file-updated", { filePath, newContent });
        } catch (err) {
          console.error("ファイル更新の読み込み失敗:", err);
        }
      });
    })
    .catch((err) => {
      dialog.showErrorBox("読み込みエラー", `ファイルを開けませんでした: ${filePath}`);
      return Promise.reject(err);
    });
}


// 📦 モーダル用ファイル読み取り処理
ipcMain.handle("read-markdown-file", async (_, fileFullPath) => {

  const history = loadHistory()
  const content  = history
    .map(entry => shortenPath(entry.filePath))  // ファイルパスだけ取り出す
    .join('\n');

  if(!fileFullPath)return content

  // const upFilePath = levelDateInFilename(fileFullPath)

  // if(upFilePath) {
  //   const mapContent = fs.readFileSync(upFilePath, "utf-8");
  //   return (content + "\n\n" + mapContent)
  // }

  return content
});

//最近開いたアイテムのクイックアクセス
ipcMain.handle('quick-open:get-items', () => {
  const history = loadHistory();
  const currentPath = getCurrentWorkspace()?.rootFolder ?? null; // ← 追加
  return history.map(e => ({
    type: e.type ?? 'file',
    path: e.filePath,
    label: e.title || path.basename(e.filePath),
    dir: e.type === 'workspace'
      ? e.filePath
      : path.dirname(e.filePath),
    openedAt: e.openedAt,
    isCurrent: e.type === 'workspace' && e.filePath === currentPath, // ← 追加
  }));
});

ipcMain.handle('quick-open:remove-item', (event, filePath) => {
  try {
    removeFromHistory(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('request-open-file', (event, filePath, currentFilePath="") => {
  // currentFilePath がない場合（null / undefined / 空文字）→ 新規ウィンドウで開く
  if (!currentFilePath) {
    openFileFromPath(expandPath(filePath));
    return;
  }

  // currentFilePath がある場合 → 同一ウィンドウで開く（linkOpenAndLoadFile を使用）
  const dirName = path.dirname(currentFilePath);
  console.log(filePath);

  // フルパスで渡ってきた場合はそのまま使う
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
    console.log(filePath + "をフルパスで同一ウィンドウに読み込みます");
    linkOpenAndLoadFile(event, filePath);
    return;
  }

  const NewFileName = filePath + ".md";
  const newPath = path.join(dirName, NewFileName);
  console.log(newPath + "を内部リンクとして処理します");
  if (fs.existsSync(newPath)) {
    console.log(newPath + "は存在しています");
    linkOpenAndLoadFile(event, newPath);
  } else {
    console.log(newPath + "は存在しないので子フォルダを探します");
    const entries = fs.readdirSync(dirName, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childIndex = path.join(dirName, entry.name, NewFileName);
        if (fs.existsSync(childIndex)) {
          linkOpenAndLoadFile(event, childIndex);
        }
      }
    }
  }
});

//ファイルパスのユーザーホームの部分を~に変換
function shortenPath(filePath) {
  const home = require('os').homedir();
  let shortened = filePath;
  if (filePath.startsWith(home)) {
    shortened = '~' + filePath.slice(home.length);
  }
  return shortened;
}

//ファイルパスの~/の部分をユーザーホームに変換
function expandPath(p) {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// IPCでキーを受け取って.mdファイル読み込み、内容を返す
ipcMain.handle('load-md-file', async (event, key) => {
  try {
    const data = await pfs.readFile(templateJsonPath, 'utf-8');
    templates = JSON.parse(data);

    const matched = templates.find(t => t.name === key);
    if (!matched) {
      return { success: false, error: 'テンプレートが見つかりません' };
    }

    // templatePathのファイル内容を読み込む
    const content = await pfs.readFile(matched.templatePath, 'utf-8');
    return { success: true, content };

  } catch(err) {
    // ファイルがなければ空配列からスタート
    console.error('template.json 読み込み失敗:', err);
    return { success: false, error: err.message }
  }

});

// ファイルパスを受けてテンプレート登録処理を行う関数
async function registerTemplate(selectedPath) {
  const fileName = path.basename(selectedPath);
  const parsed = path.parse(fileName);

  let templates = [];
  try {
    const data = await pfs.readFile(templateJsonPath, 'utf-8');
    templates = JSON.parse(data);
    if (!Array.isArray(templates)){
      console.log('中身がありません');
      templates = [];
    }
  } catch(err) {
    // ファイルがなければ空配列からスタート
    console.error('template.json 読み込み失敗:', err);
    console.log(templateJsonPath);
    console.log('ファイルがありません');
    templates = [];
  }

  // 重複チェック（templatePathで判定）
  const exists = templates.some(t => t.templatePath === selectedPath);
  if (!exists) {
    templates.push({ name: parsed.name, templatePath: selectedPath });
    await pfs.writeFile(templateJsonPath, JSON.stringify(templates, null, 2), 'utf-8');
    console.log('テンプレート登録完了');
  } else {
    console.log('同じファイルパスのテンプレートがすでに存在します');
  }
}

ipcMain.on('selected-text', (event, text) => {
  // 新規ウィンドウを選択テキスト付きで作成
  console.log(text)
  createWindow(null,text);
});


/**
 * フルパス1本から連番ファイルを挿入
 * @param {string} newFilePath 新規作成したいフルパス (例: /path/to/card04.md)
 */
function insertNumberedFileByFullPath(newFilePath) {
  const dirPath = path.dirname(newFilePath);
  const fileName = path.basename(newFilePath); // 例: card04.md

  // 接頭辞と番号を抽出
  const match = fileName.match(/^(\D+)(\d+)\.md$/);
  if (!match) throw new Error("ファイル名が正しい形式ではありません");

  const prefix = match[1];                 // "card"
  const insertIndex = parseInt(match[2], 10); // 4
  const pad = match[2].length;             // "04" の長さ → 2

  // 対象フォルダ内の同プレフィックスのファイルを取得
  const regex = new RegExp(`^${prefix}(\\d+)\\.md$`);
  const files = fs.readdirSync(dirPath)
    .filter(f => regex.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(regex)[1], 10);
      const nb = parseInt(b.match(regex)[1], 10);
      return na - nb;
    });

  // 最大番号
  const maxIndex = files.length > 0
    ? parseInt(files[files.length - 1].match(regex)[1], 10)
    : 0;

  // 後ろから順にリネーム
  for (let i = maxIndex; i >= insertIndex; i--) {
    const oldName = `${prefix}${String(i).padStart(pad, "0")}.md`;
    const newName = `${prefix}${String(i + 1).padStart(pad, "0")}.md`;
    const oldPath = path.join(dirPath, oldName);
    const newPath = path.join(dirPath, newName);
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
    }
  }

  // 新規ファイル作成
  if (!fs.existsSync(newFilePath)) {
    fs.writeFileSync(newFilePath, ""); // 空ファイル作成
  }
}

/**
 * 連番ファイルを削除し、後続番号を前に詰める
 * @param {string} filePath 削除するファイルのフルパス (例: /path/to/card04.md)
 */
function deleteAndShiftNumberedFile(filePath) {
  const dirPath = path.dirname(filePath);
  const fileName = path.basename(filePath);

  // prefix と番号を抽出
  const match = fileName.match(/^(\D+)(\d+)\.md$/);
  if (!match) throw new Error("ファイル名が正しい形式ではありません");

  const prefix = match[1];
  const deleteIndex = parseInt(match[2], 10);
  const pad = match[2].length;

  // 対象フォルダ内の同プレフィックスのファイルを取得
  const regex = new RegExp(`^${prefix}(\\d+)\\.md$`);
  const files = fs.readdirSync(dirPath)
    .filter(f => regex.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(regex)[1], 10);
      const nb = parseInt(b.match(regex)[1], 10);
      return na - nb;
    });

  // まず削除
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // 削除した番号より後ろのファイルを前にずらす
  for (let i = deleteIndex + 1; i <= files.length - 1; i++) {
    const oldName = `${prefix}${String(i).padStart(pad, "0")}.md`;
    const newName = `${prefix}${String(i - 1).padStart(pad, "0")}.md`;
    const oldPath = path.join(dirPath, oldName);
    const newPath = path.join(dirPath, newName);

    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
    }
  }
}


function loadTerminalApp() {
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/TERMINAL_APP=(.+)/);
    return match ? match[1].trim() : 'Terminal';
  } catch {
    return 'Terminal';
  }
}

function saveTerminalApp(appName) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch { }

  if (content.includes('TERMINAL_APP=')) {
    content = content.replace(/TERMINAL_APP=.+/, `TERMINAL_APP=${appName}`);
  } else {
    content += `\nTERMINAL_APP=${appName}`;
  }

  fs.writeFileSync(envPath, content.trim(), 'utf-8');
}


// ── ターミナル起動 ──────────────────────────────────────────

/**
 * ターミナルを開く
 * @param {string|null} dirPath - 開くフォルダパス。null なら指定なし
 * @param {string} app - ターミナルアプリ名（設定から渡す）
 */
function openTerminal(dirPath, app = 'Terminal') {
  if (app === 'iTerm2') {
    openIterm2(dirPath);
  } else {
    // Terminal.app / Warp / Ghostty など open -a で動くもの
    const target = dirPath ? `"${dirPath}"` : '';
    exec(`open -a "${app}" ${target}`, (err) => {
      if (err) console.error('[openTerminal] error:', err.message);
    });
    // Ghosttyで新しいウィンドウとして開く場合は以下
    //exec(`/Applications/Ghostty.app/Contents/MacOS/ghostty +new-window --working-directory="${dirPath}"`);
  }
}

function openIterm2(dirPath) {
  let script;
  if (dirPath) {
    // シングルクォート内でのエスケープ対策
    const escaped = dirPath.replace(/'/g, "'\\''");
    script = `
      tell application "iTerm2"
        create window with default profile
        tell current session of current window
          write text "cd '${escaped}'"
        end tell
      end tell
    `;
  } else {
    script = `
      tell application "iTerm2"
        create window with default profile
      end tell
    `;
  }
  exec(`osascript -e '${script}'`, (err) => {
    if (err) console.error('[openIterm2] error:', err.message);
  });
}

// IPC ハンドラ登録
ipcMain.handle('open-terminal', (event, { dirPath = null } = {}) => {
  const termApp = loadTerminalApp();
  openTerminal(dirPath, termApp);
});

ipcMain.handle('terminal-get-app', () => {
  return loadTerminalApp();
});

ipcMain.handle('terminal-save-app', (event, appName) => {
  try {
    saveTerminalApp(appName);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── コマンドパレット ────────────────────────────────────────────
// Phase 1: commands.json の読み込みとマージ

/**
 * グローバルおよびローカルの commands.json を読み込み、name をキーにマージして返す
 * @param {string|null} workspaceRoot
 * @returns {Promise<Array>}
 */
async function loadCommands(workspaceRoot) {
  const globalPath = path.join(isDev ? __dirname : app.getPath('userData'), 'commands.json');
  const localPath  = workspaceRoot
    ? path.join(workspaceRoot, '.bext', 'commands.json')
    : null;

  async function readCommandsFile(filePath) {
    try {
      const raw = await pfs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch {
      return [];
    }
  }

  const globalCmds = (await readCommandsFile(globalPath)).map(cmd => ({ ...cmd, source: 'global' }));
  const localCmds  = localPath
    ? (await readCommandsFile(localPath)).map(cmd => ({ ...cmd, source: 'local' }))
    : [];

  // name をキーにマージ。ローカルが同名グローバルを上書き
  const merged = new Map();
  for (const cmd of globalCmds) merged.set(cmd.name, cmd);
  for (const cmd of localCmds)  merged.set(cmd.name, cmd);

  return Array.from(merged.values());
}

/** IPC: get-commands */
ipcMain.handle('get-commands', async (event, workspaceRoot) => {
  return await loadCommands(workspaceRoot ?? null);
});

// Phase 2: コマンド実行エンジン

/**
 * 文字列内のプレースホルダを展開する
 */
function expandPlaceholders(str, context) {
  return str
    .replace(/\{file\}/g,      context.file      ?? '')
    .replace(/\{dir\}/g,       context.dir       ?? '')
    .replace(/\{basename\}/g,  context.basename  ?? '')
    .replace(/\{workspace\}/g, context.workspace ?? '');
}

/**
 * コマンドを spawn で実行し結果を返す
 */
function runCommand(commandDef, context) {
  const cmd  = expandPlaceholders(commandDef.command, context);
  const args = (commandDef.args ?? []).map(a => expandPlaceholders(a, context));
  const cwd  = expandPlaceholders(commandDef.cwd ?? '{dir}', context) || context.dir || undefined;

  return new Promise((resolve) => {
    const stderrChunks = [];
    const stdoutChunks = []; 
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, shell: false });
    } catch (e) {
      return resolve({ success: false, exitCode: -1, stderr: e.message });
    }

    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

    proc.on('error', (err) => {
      resolve({ success: false, exitCode: -1, stderr: err.message });
    });

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));

    proc.on('close', (code) => {
      const exitCode = code ?? -1;
      // stderr の先頭5チャンク分のみ返す
      //const stderr = stderrChunks.slice(0, 5).join('');
      resolve({ 
        success: exitCode === 0,
        exitCode,
        stdout: stdoutChunks.join(''),       // ← 追加
        stderr: stderrChunks.slice(0, 5).join(''),
      });
    });
  });
}

/** IPC: run-command */
ipcMain.handle('run-command', async (event, { commandDef, context }) => {
  try {
    return await runCommand(commandDef, context);
  } catch (e) {
    return { success: false, exitCode: -1, stderr: e.message };
  }
});
// ── コマンドパレット ここまで ───────────────────────────────────
