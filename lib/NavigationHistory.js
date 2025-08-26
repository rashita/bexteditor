class NavigationHistory {
  constructor() {
    this.backStack = [];    // 戻る履歴
    this.forwardStack = []; // 進む履歴
  }

  // 新しい場所に移動するとき呼ぶ
  visit(entry) {
    this.backStack.push(entry);
    this.forwardStack = []; // 新しい訪問で forward 履歴はクリア
  }

  // 戻る
  back(currentEntry) {
    if (this.backStack.length === 0) return null;
    this.forwardStack.push(currentEntry);
    return this.backStack.pop();
  }

  // 進む
  forward(currentEntry) {
    if (this.forwardStack.length === 0) return null;
    this.backStack.push(currentEntry);
    return this.forwardStack.pop();
  }
}

// 他のファイルから使えるように export
export default NavigationHistory;
