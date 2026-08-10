// ツールバーのアイコンをクリックしたときの挙動。
// すでにFraidycatのタブが開いていればそこにフォーカスし、
// なければ新しいタブで開く（重複タブの乱立を防ぐ）。
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
});

/*
 * ── オフスクリーンドキュメント経由のRSS/Atomパース ──
 *
 * Service Worker（このファイル）にはDOMParserが存在しないため、
 * XML/Atomのパースだけは非表示の「オフスクリーンドキュメント」
 * (offscreen.html) に一時的に任せる。既に開いていれば使い回し、
 * なければ作成する。タブを開いていなくても動作するバックグラウンド
 * 更新（今後実装予定）の土台として用意している。
 */
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreenDocument; // 同時に複数回作成しようとした場合の競合防止

async function hasOffscreenDocument() {
  // getContexts はManifest V3の新しめのAPI。使えない場合はfalse扱いにして
  // 作成を試み、既にあればcreateDocument側が例外を返すので握りつぶす。
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'RSS/AtomフィードのXMLをDOMParserで解析するため（Service Workerには非対応）',
  }).catch((e) => {
    // 既に作成済みの場合はここに来ることがある（競合）。無視してよい。
    if (!/single offscreen document|Only a single/i.test(String(e && e.message || e))) {
      throw e;
    }
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = undefined;
  }
}

// raw（XML文字列 or {rss2json:...}）をオフスクリーンドキュメントに渡してパースし、
// {feedTitle, posts} を返す。失敗時は例外を投げる。
async function parseFeedViaOffscreen(raw) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'parseFeed',
    raw,
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || 'オフスクリーンドキュメントでのパースに失敗');
  }
  return response.data;
}
