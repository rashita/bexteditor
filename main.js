const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const fs = require('fs');
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

let fileToOpen = null

if (!process.defaultApp && process.argv.length >= 2) {
  fileToOpen = process.argv[1];
}


const windows = new Set();
const watcherMap = new Map(); // filePath → fs.FSWatcher
//複数のウィンドウで同じファイルを開いたときに、このやり方はうまくいかない気がする
//ウィンドウごとにwatcherを登録した方がよい


function createWindow(parent = null) {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

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
    windows.delete(win);
  });

  windows.add(win);
  return win;
}

// ファイルを新しいウィンドウで開く関数
async function openFileInNewWindow() {
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

// ファイルを保存する処理
async function handleFileSave(event, { filePath, content }) {
  const webContents = event.sender
  const win = BrowserWindow.fromWebContents(webContents)
  if (filePath) {
    const contentToSave = content.replace(/\u200B/g, '');
    fs.writeFileSync(filePath, contentToSave);
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

//内部リンクの呼び出し
ipcMain.on("open-link", async (event, linkText,currentFilePath) => {
  console.log("リンククリック検知:", linkText);
  if (!currentFilePath) return
  //ここでリンクの処理を行うひとまず適当に作る
  const fileName = path.basename(currentFilePath); // 例: 20250725.md
  const dirName = path.dirname(currentFilePath);   // 例: Dropbox/logtext
  const NewFileName = linkText + ".md"
  const newPath = path.resolve(dirName, NewFileName);
  //const newPath = path.join(dirName , NewFileName)
  console.log(newPath + "を内部リンクとして処理します");
  if (fs.existsSync(newPath)) {
    // ファイルを開く
    console.log(newPath + "は存在しています");
    linkOpenAndLoadFile(event,newPath)
  } else{
    console.log(newPath + "は存在しないので子フォルダを探します");
    const entries = fs.readdirSync(dirName, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childIndex = path.join(dirName, entry.name, NewFileName);
        if (fs.existsSync(childIndex)) {
          linkOpenAndLoadFile(event,childIndex)
          //ウォッチャーが存在するなら消す
        }
      }
    }
  }


  return

  if (fs.existsSync(newPath)) {
    // 既存ファイルを開く
    console.log(newPath + "は存在しています");
    try {
       console.log(newPath + "を読み込みます");
      const content = fs.readFileSync(newPath, 'utf-8');
      event.sender.send("load-file", { filePath: newPath, content });
    } catch (e) {
      dialog.showErrorBox("読み込みエラー", `ファイル読み込みに失敗しました: ${newPath}`);
    }
  } else {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["作成", "キャンセル"],
      defaultId: 0,
      cancelId: 1,
      message: `${path.basename(newPath)} は存在しません。作成しますか？`
    });

    if (response === 0) {
      //fs.writeFileSync(newPath, ""); // 空ファイル作成
      //event.sender.send("open-file", newPath);
    }
  }
});

app.setName('bextEditor');

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
        click: () => {
          createWindow();
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
        click: () => {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) {
            focusedWindow.webContents.send('trigger-save-file', { id: focusedWindow.id });
          }
        }
      },
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
  }
];

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
        //複数ウォッチャーを指定するならmap()にする
        newWindow.currentWacher = chokidar.watch(filePath, {
          usePolling: false,
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
          }
        });
        newWindow.currentWacher.on('change', () => {
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


  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

 
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

//ファイル左右移動のためのイベントリスナ
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
      //fs.writeFileSync(newPath, ""); // 空ファイル作成
      //event.sender.send("open-file", newPath);
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
    }
  }else{
    const newPath = getSnakememo(currentPath)
    if (fs.existsSync(newPath)) {
      for (const win of windows) {
       if (win.currentFilePath === newPath) {
        console.log("すでにそのファイルは開かれています")
        win.close()
        return
        }
      }
      openFileFromPath(newPath,parentWindow)//開いていなければ新しく開く
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
function linkOpenAndLoadFile(event,filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    event.sender.send("load-file", { filePath: filePath, content });
    const startWindow = BrowserWindow.fromWebContents(event.sender)
    startWindow.currentFilePath = filePath;
    console.log(startWindow.currentFilePath)
    //新しいウォッチャーを登録するよ
    if (startWindow.currentWacher){
      console.log("古いウォッチャーを解除します")
      startWindow.currentWacher.close()
    }
    console.log("ウォッチャーを登録します")

    startWindow.currentWacher = chokidar.watch(filePath, {
      usePolling: false,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });
    startWindow.currentWacher.on('change', () => {
      const newContent = fs.readFileSync(filePath, 'utf-8');
      startWindow.webContents.send('file-updated', {filePath,newContent});
    });


  } catch (err) {
    dialog.showErrorBox("読み込みエラー", `ファイルを開けませんでした: ${filePath}`);
  }
}


// 📦 モーダル用ファイル読み取り処理
ipcMain.handle("read-markdown-file", async (_, fileFullPath) => {

  const history = loadHistory()
  const content  = history
    .map(entry => "[["+shortenPath(entry.filePath)+"]]")  // ファイルパスだけ取り出す
    .join('\n');

  if(!fileFullPath)return content

  const upFilePath = levelDateInFilename(fileFullPath)

  if(upFilePath) {
    const mapContent = fs.readFileSync(upFilePath, "utf-8");
    return (content + "\n\n" + mapContent)
  }

  return content
  

});

ipcMain.on('request-open-file', (event, filePath) => {
  openFileFromPath(expandPath(filePath));
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
