# renderer.js リファクタリング計画

## 目的

現在の`renderer.js`は700行を超え、多くの機能が1つのファイルに混在している。
このリファクタリングでは、機能ごとにファイルを分割（モジュール化）することで、コードの可読性、メンテナンス性、再利用性を向上させることを目的とする。

## ファイル分割案

`renderer.js`を以下のファイルに分割する。

1.  **`codemirror-setup.js`**: CodeMirrorの基本的な設定や拡張機能をまとめる。
    *   担当範囲:
        *   `mySetup`配列
        *   `myHighlightStyle`
        *   `markdownWithGFM`
        *   `fontCompartment`
        *   テーマ設定など

2.  **`codemirror-plugins.js`**: 自作のCodeMirrorプラグインをまとめる。
    *   担当範囲:
        *   `charCountPlugin`
        *   `internalLinkPlugin`と`InternalLinkWidget`
        *   `checklistPlugin`と`CheckboxWidget`
        *   `imagePlugin`と`ImagePreviewWidget`
        *   `fileLinkPlugin`

3.  **`file-manager.js`**: ファイルの読み込み、保存、変更状態（`isDirty`）の管理など、ファイル操作に関するロジックをまとめる。
    *   担当範囲:
        *   `saveCurrentFile`関数
        *   `updateTitle`、`setDirtyState`関数
        *   オートセーブ関連のロジック (`autoSaveHandler`)
        *   `window.electronAPI`経由のファイル関連イベントリスナー (`onLoadFile`, `onTriggerSaveFile`, `onBeforeClose`, `onFileUpdated`)

4.  **`keybindings.js`**: カスタムキーボードショートカットの定義をまとめる。
    *   担当範囲:
        *   `customKeymap`
        *   `moveLineUp`, `moveLineDown`, `smartToggleFold` などのキーに紐づくコマンド関数

5.  **`modal-manager.js`**: `Cmd+O`や`Cmd+P`で表示されるモーダルウィンドウの管理ロジックをまとめる。
    *   担当範囲:
        *   モーダル表示関連のDOM取得とイベントリスナー
        *   `showModalWithContent`関数

6.  **`renderer.js` (リファクタリング後)**: エントリーポイントとしての役割に専念させる。
    *   担当範囲:
        *   各モジュールのインポート
        *   `initializeEditor`関数の定義と実行
        *   全体的な初期化処理

## 進捗状況

*   **2025-08-09**: `keybindings.js`の分離を実装完了。
    *   `lib/keybindings.js`を作成し、行移動や折りたたみに関するキー設定を移動。
    *   `renderer.js`から新しいモジュールを読み込むように修正。

## 期待される効果

*   **可読性の向上**: 各ファイルが単一の責任を持つため、コードが追いやすくなる。
*   **メンテナンス性の向上**: 機能の追加や修正が、関連するファイルのみで完結しやすくなる。
*   **再利用性の向上**: 独立したモジュールは、将来的に他のプロジェクトでも再利用しやすくなる。
