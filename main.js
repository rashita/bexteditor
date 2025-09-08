const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const fs = require('fs');
const pfs = require('fs').promises;
const os = require('os');
const path = require('path');
const log = require('electron-log')
const { program } = require ("commander")
const { addToHistory,loadHistory } = require('./history.js');
const chokidar = require('chokidar');
console.log = (...args) => log.info(...args)
console.error = (...args) => log.error(...args)
console.warn = (...args) => log.warn(...args)

program
  .option("--allow-file-access-from-files")
  .option("--enable-avfoundation");


function parseArguments(args) {
  program.parse(args, {from: "user"})
  const binary = args[0];
  return path.basename(binary) === "Electron" ? program.args.slice(2) : program.args.slice(1)
}

// アプリ開始ログ
log.info('App is starting...')

//テンプレート処理
const isDev = !app.isPackaged;
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

let fileToOpen = null

if (!process.defaultApp && process.argv.length >= 2) {
  fileToOpen = process.argv[1];
}


const windows = new Set();
const watcherMap = new Map(); // filePath → fs.FSWatcher
//複数のウィンドウで同じファイルを開いたときに、このやり方はうまくいかない気がする
//ウィンドウごとにwatcherを登録した方がよい


function createWindow(parent = null,initialText="") {
  const [parentX, parentY] = parent
  ? [parent.getBounds().x + parent.getBounds().width, parent.getBounds().y] // 親の横にぴたりとつける
  : [null, null]; // fallback
  const toggleWidth = parent ? 400:800 //子ウィンドウなら半分に
  const win = new BrowserWindow({
    width: toggleWidth,
    height: 600,
    parent:parent,
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
    return //すぐに閉じる
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

    const { canceled, filePath: newFilePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
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
                  size: '18px',
                  family: '"Noto Serif JP", "Hiragino Mincho ProN", "Hiragino Mincho", serif'
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
        { label:'Timer',
          type: 'checkbox',
          accelerator: 'Cmd+Alt+T',
          checked: false, // 初期状態
          click: (menuItem, browserWindow) => {
            if (browserWindow) {
              browserWindow.webContents.send('toggle-timer');
            }
          }
        }
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
  buildMenu()

  ipcMain.handle('dialog:saveFile', handleFileSave);

  ipcMain.handle('open-specific-file', async (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, filePath, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  if (fileToOpen){
    console.log("コマンドライン引き数があるよ")
    openFileFromPath(fileToOpen)
    return
  }



  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const iconimage = nativeImage.createFromPath(iconPath)
    app.dock.setIcon(iconimage);
  }


  app.on('activate', (event, hasVisibleWindows) => {
    console.log("active" + event)
    if (windows.size === 0) {
      console.log("on active");
    }
  });

  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log("second-instance:初期")
    console.log("commandLine" + commandLine)
    openFileQueue.push(commandLine)
  })

   createWindow()

   console.log(openFileQueue)


});

app.on("second-instance", (_e,argv) => {
    // レンダラープロセスへファイルパスを送信
    console.log("second-instance" +argv)
    console.log("出力確認")
    console.log(parseArguments(argv))
    //files.forEach(openFileFromPath);
    //openFileFromPath(parseArguments(argv))
    //focusExistingWindow();
  });

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('bext-editor', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('bext-editor')
}

app.on('open-url', (event, url) => {
  dialog.showErrorBox('Welcome Back', `You arrived from: ${url}`)
  //You arrived from: bext-editor://
  //ファイルのパスをすべて入れるのは無理がある
})

app.on('window-all-closed', () => {
  app.quit();
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

ipcMain.on('request-open-file', (event, filePath,currentFilePath="") => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)

  if (currentFilePath == ""){
    openFileFromPath(expandPath(filePath));
    return
  }

  const dirName = path.dirname(currentFilePath);   // 例: Dropbox/logtext
  console.log(filePath)
  const NewFileName = filePath + ".md"
  const newPath = path.join(dirName, NewFileName);
  console.log(newPath + "を内部リンクとして処理します");
  if (fs.existsSync(newPath)) {
    // ファイルを開く
    console.log(newPath + "は存在しています");
    openFileFromPath(newPath,parentWindow)
  } else{
    console.log(newPath + "は存在しないので子フォルダを探します");
    const entries = fs.readdirSync(dirName, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childIndex = path.join(dirName, entry.name, NewFileName);
        if (fs.existsSync(childIndex)) {
          openFileFromPath(childIndex,parentWindow)
          //ウォッチャーが存在するなら消す
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

//タイマー用ウィンドウの作成
function createTimerWindow(parent = null) {
  console.log("create timer window")
  const win = new BrowserWindow({
    width: 500,
    height: 600,
    parent:parent,
    x: 0 ,  // 親の右下に少しずらす
    y: 0 ,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });


  //win.loadFile(path.join(__dirname, 'timer.html'));
  win.loadFile(path.join(__dirname, 'timer.html'), { query: { v: Date.now() } });

   // 絶対パスをCSS用に渡したい場合
  const imgPath = path.join(__dirname, 'images', 'background.png');
  const isDev = !app.isPackaged;
  const historyFilePath = isDev
    ? path.join(__dirname, 'build/bgimage001.jpg')
    : path.join(app.getPath('userData'), 'bgimage001.jpg');
  
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('set-background', historyFilePath);
  });

  win.on('close', (event) => {

  });

  win.on('closed', () => {
    windows.delete(win);
  });

  return win;

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