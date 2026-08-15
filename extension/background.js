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
 * なければ作成する。
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

/*
 * ── CORSプロキシ経由のフィード取得 ──
 * fetcher.js（app.jsと共通）を読み込む。PROXIES / fetchRSSRaw 等が
 * このスコープに定義される。ページ側UI専用のloadingCount/updateFetchStatus
 * が無いことはfetcher.js側でガード済み。
 */
importScripts('fetcher.js');

/*
 * ── タブを開いていなくても定期的にバックグラウンドで更新する ──
 *
 * chrome.alarms は本番では最短1分間隔までしか設定できないため、
 * 1分ごとに起こして「今更新すべきチャンネル」を少数だけ処理する。
 * 517チャンネルなど多い場合でも、1tickで全部処理しようとすると
 * Service Workerの寿命内に終わらない可能性があるため、1回のtickで
 * 処理する件数には上限を設ける（優先度: 最も長く放置されている順）。
 */
const BG_ALARM_NAME = 'fraidycat-bg-refresh';
const BG_BATCH_SIZE = 3;
const BG_FETCH_LOG_MAX = 200;

// app.js の FREQ_INTERVAL / jitterRatio / shouldRefetch と同じロジック。
// app.js側を変更した場合はこちらも合わせて更新すること。
const BG_FREQ_INTERVAL = {
  '5分': 5 * 60 * 1000, '15分': 15 * 60 * 1000, '30分': 30 * 60 * 1000,
  '1時間': 60 * 60 * 1000, '6時間': 6 * 60 * 60 * 1000,
};
function bgJitterRatio(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return (h % 10000) / 10000;
}
function bgShouldRefetch(f) {
  if (f.suspended) return false;
  const interval = BG_FREQ_INTERVAL[f.freq];
  if (interval == null) return false; // 手動は自動更新しない
  if (!f.lastFetched) return true;
  const jitter = (bgJitterRatio(f.id) * 0.3 - 0.15) * interval; // -15%〜+15%
  return Date.now() - f.lastFetched > interval + jitter;
}

async function addBgFetchLog(entry) {
  entry.at = Date.now();
  const { fraidycat_bg_fetch_log } = await chrome.storage.local.get('fraidycat_bg_fetch_log');
  const log = Array.isArray(fraidycat_bg_fetch_log) ? fraidycat_bg_fetch_log : [];
  log.unshift(entry);
  if (log.length > BG_FETCH_LOG_MAX) log.length = BG_FETCH_LOG_MAX;
  await chrome.storage.local.set({ fraidycat_bg_fetch_log: log });
}

async function runBackgroundRefreshTick() {
  const { fraidycat_follows } = await chrome.storage.local.get('fraidycat_follows');
  if (!Array.isArray(fraidycat_follows) || !fraidycat_follows.length) return;

  const due = fraidycat_follows
    .filter(bgShouldRefetch)
    .sort((a, b) => (a.lastFetched || 0) - (b.lastFetched || 0)); // 放置期間が長い順
  if (!due.length) return;

  const batch = due.slice(0, BG_BATCH_SIZE);
  const results = []; // {id, posts, lastFetched, error, name}

  for (const f of batch) {
    const startAt = Date.now();
    try {
      const raw = await fetchRSSRaw(f.url);
      const parsed = await parseFeedViaOffscreen(raw);
      // date は chrome.storage への保存前にISO文字列へ正規化する
      // （app.js側のsave()と同じ規約。読み込み側のload()/reconcileFromChromeStorage()が
      // 文字列からDateへ復元する前提）
      const normPosts = (parsed.posts || []).map(p => ({
        ...p,
        date: p.date instanceof Date ? p.date.toISOString() : (p.date || null),
      }));
      // 取得・パース自体は成功したが0件だった場合、そのままposts:を含めて
      // マージすると、プロキシ側の一時的な不具合等で既存の投稿一覧が消えて
      // しまう（app.js側のdoFetch()と同じ問題）。直前まで投稿があったのに
      // 今回だけ0件、という場合はpostsキーをupdateに含めないことで、
      // 後段のマージ（{...f, ...r}）が既存のf.postsをそのまま残すようにする。
      const prevPosts = Array.isArray(f.posts) ? f.posts : [];
      const emptyButHadPosts = normPosts.length === 0 && prevPosts.length > 0;
      const update = { id: f.id, lastFetched: Date.now(), error: null };
      if (!emptyButHadPosts) update.posts = normPosts;
      if (parsed.feedTitle && f.name === f.url) update.name = parsed.feedTitle;
      results.push(update);
      if (emptyButHadPosts) {
        await addBgFetchLog({ id: f.id, name: f.name, ok: false, error: `0件のため既存の${prevPosts.length}件を保持`, ms: Date.now() - startAt });
      } else {
        await addBgFetchLog({ id: f.id, name: f.name, ok: true, count: normPosts.length, ms: Date.now() - startAt });
      }
    } catch (e) {
      results.push({ id: f.id, error: `取得エラー: ${e.message}` });
      await addBgFetchLog({ id: f.id, name: f.name, ok: false, error: String(e.message || e), ms: Date.now() - startAt });
    }
  }

  // 書き込み直前に最新のfraidycat_followsを読み直してマージする
  // （tick実行中にタブ側で編集・保存された可能性があるため、丸ごと上書きしない）
  const { fraidycat_follows: latest } = await chrome.storage.local.get('fraidycat_follows');
  const list = Array.isArray(latest) ? latest : fraidycat_follows;
  const byId = new Map(results.map(r => [r.id, r]));
  const merged = list.map(f => {
    const r = byId.get(f.id);
    if (!r) return f;
    return { ...f, ...r };
  });
  await chrome.storage.local.set({ fraidycat_follows: merged });
}

function ensureBgAlarm() {
  chrome.alarms.create(BG_ALARM_NAME, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureBgAlarm);
chrome.runtime.onStartup.addListener(ensureBgAlarm);
// Service Workerが起動した直後（onInstalled/onStartupが発火しないケースも含め）
// にも念のためアラームの存在を保証しておく。
ensureBgAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BG_ALARM_NAME) return;
  runBackgroundRefreshTick().catch((e) => {
    console.error('fraidycat: バックグラウンド更新tickでエラー', e);
  });
});
