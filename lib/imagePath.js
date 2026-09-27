// lib/imagePath.js
// nodeIntegration:false 環境向け。Node の path モジュールに依存しない純粋関数。

function isHttpOrData(src) {
  return /^https?:\/\//i.test(src) || /^data:/i.test(src) || /^file:\/\//i.test(src);
}

function isAbsolutePath(src) {
  return src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src); // POSIX / Windows
}

function normalizeSegments(pathStr) {
  const parts = pathStr.split(/[\\/]+/);
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack;
}

function dirnameOf(filePath) {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx === -1 ? '' : filePath.slice(0, idx);
}

function toFileUrl(absPath) {
  const segments = normalizeSegments(absPath).map(encodeURIComponent);
  return 'file:///' + segments.join('/');
}

/**
 * @param {string|null} currentFilePath 現在開いている .md の絶対パス
 * @param {string} rawSrc マークダウン中に書かれた画像パス
 */
export function resolveImageSrc(currentFilePath, rawSrc) {
  const src = rawSrc.trim();

  if (isHttpOrData(src)) return src;
  if (isAbsolutePath(src)) return toFileUrl(src);
  if (!currentFilePath) return src; // 未保存ファイルはフォールバック

  const baseDir = dirnameOf(currentFilePath);
  return toFileUrl(baseDir + '/' + src);
}