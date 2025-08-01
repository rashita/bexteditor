const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const isDev = !app.isPackaged;
const historyFilePath = isDev
  ? path.join(__dirname, 'history.json')
  : path.join(app.getPath('userData'), 'history.json');

function ensureHistoryFileExists() {
  if (!fs.existsSync(historyFilePath)) {
    fs.writeFileSync(historyFilePath, '[]', 'utf-8');  // 空の配列で初期化
  }
}

function loadHistory() {
  ensureHistoryFileExists();
  const data = fs.readFileSync(historyFilePath, 'utf-8');
  try {
    return JSON.parse(data);
  } catch (e) {
    console.warn('history.json の読み込みに失敗しました。初期化します。');
    fs.writeFileSync(historyFilePath, '[]', 'utf-8');
    return [];
  }
}

function saveHistory(history) {
  ensureHistoryFileExists();
  fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf-8');
}

function addToHistory(filePath, title = '') {
  const history = loadHistory();
  const now = new Date().toISOString();
  const filtered = history.filter(entry => entry.filePath !== filePath);
  const newEntry = { filePath, openedAt: now, title };
  const updated = [newEntry, ...filtered].slice(0, 20);
  saveHistory(updated);
}

module.exports = {
  loadHistory,
  saveHistory,
  addToHistory,
  historyFilePath // 必要なら参照用に
};
