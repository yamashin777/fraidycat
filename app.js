/* ── chrome.storage.local へのミラー書き込み（Chrome拡張機能のバックグラウンド対応の土台）──
   Service Worker（background.js）はdocument/localStorageに一切アクセスできないため、
   バックグラウンドで自動更新を行うには、フォローデータや設定をService Worker側からも
   参照できる場所（chrome.storage.local）に置いておく必要がある。
   このアプリ自体（ページ側）は今まで通りlocalStorageを正として同期的に読み書きし続け、
   挙動は一切変えない。ここではlocalStorageへの書き込みと同時に、
   chrome拡張機能内で実行されている場合に限り、chrome.storage.localにも
   同じ内容を書き込んでおく（Web版ではchrome.storageが存在しないため何もしない）。
   読み込み（バックグラウンドで取得された新着データの反映）は次のステップで対応する。 */
const hasChromeStorage = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
function mirrorToChromeStorage(obj){
  if(!hasChromeStorage) return;
  try{ chrome.storage.local.set(obj).catch(()=>{}); }catch(e){}
}

/* ── イベント委任（将来のChrome拡張機能化を見据えた土台）──
   Chrome拡張機能（Manifest V3）は既定のCSPでonclick="..."のような
   インラインイベント属性を許可しない。そのため、HTML文字列に直接
   onclick等を書く代わりに、data-action（呼び出す関数名）・data-args
   （JSON配列の引数、要素自身の値を渡したい場合は"@value"と書く）を
   属性に持たせておき、ここでdocumentに1箇所だけ登録したリスナーが
   クリック・変更を拾って該当関数を呼び出す方式に段階的に移行する。
   （既存のonclickを全部一度に置き換えるのはリスクが高いため、
   まずは「久しぶり」パネル・履歴から対応し、問題なければ範囲を広げる）

   注意点: この仕組みはdocumentに1つだけ登録しているため、
   要素自身より上の階層で「.onclickプロパティに直接ハンドラを
   登録している」ような箇所（例: モーダルの背景クリックで閉じる処理）
   より後に実行される（バブリングでdocumentは最後に発火するため）。
   祖先要素の.onclickより先に止めたい処理がある場合は、この仕組みを
   使わず、その要素の生成時に直接addEventListenerする。 */
// kindを指定すると、まずdata-action-{kind}/data-args-{kind}（例: data-action-focus）を
// 優先的に探す。1つの要素に「入力のたびに」「フォーカス時」「フォーカスが外れた時」など
// 複数の異なる動作を紐付けたい場合（例: タグ入力欄）に使う。指定がない・見つからない場合は
// 通常のdata-action/data-argsにフォールバックする。
function runDelegatedAction(el, evt, kind){
  const action = (kind && el.dataset['action'+kind]) || el.dataset.action;
  if(!action) return;
  const fn = window[action];
  if(typeof fn !== 'function'){ console.warn('data-actionが未定義:', action); return; }
  const argsAttr = (kind && el.dataset['args'+kind]) || el.dataset.args;
  let args = [];
  if(argsAttr){
    try{ args = JSON.parse(argsAttr); }catch(err){ console.warn('data-args解析失敗:', argsAttr, err); }
  }
  // イベントオブジェクト自体が必要な場合のみ、明示的に"@evt"を書いた箇所に渡す
  // （以前は常に引数の末尾にevtを自動付加していたが、openLogModal(f)のように
  // 「引数なし＝undefined」を意味あるデフォルト値として使う関数がある場合、
  // 意図せずevtオブジェクトがその引数に紛れ込んでしまう不具合の元になるため廃止）
  args = args.map(a => a === '@value' ? el.value : a === '@el' ? el : a === '@evt' ? evt : a);
  fn(...args);
}
document.addEventListener('click', function(e){
  const el = e.target.closest('[data-click="1"]');
  if(el){ runDelegatedAction(el, e); return; }
  // フォローカードは全体がクリックで展開／折りたたみできる。
  // ただし詳細パネル・登録日ポップアップ・メモ・リンク・入力欄の上でのクリックは対象外にする
  // （以前はカード自身のonclick属性＋event.stopPropagationで実現していたが、
  // stopPropagationはこのdocument委任リスナーより手前で伝播を止めてしまい
  // 委任の仕組みごと機能しなくなるため、代わりにここで除外判定する）。
  const card = e.target.closest('.follow-card');
  if(card && !e.target.closest('.fc-detail,.fc-regdate-popup,.fc-memo-inline,a,input,textarea,select,.dp-dur')){
    const id = Number(card.id.replace('fc-',''));
    if(!isNaN(id)) toggleExpand(id);
  }
});
// スマホでのタップ即応答用（onclick+ontouchend+preventDefaultの旧実装を踏襲）。
// data-touchend="1"が付いた要素はtouchendの時点でpreventDefaultし、
// 後から発火する合成clickイベントによる二重実行を防ぐ。
document.addEventListener('touchend', function(e){
  const el = e.target.closest('[data-touchend="1"]');
  if(el){ e.preventDefault(); runDelegatedAction(el, e); }
});
document.addEventListener('change', function(e){
  const el = e.target.closest('[data-change="1"]');
  if(el) runDelegatedAction(el, e);
});
// 検索欄などの「入力のたびに」反映したい欄用（changeはフォーカスが外れるまで発火しない）
document.addEventListener('input', function(e){
  const el = e.target.closest('[data-input="1"]');
  if(el) runDelegatedAction(el, e);
});
// blurはバブリングしないため、代わりにバブリングするfocusoutで拾う
document.addEventListener('focusout', function(e){
  const el = e.target.closest('[data-blur="1"]');
  if(el) runDelegatedAction(el, e, 'Blur');
});
// focusも同様にバブリングしないため、代わりにバブリングするfocusinで拾う
document.addEventListener('focusin', function(e){
  const el = e.target.closest('[data-focus="1"]');
  if(el) runDelegatedAction(el, e, 'Focus');
});
// テキスト入力欄でEnterを押したらフォーカスを外す（＝data-blurの確定処理を発火させる）
document.addEventListener('keyup', function(e){
  if(e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter-blur="1"]');
  if(el) el.blur();
});
// 画像読み込み失敗時のフォールバック（アイコン画像が404等の場合に非表示にする）。
// errorイベントはバブリングしないため、代わりにキャプチャフェーズで拾う。
document.addEventListener('error', function(e){
  const el = e.target;
  if(!el || !el.dataset) return;
  if(el.dataset.errorAction === 'hideSelf'){
    el.style.display = 'none';
  } else if(el.dataset.errorAction === 'hideParent'){
    if(el.parentElement) el.parentElement.style.display = 'none';
  }
}, true);

/* ── CORS proxy options (tried in order) ── */
/* PROXIES / PROXY_NAMES / lastUsedProxy は fetcher.js に移動（Service Workerとも共有するため） */

// ── フェッチログ（PC向け・localStorage保存） ──
// ログ上限はチャンネル数に応じて自動調整（一周分＋余裕）。
// iOSはエクスポート時に画面内へ全文表示する方式のため件数が多いと重くなりやすく、
// 従来通り控えめ（最低300・最大2000）にする。PCはファイルダウンロードなので
// 容量に余裕があり、より多くの履歴を保持できるようにする（最低1000・最大6000）。
function isIOSDevice(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
}
function fetchLogMax(){
  const n = (typeof follows !== 'undefined' && follows.length) ? follows.length : 300;
  if(isIOSDevice()) return Math.min(2000, Math.max(300, Math.ceil(n * 1.5)));
  return Math.min(6000, Math.max(1000, Math.ceil(n * 4)));
}
let fetchLog = [];
try{
  const saved = localStorage.getItem('fraidycat_fetch_log');
  if(saved) fetchLog = JSON.parse(saved) || [];
}catch(e){ fetchLog = []; }

function addFetchLog(entry){
  entry.at = Date.now();
  fetchLog.unshift(entry); // 新しい順
  const maxLog = fetchLogMax();
  if(fetchLog.length > maxLog) fetchLog = fetchLog.slice(0, maxLog);
  try{ localStorage.setItem('fraidycat_fetch_log', JSON.stringify(fetchLog)); }catch(e){}
  // ログ画面が開いていれば再描画する。
  // ただし高頻度チャンネルの連続フェッチで毎回即時に再描画すると、
  // 一覧のクリック中に行が入れ替わってクリックが届かなくなることがあるため、
  // 少し間引いて（デバウンスして）再描画する。
  if(document.getElementById('logModalBody')) debouncedRenderLogModal();
}
let logModalRenderTimer = null;
function debouncedRenderLogModal(){
  if(logModalRenderTimer) clearTimeout(logModalRenderTimer);
  logModalRenderTimer = setTimeout(()=>{
    logModalRenderTimer = null;
    if(document.getElementById('logModalBody')) renderLogModal();
  }, 600);
}

function clearFetchLog(){
  fetchLog = [];
  try{ localStorage.removeItem('fraidycat_fetch_log'); }catch(e){}
  if(document.getElementById('logModalBody')) renderLogModal();
}

// テキストをエクスポートする際の共通モーダル。iOSはクリップボードAPIの
// 挙動が不安定（Brave等で許可待ちのままPromiseが解決せず「押しても何も
// 起きない」ことがある）ため、常に成功する保証がない自動コピーだけに頼らず、
// 内容を直接画面に表示し、タップして手動でも選択・コピーできるようにする。
function showTextExportModal(title, text, filename){
  const blob = new Blob([text], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeModalContainerIfBackdrop" data-args='["@el","@evt"]'>
    <div class="modal" style="max-width:560px">
      <h2>${esc(title)}</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
        下のボタンでコピーを試すか、確実な方法として下のテキスト欄をタップ（全選択されます）→
        指を離さず長押し→「コピー」を選んでください。<br>
        リンクを長押し→「リンク先のファイルをダウンロード」でファイル保存もできます。
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn-ok" data-click="1" data-action="copyTextExportArea" data-args='["@el"]'>クリップボードにコピー</button>
        <a class="btn-ok" href="${url}" download="${filename}"
           style="text-decoration:none;display:inline-flex;align-items:center"
           target="_blank" rel="noopener">ファイルとして開く</a>
      </div>
      <textarea id="textExportArea" readonly
        style="width:100%;height:240px;font-family:'DM Mono',monospace;font-size:11px;
        border:1px solid var(--border-strong);border-radius:8px;padding:8px;
        background:var(--bg);color:var(--text);resize:vertical;-webkit-user-select:all;user-select:all"
        data-click="1" data-action="selectInputText" data-args='["@el"]'>${esc(text)}</textarea>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeModalContainer">閉じる</button>
      </div>
    </div>
  </div>`;
}
// navigator.clipboard.writeText()はPromiseベースで、一部のiOSブラウザ
// （Braveなど）では許可待ちのまま解決も失敗もせず固まることがあり、
// 「押しても反応が分からない」原因になっていた。ここでは同期的に結果が
// 分かるdocument.execCommand('copy')のみを使い、戻り値で成否を正確に
// 判定した上で、ボタンの文字だけでなくトースト通知でもはっきり伝える。
function copyTextExportArea(btn){
  const ta = document.getElementById('textExportArea');
  if(!ta) return;
  ta.focus();
  ta.select();
  try{ ta.setSelectionRange(0, ta.value.length); }catch(e){} // iOS系で select() だけだと選択されない場合があるため
  let ok = false;
  try{ ok = document.execCommand('copy'); }catch(e){ ok = false; }
  const orig = btn.textContent;
  if(ok){
    btn.textContent = '✓ コピーしました';
    showToast('クリップボードにコピーしました', 2500);
  } else {
    btn.textContent = '✕ コピー失敗';
    showToast('自動コピーに失敗しました。テキスト欄を長押しして手動でコピーしてください', 4500);
  }
  setTimeout(()=>{ btn.textContent = orig; }, 1800);
}

// ログをJSON形式でエクスポート（解析ツール用）
function exportFetchLog(){
  const data = JSON.stringify(fetchLog, null, 2);
  const fname = `fraidycat_log_${new Date().toISOString().slice(0,10)}.json`;
  // 以前はnavigator.userAgent等でiOS判定して分岐していたが、Braveなど一部
  // ブラウザはプライバシー保護のためUser-Agentを偽装・簡略化することがあり、
  // 判定が外れて「本来はモーダルを開くべきなのに、動作しないダウンロードの
  // ままになる」不具合につながっていた。判定に頼らず、常に確実なモーダル
  // （コピーボタン・手動選択・ファイルリンクの3通りの手段を持つ）を使う。
  // 取得ログモーダル（#logModal）はdocument.bodyに直接追加された別要素で、
  // #modalContainerより後に存在するため常に手前に重なって表示される。
  // 閉じずに開くと裏に隠れて見えなくなるため、先に閉じてから開く。
  closeLogModal();
  showTextExportModal(`取得ログ（${fetchLog.length}件）`, data, fname);
}

const COLORS = [
  {bg:'#E8F5E9',fg:'#1B5E20',dark_bg:'#1B5E20',dark_fg:'#A5D6A7'},
  {bg:'#E3F2FD',fg:'#0D47A1',dark_bg:'#0D47A1',dark_fg:'#90CAF9'},
  {bg:'#FFF3E0',fg:'#E65100',dark_bg:'#BF360C',dark_fg:'#FFCC80'},
  {bg:'#F3E5F5',fg:'#4A148C',dark_bg:'#4A148C',dark_fg:'#CE93D8'},
  {bg:'#FCE4EC',fg:'#880E4F',dark_bg:'#880E4F',dark_fg:'#F48FB1'},
  {bg:'#E0F2F1',fg:'#004D40',dark_bg:'#004D40',dark_fg:'#80CBC4'},
  {bg:'#FFF8E1',fg:'#F57F17',dark_bg:'#E65100',dark_fg:'#FFE082'},
  {bg:'#EFEBE9',fg:'#3E2723',dark_bg:'#3E2723',dark_fg:'#BCAAA4'},
];

const FREQS = ['5分','15分','30分','1時間','6時間'];
// 旧ラベル→新ラベルの移行マッピング
const FREQ_MIGRATION = {
  'リアルタイム':'5分','毎日':'1時間','毎週':'6時間','毎月':'6時間','毎年':'6時間',
  '手動':'6時間'
};
const MARK_COLORS = {
  red:    {border:'#E00', bg:'#FFE5E5', darkBg:'#4A1010', label:'赤'},
  blue:   {border:'#07C', bg:'#E5F4FF', darkBg:'#0D2A4A', label:'青'},
  green:  {border:'#080', bg:'#E5FFE8', darkBg:'#0A3A18', label:'緑'},
  yellow: {border:'#E6B800', bg:'#FFFBE5', darkBg:'#3A3000', label:'黄'},
};
const FREQ_PILL = {
  '5分':'fp-rt','15分':'fp-daily','30分':'fp-weekly',
  '1時間':'fp-monthly','6時間':'fp-yearly'
};
const FREQ_INTERVAL = {
  '5分':5*60*1000,'15分':15*60*1000,'30分':30*60*1000,
  '1時間':60*60*1000,'6時間':6*60*60*1000
};

/* ── State ── */
let follows = [];
let activeTag = 'すべて';
let activeFreq = null;
let expanded = null;
let showModal = false;
let formData = {name:'',url:'',platform:'RSS/ブログ',freq:'6時間',tags:'',memo:'',colorIdx:0};
let sortMode = 'freq';
let searchQuery = '';
let tagOrder = JSON.parse(localStorage.getItem('fraidycat_tag_order') || '[]');
let ytApiKey = localStorage.getItem('fraidycat_yt_api_key') || '';
let geminiApiKey = localStorage.getItem('fraidycat_gemini_api_key') || '';
// 「久しぶり更新」とみなす間隔（日数）。設定画面（久しぶり履歴）から変更可能。
let revivalThresholdDays = parseInt(localStorage.getItem('fraidycat_revival_threshold_days'), 10) || 14;

/* ── GitHub同期設定 ── */
let ghToken = localStorage.getItem('fraidycat_gh_token') || '';
let ghRepo  = localStorage.getItem('fraidycat_gh_repo')  || 'yamashin777/fraidycat';
let ghPath  = localStorage.getItem('fraidycat_gh_path')  || 'data/follows.json';
let ghSyncEnabled = localStorage.getItem('fraidycat_gh_sync') === 'true';
let ghSha = null; // 最新ファイルのSHA（更新に必要）
let ghSaveTimer = null;
// 直近のローカル編集時刻（タグ変更等）。save()のたびに更新し、localStorageにも
// 永続化する。GitHubへのアップロードはデバウンス（5〜12秒後）されるため、
// 編集直後にページを再読み込みすると、アップロードが完了する前に古いGitHub側
// データを読み込んでしまい、編集が消えて見える不具合があった。
// 直近の編集から一定時間はGitHubからの読み込みをスキップすることで防ぐ。
let lastLocalEditAt = parseInt(localStorage.getItem('fraidycat_last_local_edit_at'), 10) || 0;
const GH_PULL_PROTECT_MS = 20000; // アップロードのデバウンス(最大12秒)より長めに確保

// 直近にGitHubから正常に読み込めた時刻。24時間ごとの自動再同期の判定に使う。
// setInterval単体だとタブが一定時間バックグラウンドに回された時にブラウザ側で
// 間引かれ、スマホでは「開きっぱなしでも24時間ごとに同期」が実質機能しない
// ことがあったため、経過時間ベースでの判定（タブが再度アクティブになった時に
// 「前回の読み込みから24時間以上経っていないか」をチェックする方式）を併用する。
let ghLastPullAt = parseInt(localStorage.getItem('fraidycat_gh_last_pull_at'), 10) || 0;
const GH_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間

// GitHub同期（読み込み・保存）の履歴ログ。他端末（スマホ等）で同期がうまく
// いかない時、その場で状況を伝えてもらう代わりに、後からこのログを
// エクスポート／画面表示して確認できるようにするためのもの
// （取得ログ fetchLog と同じ仕組みをGitHub同期用に用意したもの）。
let ghSyncLog = [];
try{
  const savedGhSyncLog = localStorage.getItem('fraidycat_gh_sync_log');
  if(savedGhSyncLog) ghSyncLog = JSON.parse(savedGhSyncLog) || [];
}catch(e){ ghSyncLog = []; }
function addGhSyncLog(entry){
  entry.at = Date.now();
  ghSyncLog.unshift(entry);
  if(ghSyncLog.length > 100) ghSyncLog = ghSyncLog.slice(0, 100);
  try{ localStorage.setItem('fraidycat_gh_sync_log', JSON.stringify(ghSyncLog)); }catch(e){}
  mirrorToChromeStorage({ fraidycat_gh_sync_log: ghSyncLog });
}

function saveGhSettings(token, repo, path, enabled){
  ghToken = token; ghRepo = repo; ghPath = path; ghSyncEnabled = enabled;
  localStorage.setItem('fraidycat_gh_token',  token);
  localStorage.setItem('fraidycat_gh_repo',   repo);
  localStorage.setItem('fraidycat_gh_path',   path);
  localStorage.setItem('fraidycat_gh_sync',   enabled ? 'true' : 'false');
  mirrorToChromeStorage({
    fraidycat_gh_token: token, fraidycat_gh_repo: repo,
    fraidycat_gh_path: path, fraidycat_gh_sync: enabled
  });
}

/* GitHubからデータを読み込む */
async function loadFromGitHub(){
  if(!ghSyncEnabled || !ghToken || !ghRepo){
    addGhSyncLog({type:'pull', ok:false, reason:'同期が無効、またはトークン/リポジトリ未設定'});
    return false;
  }
  // 直近の編集がまだGitHubにアップロードされていない可能性がある間は、
  // 古いGitHub側データで上書きしてしまわないよう読み込みをスキップする。
  // （タグ変更などの編集直後にページを再読み込みすると、アップロードの
  // デバウンス（最大12秒）が完了する前にGitHubから古いデータを取り込み、
  // 編集が消えて見える不具合があったため）
  if(Date.now() - lastLocalEditAt < GH_PULL_PROTECT_MS){
    console.warn('直近の編集を保護するためGitHub読み込みをスキップしました');
    addGhSyncLog({type:'pull', ok:false, reason:'直近の編集保護によりスキップ', localCount:follows.length});
    return false;
  }
  try{
    const res = await fetch(
      `https://api.github.com/repos/${ghRepo}/contents/${ghPath}`,
      {headers:{'Authorization':`token ${ghToken}`,'Accept':'application/vnd.github.v3+json'}}
    );
    if(res.status === 404){ addGhSyncLog({type:'pull', ok:false, reason:'ファイルが存在しない(404)'}); return false; } // ファイルがまだない
    if(!res.ok) throw new Error(`GitHub API ${res.status}`);
    const json = await res.json();
    ghSha = json.sha;
    // TextDecoderでデコード（TextEncoderで保存したデータに対応）
    const binStr = atob(json.content.replace(/\n/g,''));
    const bytes = new Uint8Array(binStr.length);
    for(let i=0; i<binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    // 新形式（{follows, tagOrder, revivalHistory, revivalThresholdDays}）と旧形式（配列）の両対応
    const followsData = Array.isArray(decoded) ? decoded : decoded.follows;
    const tagOrderData = decoded.tagOrder || null;
    if(!Array.isArray(followsData)){ addGhSyncLog({type:'pull', ok:false, reason:'followsフィールドが配列でない'}); return false; }

    // 文字化けチェック（壊れたデータでローカルを上書きしないため）
    const firstName = followsData[0]?.name || '';
    const hasGarbled = /[\uFFFD\u0000-\u001F]/.test(firstName) ||
      (firstName.length > 0 && !/[\u0020-\u007E\u3000-\u9FFF\uF900-\uFAFF]/.test(firstName));
    if(hasGarbled){
      console.warn('GitHub data appears garbled, skipping load');
      addGhSyncLog({type:'pull', ok:false, reason:'データが文字化けしているためスキップ', remoteCount:followsData.length});
      return false;
    }
    // GitHub側の件数がローカルより大幅に少ない場合は、データ消失を避けるためローカルを優先する
    if(follows.length > 0 && followsData.length < follows.length * 0.8){
      console.warn(`GitHub(${followsData.length}) << Local(${follows.length}), skipping load`);
      addGhSyncLog({type:'pull', ok:false, reason:'GitHub側の件数が大幅に少ないためスキップ', remoteCount:followsData.length, localCount:follows.length});
      return false;
    }

    console.log('loadFromGitHub tagOrderData:', tagOrderData?.length||'なし', tagOrderData?.slice(0,3));
    if(tagOrderData && tagOrderData.length > 0){
      tagOrder = tagOrderData;
      localStorage.setItem('fraidycat_tag_order', JSON.stringify(tagOrder));
      mirrorToChromeStorage({ fraidycat_tag_order: tagOrder });
      console.log('tagOrder set to:', tagOrder.length, tagOrder.slice(0,3));
    }
    follows = followsData.map(f=>({
      ...f,
      freq: migrateFreq(f.freq),
      registeredAt: f.registeredAt || f.id || Date.now(),
      posts: (f.posts||[]).map(p=>({
        ...p,
        date: p.date ? new Date(p.date) : null
      })).filter(p=>!p.date||!isNaN(p.date.getTime())),
      loading: false,
      error: f.error||null,
    }));

    // 久しぶり履歴は他端末の分と統合する（linkで重複排除しつつ両方の内容を残す）
    if(Array.isArray(decoded.revivalHistory) && decoded.revivalHistory.length){
      const merged = [...revivalHistory, ...decoded.revivalHistory];
      const seen = new Set();
      const dedup = [];
      for(const r of merged.sort((a,b)=>(b.at||0)-(a.at||0))){
        if(!r || !r.link || seen.has(r.link)) continue;
        seen.add(r.link);
        dedup.push(r);
      }
      revivalHistory = dedup.slice(0, REVIVAL_HISTORY_MAX);
      try{ localStorage.setItem('fraidycat_revival_history', JSON.stringify(revivalHistory)); mirrorToChromeStorage({ fraidycat_revival_history: revivalHistory }); }catch(e){}
    }
    // 久しぶり判定日数はGitHub側を優先し、他端末で設定した値に揃える
    if(decoded.revivalThresholdDays){
      revivalThresholdDays = decoded.revivalThresholdDays;
      try{ localStorage.setItem('fraidycat_revival_threshold_days', String(revivalThresholdDays)); mirrorToChromeStorage({ fraidycat_revival_threshold_days: revivalThresholdDays }); }catch(e){}
    }

    save(false, false); // localStorageにも保存（GitHub同期はしない）。GitHubから届いたデータなのでローカル編集扱いにしない
    ghLastPullAt = Date.now();
    try{ localStorage.setItem('fraidycat_gh_last_pull_at', String(ghLastPullAt)); }catch(e){}
    addGhSyncLog({type:'pull', ok:true, remoteCount:followsData.length, localCountBefore:follows.length});
    return true;
  }catch(e){
    console.warn('GitHub load error:', e);
    addGhSyncLog({type:'pull', ok:false, reason:e.message});
    return false;
  }
}

/* GitHubにデータを保存（デバウンス付き） */
let ghLastSaveAt = 0;
function scheduleSaveToGitHub(){
  if(!ghSyncEnabled || !ghToken || !ghRepo) return;
  if(ghSaveTimer) clearTimeout(ghSaveTimer);
  // 連続呼び出しをまとめる。前回保存から間もない場合はさらに延ばす
  const sinceLast = Date.now() - ghLastSaveAt;
  const delay = sinceLast < 15000 ? 12000 : 5000;
  ghSaveTimer = setTimeout(()=>saveToGitHub(), delay);
}

let ghSaving = false; // 同時保存を防ぐロック
let ghSavePending = false; // 保存中に来た要求を後で実行

async function saveToGitHub(retryCount){
  retryCount = retryCount || 0;
  if(!ghSyncEnabled || !ghToken || !ghRepo) return;
  // 既に保存中なら、終わった後にもう一度だけ保存予約
  if(ghSaving){ ghSavePending = true; return; }
  ghSaving = true;
  try{
    // 保存前に必ず最新SHAを取得（衝突予防）
    try{
      const head = await fetch(`https://api.github.com/repos/${ghRepo}/contents/${ghPath}`,
        {headers:{'Authorization':`token ${ghToken}`}});
      if(head.ok){ const hj = await head.json(); ghSha = hj.sha; }
    }catch(e){ /* SHA取得失敗時は既存のghShaで試行 */ }

    const data = follows.map(f=>({
      ...f,
      posts:(f.posts||[]).map(p=>({...p,date:p.date instanceof Date?p.date.toISOString():(p.date||null)}))
    }));
    const jsonStr = JSON.stringify({follows: data, tagOrder: tagOrder, revivalHistory: revivalHistory, revivalThresholdDays: revivalThresholdDays});
    const bytes = new TextEncoder().encode(jsonStr);
    const binStr = Array.from(bytes).map(b=>String.fromCharCode(b)).join('');
    const content = btoa(binStr);
    const body = {message:`fraidycat sync ${new Date().toISOString()}`,content};
    if(ghSha) body.sha = ghSha;
    const res = await fetch(
      `https://api.github.com/repos/${ghRepo}/contents/${ghPath}`,
      {method:'PUT',headers:{'Authorization':`token ${ghToken}`,'Content-Type':'application/json'},
       body:JSON.stringify(body)}
    );
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      console.warn('GitHub save error:', res.status, err.message);
      if(res.status===409 && retryCount < 3){
        // SHA不一致: 最新SHAを取り直して再試行（最大3回・ロック保持のまま）
        await new Promise(r=>setTimeout(r, 500));
        try{
          const h2 = await fetch(`https://api.github.com/repos/${ghRepo}/contents/${ghPath}`,
            {headers:{'Authorization':`token ${ghToken}`}});
          if(h2.ok){ const hj2 = await h2.json(); ghSha = hj2.sha; }
        }catch(e){}
        ghSaving = false; // 再帰呼び出しのため一旦解除
        return saveToGitHub(retryCount+1);
      }
      setStatus('warn', `⚠ GitHub保存失敗: ${err.message||res.status}`);
      addGhSyncLog({type:'push', ok:false, reason:err.message||`HTTP ${res.status}`, count:data.length});
      return;
    }
    const json = await res.json();
    ghSha = json.content?.sha;
    ghLastSaveAt = Date.now();
    console.log('GitHub save OK, sha:', ghSha);
    setStatus('ok', `GitHub同期完了: ${new Date().toLocaleTimeString('ja-JP')}`);
    addGhSyncLog({type:'push', ok:true, count:data.length});
  }catch(e){
    console.warn('GitHub save error:', e);
    setStatus('warn', `⚠ GitHub保存エラー: ${e.message}`);
    addGhSyncLog({type:'push', ok:false, reason:e.message});
  }finally{
    ghSaving = false;
    // 保存中に来た要求があれば、デバウンス経由で1回だけ再保存（連続コミット防止）
    if(ghSavePending){
      ghSavePending = false;
      scheduleSaveToGitHub();
    }
  }
}

/* GitHub設定モーダル */
function openGhSettingsModal(){
  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeModalContainerIfBackdrop" data-args='["@el","@evt"]'>
    <div class="modal" style="max-width:480px">
      <h2>GitHub同期設定</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:1rem;line-height:1.6">
        複数端末でデータを自動同期します。<br>
        Personal Access Token（repo権限）が必要です。
      </div>
      <div class="form-row">
        <label class="form-label">Personal Access Token</label>
        <input class="form-input" id="gh-token" type="password"
          value="${esc(ghToken)}" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx">
      </div>
      <div class="form-row">
        <label class="form-label">リポジトリ（ユーザー名/リポジトリ名）</label>
        <input class="form-input" id="gh-repo" type="text"
          value="${esc(ghRepo)}" placeholder="yamashin777/fraidycat">
      </div>
      <div class="form-row">
        <label class="form-label">保存先パス</label>
        <input class="form-input" id="gh-path" type="text"
          value="${esc(ghPath)}" placeholder="data/follows.json">
      </div>
      <div class="form-row" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="gh-enabled" ${ghSyncEnabled || !ghToken ? 'checked' : ''}>
        <label for="gh-enabled" style="font-size:13px;cursor:pointer">同期を有効にする</label>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeModalContainer">キャンセル</button>
        <button class="btn-ok" data-click="1" data-action="applyGhSettings">保存して同期テスト</button>
      </div>
      ${renderGhSyncLogSection()}
    </div>
  </div>`;
}

// 直近のGitHub同期（読み込み・保存）の履歴を表示する。他端末（スマホ等）で
// 同期がうまくいかない時、その場で状況を伝えてもらう代わりに、この端末に
// 残っているログを見て（またはエクスポートしてもらって）原因を確認できる
// ようにするためのもの。
function renderGhSyncLogSection(){
  if(!ghSyncLog.length) return '';
  const rows = ghSyncLog.slice(0, 15).map(l=>{
    const t = new Date(l.at);
    const time = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    const typeLabel = l.type === 'push' ? '↑保存' : '↓読込';
    const icon = l.ok ? '✓' : '✕';
    const color = l.ok ? '#0A8' : '#D33';
    let detail;
    if(l.ok){
      detail = l.type === 'push' ? `${l.count}件アップロード` : `${l.remoteCount}件取得`;
    } else {
      detail = esc(l.reason || '失敗');
    }
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;border-bottom:1px solid var(--border)">
      <span style="color:${color};flex-shrink:0">${icon}</span>
      <span style="color:var(--text-faint);flex-shrink:0;font-family:'DM Mono',monospace">${time}</span>
      <span style="flex-shrink:0">${typeLabel}</span>
      <span style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${detail}</span>
    </div>`;
  }).join('');
  return `
    <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;font-weight:500;color:var(--text-muted)">同期ログ（直近${Math.min(15,ghSyncLog.length)}件）</span>
        <button class="btn-cancel" style="margin-left:auto;font-size:10px;padding:2px 8px" data-click="1" data-action="exportGhSyncLog">エクスポート</button>
      </div>
      <div style="max-height:180px;overflow-y:auto">${rows}</div>
    </div>`;
}

// 同期ログをJSONでエクスポート（他人と共有・後から解析するため）
function exportGhSyncLog(){
  const data = JSON.stringify(ghSyncLog, null, 2);
  const fname = `fraidycat_gh_sync_log_${new Date().toISOString().slice(0,10)}.json`;
  // User-Agent判定に頼らず、常に確実なモーダル（showTextExportModal）を使う
  // （Brave等一部ブラウザはUser-Agentを偽装・簡略化することがあり、
  // 判定が外れて動作しないダウンロードのままになる不具合につながっていた）。
  showTextExportModal(`GitHub同期ログ（${ghSyncLog.length}件）`, data, fname);
}

async function applyGhSettings(){
  const token   = document.getElementById('gh-token').value.trim();
  const repo    = document.getElementById('gh-repo').value.trim();
  const path    = document.getElementById('gh-path').value.trim();
  const enabled = document.getElementById('gh-enabled').checked;
  saveGhSettings(token, repo, path, enabled);
  document.getElementById('modalContainer').innerHTML='';
  if(enabled && token && repo){
    setStatus('loading','GitHub接続テスト中...');
    try{
      // まず接続テスト
      const testRes = await fetch(
        `https://api.github.com/repos/${repo}`,
        {headers:{'Authorization':`token ${token}`,'Accept':'application/vnd.github.v3+json'}}
      );
      if(!testRes.ok){
        const err = await testRes.json().catch(()=>({}));
        setStatus('warn', `⚠ GitHub接続失敗: ${err.message||testRes.status}`);
        return;
      }
      const ok = await loadFromGitHub();
      if(ok){
        render();
        renderTags();
        setStatus('ok',`GitHub同期OK！データを読み込みました（タグ順${tagOrder.length}件）`);
      } else {
        await saveToGitHub();
        const saved = ghSha ? true : false;
        if(saved){
          setStatus('ok','GitHub同期OK！新規ファイルを作成しました');
        } else {
          setStatus('err','ファイル作成に失敗しました。トークンのrepo権限を確認してください');
        }
      }
    }catch(e){
      setStatus('err', `エラー: ${e.message}`);
    }
  }
}
let loadingCount = 0;
let fetchTotal = 0;   // 今回の更新バッチの総件数
let fetchDone = 0;    // 完了件数

let currentFetchingName = ''; // 現在取得中のチャンネル名

/* ── タブの非アクティブ時間を記録 ──
   バックグラウンドタブはブラウザにより定期実行が間引かれるため、
   「5分毎チャンネルが一周する時間」等の統計にタブ非アクティブの時間が
   含まれると、実際の取得性能とは関係なく数値が大きくぶれてしまう。
   非アクティブだった時間帯を記録しておき、統計側で差し引けるようにする。 */
let pageHiddenSince = (typeof document !== 'undefined' && document.hidden) ? Date.now() : null;
let hiddenTimeLog = []; // [{start, end}, ...]
if(typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){
      pageHiddenSince = Date.now();
    } else if(pageHiddenSince){
      hiddenTimeLog.push({start: pageHiddenSince, end: Date.now()});
      const cutoff = Date.now() - 2*60*60*1000; // 直近2時間分だけ保持
      hiddenTimeLog = hiddenTimeLog.filter(h=>h.end >= cutoff);
      pageHiddenSince = null;
    }
  });
}
// 指定期間 [startAt, endAt] のうち、タブが非アクティブだった時間（ms）を返す
function hiddenMsWithin(startAt, endAt){
  let total = 0;
  for(const h of hiddenTimeLog){
    const s = Math.max(h.start, startAt);
    const e = Math.min(h.end, endAt);
    if(e > s) total += (e - s);
  }
  if(pageHiddenSince){ // 現在も非アクティブ中
    const s = Math.max(pageHiddenSince, startAt);
    const e = endAt;
    if(e > s) total += (e - s);
  }
  return total;
}

function updateFetchStatus(){
  if(loadingCount === 0){
    const errs = follows.filter(x=>x.error).length;
    if(errs) setStatus('err', `${errs}件のエラー`);
    else setStatus('ok', `最終更新: ${new Date().toLocaleTimeString('ja-JP')}`);
    fetchTotal = 0; fetchDone = 0; currentFetchingName = '';
    hideProgressBar();
  } else {
    if(fetchTotal > 0){
      const pct = Math.round(fetchDone / fetchTotal * 100);
      const via = lastUsedProxy ? ` via ${lastUsedProxy}` : '';
      const name = currentFetchingName ? ` — ${currentFetchingName}${via}` : '';
      setStatus('loading', `更新中 ${fetchDone}/${fetchTotal}（${pct}%）${name}`);
      showProgressBar(fetchDone, fetchTotal, pct);
    } else {
      setStatus('loading', '更新中...');
      showProgressBar(0, 0, null);
    }
  }
}

// 画面上部の更新中バー
function showProgressBar(done, total, pct){
  let bar = document.getElementById('progressBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'progressBar';
    bar.innerHTML = '<div id="progressBarFill"></div><span id="progressBarText"></span>';
    document.body.appendChild(bar);
  }
  bar.classList.add('show');
  const fill = document.getElementById('progressBarFill');
  const text = document.getElementById('progressBarText');
  if(pct === null){
    fill.style.width = '100%';
    fill.classList.add('indeterminate');
    text.textContent = '更新中...';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = pct + '%';
    text.textContent = `更新中 ${done}/${total}（${pct}%）`;
  }
}

function hideProgressBar(){
  const bar = document.getElementById('progressBar');
  if(!bar) return;
  const fill = document.getElementById('progressBarFill');
  const text = document.getElementById('progressBarText');
  if(fill){ fill.classList.remove('indeterminate'); fill.style.width = '100%'; }
  if(text){ text.textContent = '更新完了'; }
  setTimeout(()=>{ bar.classList.remove('show'); }, 1000);
}

// ユーザーが手動で編集した（タグ・名前・メモ・URL・アイコン・マーク色・
// 更新外・頻度）ことを記録する。GitHubへのアップロードは数秒遅れる
// ため、その間にGitHubから読み込むと編集が上書きされて消えてしまう
// のを防ぐためのガードに使う（loadFromGitHub側で参照）。
function markLocalEdit(){
  lastLocalEditAt = Date.now();
  try{ localStorage.setItem('fraidycat_last_local_edit_at', String(lastLocalEditAt)); }catch(e){}
}

/* ── Storage ── */
// isUserEdit: trueの場合、markLocalEdit()を呼んでGitHub読み込みガードを更新する。
// タグ変更以外にも「対象外にする」「削除」「一括変更」等、follows配列を直接
// 変更するあらゆる関数がsave()を呼ぶたびに個別にmarkLocalEdit()を呼ぶのを
// 忘れないよう、save()側でデフォルトtrueとして一括で保護する（＝呼び忘れによる
// 「エラーが出た/削除した/対象外にしたのに元に戻る」不具合を防ぐ）。
// 逆に、doFetch()等の自動・高頻度なバックグラウンド保存はユーザー編集では
// ないため、呼び出し側で明示的にfalseを渡す（そうしないと編集が無いのに
// 常にガードがかかり続け、他端末からのGitHub読み込みが永久にブロックされてしまう）。
function save(syncToGh=true, isUserEdit=true){
  if(isUserEdit) markLocalEdit();
  try{
    const data = follows.map(f=>({
      ...f,
      posts: (f.posts||[]).map(p=>({
        ...p,
        date: p.date instanceof Date ? p.date.toISOString() : (p.date||null)
      }))
    }));
    localStorage.setItem('fraidycat_follows', JSON.stringify(data));
    // タグ順序もlocalStorageに保存
    localStorage.setItem('fraidycat_tag_order', JSON.stringify(tagOrder));
    // Service Worker（バックグラウンド更新）がチャンネル一覧・設定を参照できるようミラー
    mirrorToChromeStorage({ fraidycat_follows: data, fraidycat_tag_order: tagOrder });
    if(syncToGh) scheduleSaveToGitHub();
  }catch(e){}
}
// 旧頻度ラベルを新ラベルに変換
function migrateFreq(freq){
  if(FREQS.includes(freq)) return freq; // 既に新ラベル
  return FREQ_MIGRATION[freq] || '6時間'; // 不明な値は6時間に
}

// 頻度の表示用ラベル（内部値はそのまま、表示時に「毎」を付ける）
function freqLabel(freq){
  return freq ? freq + '毎' : freq;
}

// 検索用の正規化: 小文字化＋カタカナをひらがなに統一
function normalizeForSearch(str){
  if(!str) return '';
  return str.toLowerCase().replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// ローマ字入力をひらがなに変換する簡易テーブル（検索でアルファベット誤入力時に使用）
const ROMAJI_TABLE = [
  ['kya','きゃ'],['kyu','きゅ'],['kyo','きょ'],
  ['sha','しゃ'],['shu','しゅ'],['sho','しょ'],['sya','しゃ'],['syu','しゅ'],['syo','しょ'],
  ['cha','ちゃ'],['chu','ちゅ'],['cho','ちょ'],['tya','ちゃ'],['tyu','ちゅ'],['tyo','ちょ'],
  ['nya','にゃ'],['nyu','にゅ'],['nyo','にょ'],
  ['hya','ひゃ'],['hyu','ひゅ'],['hyo','ひょ'],
  ['mya','みゃ'],['myu','みゅ'],['myo','みょ'],
  ['rya','りゃ'],['ryu','りゅ'],['ryo','りょ'],
  ['gya','ぎゃ'],['gyu','ぎゅ'],['gyo','ぎょ'],
  ['bya','びゃ'],['byu','びゅ'],['byo','びょ'],
  ['pya','ぴゃ'],['pyu','ぴゅ'],['pyo','ぴょ'],
  ['jya','じゃ'],['jyu','じゅ'],['jyo','じょ'],['zya','じゃ'],['zyu','じゅ'],['zyo','じょ'],
  ['shi','し'],['chi','ち'],['tsu','つ'],
  ['she','しぇ'],['che','ちぇ'],['je','じぇ'],
  ['ka','か'],['ki','き'],['ku','く'],['ke','け'],['ko','こ'],
  ['sa','さ'],['si','し'],['su','す'],['se','せ'],['so','そ'],
  ['ta','た'],['ti','ち'],['tu','つ'],['te','て'],['to','と'],
  ['na','な'],['ni','に'],['nu','ぬ'],['ne','ね'],['no','の'],
  ['ha','は'],['hi','ひ'],['hu','ふ'],['fu','ふ'],['he','へ'],['ho','ほ'],
  ['ma','ま'],['mi','み'],['mu','む'],['me','め'],['mo','も'],
  ['ya','や'],['yu','ゆ'],['yo','よ'],
  ['ra','ら'],['ri','り'],['ru','る'],['re','れ'],['ro','ろ'],
  ['wa','わ'],['wo','を'],
  ['ga','が'],['gi','ぎ'],['gu','ぐ'],['ge','げ'],['go','ご'],
  ['za','ざ'],['zi','じ'],['ji','じ'],['zu','ず'],['ze','ぜ'],['zo','ぞ'],
  ['da','だ'],['di','ぢ'],['du','づ'],['de','で'],['do','ど'],
  ['ba','ば'],['bi','び'],['bu','ぶ'],['be','べ'],['bo','ぼ'],
  ['pa','ぱ'],['pi','ぴ'],['pu','ぷ'],['pe','ぺ'],['po','ぽ'],
  ['ja','じゃ'],['ju','じゅ'],['jo','じょ'],
  ['a','あ'],['i','い'],['u','う'],['e','え'],['o','お'],
].sort((a,b)=>b[0].length - a[0].length);

// ローマ字文字列をひらがなに変換する（IME相当の簡易変換。促音「っ」「ん」に対応）
function romajiToHiragana(str){
  if(!str) return '';
  const s = str.toLowerCase();
  let out = '';
  let i = 0;
  while(i < s.length){
    // 「ん」判定: nの次が母音・y・nのいずれでもない、または文字列末尾
    if(s[i] === 'n' && (i+1 >= s.length || !/[aiueoy]/.test(s[i+1]))){
      out += 'ん';
      i += 1;
      continue;
    }
    // 促音（っ）判定: 同じ子音が連続する場合（nを除く）
    if(i+1 < s.length && s[i] === s[i+1] && /[bcdfghjkmpqrstvwxyz]/.test(s[i]) && s[i] !== 'n'){
      out += 'っ';
      i += 1;
      continue;
    }
    let matched = false;
    for(const [roma, kana] of ROMAJI_TABLE){
      if(s.startsWith(roma, i)){
        out += kana;
        i += roma.length;
        matched = true;
        break;
      }
    }
    if(!matched){
      // ローマ字として解釈できない文字（数字・記号など）はそのまま出力
      out += s[i];
      i += 1;
    }
  }
  return out;
}

function load(){
  try{
    const d = localStorage.getItem('fraidycat_follows');
    if(!d) return;
    const parsed = JSON.parse(d);
    if(!Array.isArray(parsed)) return;
    follows = parsed.map(f=>({
      ...f,
      freq: migrateFreq(f.freq),
      // registeredAt未設定の場合はidをフォールバックとして使用（登録順は維持）
      registeredAt: f.registeredAt || f.id || Date.now(),
      posts: (f.posts||[]).map(p=>({
        ...p,
        // 文字列で保存されたdateをDateオブジェクトに復元
        date: p.date ? new Date(p.date) : null
      })).filter(p => !p.date || !isNaN(p.date.getTime())),
      loading: false,
      error: f.error || null,
    }));
  }catch(e){
    console.warn('load error:', e);
    follows = [];
  }
}

/* ── RSS Fetch ── */
// プロキシごとのクールダウン管理（429を受けたら一定時間スキップ）
/* proxyCooldownUntil / PROXY_COOLDOWN_MS / proxyRotation / humanizeProxyError / lastProxyAttempts / fetchDirect / fetchRSSRaw は fetcher.js に移動 */

/* parseFeedTitle / getEl / parseRSS は parser.js に移動（DOMParser系の共通処理として抽出） */

/* ── Auto-detect feed name from URL ── */
let autoFetchTimer = null;
function showTagSuggestions(val, boxId='tag-suggestions', inputId='f-tags', followId=null){
  const box = document.getElementById(boxId);
  if(!box) return;
  // 最後のタグ（カーソル位置のもの）を取得
  const parts = val.split(/[,、\s\u3000]+/);
  const current = parts[parts.length-1].trim().toLowerCase();
  const allTags = [...new Set(follows.flatMap(f=>f.tags))].sort();
  const matched = allTags.filter(t=>
    t.toLowerCase().includes(current) &&
    !parts.slice(0,-1).map(p=>p.trim()).includes(t) // 既に入力済みは除外
  );
  const renderItems = list => list.map(t=>
    `<div class="tag-suggest-item" data-click="1" data-action="selectTag" data-args="${dargs([t, inputId, boxId, followId])}">${esc(t)}</div>`
  ).join('');
  if(!matched.length || !current){
    // currentが空でも全タグ表示
    const show = current ? matched : allTags;
    if(!show.length){ box.style.display='none'; return; }
    box.innerHTML = renderItems(show);
    box.style.display = 'block';
    return;
  }
  box.innerHTML = renderItems(matched);
  box.style.display = 'block';
}

function hideTagSuggestions(boxId='tag-suggestions'){
  const box = document.getElementById(boxId);
  if(box) box.style.display = 'none';
}

function selectTag(tag, inputId='f-tags', boxId='tag-suggestions', followId=null){
  const input = document.getElementById(inputId);
  if(!input) return;
  const parts = input.value.split(/[,、\s\u3000]+/);
  parts[parts.length-1] = tag;
  input.value = parts.join(', ') + ', ';
  if(followId){
    changeTag(followId, input.value); // フォローカード上：即確定＆保存
  } else {
    formData.tags = input.value; // 「追加」モーダル：フォームの下書きを更新
  }
  input.focus();
  hideTagSuggestions(boxId);
}

async function autoFetchTitle(url){
  if(!url || !url.startsWith('http')) return;
  const nameEl = document.getElementById('f-name');
  const statusEl = document.getElementById('f-url-status');
  if(!nameEl || !statusEl) return;

  // 重複チェック
  const duplicate = follows.find(f => f.url === url);
  if(duplicate){
    statusEl.textContent = `⚠ 「${duplicate.name}」として既に登録されています`;
    statusEl.style.color = 'var(--danger)';
    nameEl.value = duplicate.name;
    formData.name = duplicate.name;
    return;
  }

  if(nameEl.value.trim()) return; // don't overwrite user input

  statusEl.textContent = '取得中...';
  statusEl.style.color = 'var(--text-faint)';
  try{
    const raw = await fetchRSSRaw(url);
    const {feedTitle} = parseRSS(raw);
    if(feedTitle && nameEl && !nameEl.value.trim()){
      nameEl.value = feedTitle;
      formData.name = feedTitle;
      statusEl.textContent = '✓ フィード名を自動取得しました';
      statusEl.style.color = 'var(--accent-mid)';
    } else {
      statusEl.textContent = '';
    }
  }catch(e){
    statusEl.textContent = '名前を手動で入力してください';
    statusEl.style.color = 'var(--text-faint)';
  }
}

function relativeTime(d){
  if(!d || isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff/60000);
  if(m < 1) return 'たった今';
  if(m < 60) return `${m}分前`;
  const h = Math.floor(m/60);
  if(h < 24) return `${h}時間前`;
  const dy = Math.floor(h/24);
  if(dy < 7) return `${dy}日前`;
  if(dy < 30) return `${Math.floor(dy/7)}週間前`;
  if(dy < 365) return `${Math.floor(dy/30)}ヶ月前`;
  return `${Math.floor(dy/365)}年前`;
}

function setStatus(state, msg){
  statusState = state;
  document.getElementById('statusDot').className = 'status-dot' +
    (state==='loading'?' loading':state==='ok'?' ok':state==='err'?' err':state==='warn'?' warn':'');
  document.getElementById('statusText').textContent = msg;
  const hint = document.getElementById('statusHint');
  const bar = document.getElementById('statusbar');
  if(hint){
    hint.textContent = state==='err' ? ' ← クリックで詳細確認' : '';
    hint.style.color = 'var(--accent-mid)';
  }
  if(bar) bar.style.cursor = state==='err' ? 'pointer' : 'default';
}

/* 同時フェッチ数の上限 */
const MAX_CONCURRENT = 2; // 484件対応で同時実行数を削減
let fetchQueue = [];
let activeFetches = 0;

// フェッチ「開始」自体の最小間隔（同時実行数の制限とは別に設ける）。
// 登録チャンネル数が多いと、5分毎チェックのタイミングで大量のチャンネルが
// 一斉に「更新対象」になり、無料のCORSプロキシへ短時間に集中アクセスして
// レート制限（429）を誘発 → 全プロキシが休止中になり後続が芋づる式に失敗する、
// という状態に陥っていた。開始間隔を空けることでこれを防ぐ。
const MIN_FETCH_GAP_MS = 1000;
let lastFetchStartAt = 0;
let drainQueueTimer = null;

function enqueueFetch(f, countable=true){
  if(f.loading) return;
  if(fetchQueue.find(x=>x.id===f.id)) return;
  fetchQueue.push(f);
  if(countable) fetchTotal++;
  drainQueue();
}

function drainQueue(){
  if(drainQueueTimer) return; // 既に待機タイマーがある場合は二重に進めない
  while(activeFetches < MAX_CONCURRENT && fetchQueue.length > 0){
    const now = Date.now();
    const wait = lastFetchStartAt + MIN_FETCH_GAP_MS - now;
    if(wait > 0){
      drainQueueTimer = setTimeout(()=>{ drainQueueTimer = null; drainQueue(); }, wait);
      return;
    }
    const f = fetchQueue.shift();
    lastFetchStartAt = Date.now();
    if(!f.loading) doFetch(f);
  }
}

/* レンダリングのデバウンス（連続呼び出しをまとめる） */
let renderTimer = null;
function debouncedRender(){
  if(renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(()=>{ renderTimer=null; renderOrDefer(); }, 800);
}
// メモ欄などの入力中に更新処理の再描画が割り込むと、入力欄ごとDOMが
// 差し替わってしまい、文字が入力できない・入力中の内容が消えるという
// 問題が起きる。入力欄にフォーカスがある間は再描画を保留し、
// フォーカスが外れた（＝入力確定した）タイミングで改めて描画する。
function renderOrDefer(){
  const ae = document.activeElement;
  if(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && document.body.contains(ae)){
    if(!ae.dataset.pendingRerender){
      ae.dataset.pendingRerender = '1';
      ae.addEventListener('blur', function onBlur(){
        ae.removeEventListener('blur', onBlur);
        delete ae.dataset.pendingRerender;
        render();
      }, {once:true});
    }
    return;
  }
  render();
}

async function doFetch(f){
  f.loading = true;
  activeFetches++;
  loadingCount++;
  currentFetchingName = f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name;
  updateFetchStatus();

  // 直前までエラー状態だったかどうかを覚えておく。
  // エラー後に取得が成功した場合、単に静かにエラーが消えるだけだと
  // 「結局登録できているのかどうか」が分かりづらいため、回復した旨を
  // 通知する（「エラーが出た＝登録できていない」と思い込んでしまうのを防ぐ）。
  const hadError = !!f.error;

  const fetchStartAt = Date.now();
  try{
    const raw = await fetchRSSRaw(f.url);
    const {feedTitle, posts} = parseRSS(raw);
    // 久しぶり更新の検出: 取得前の最新動画リンクを控える
    const prevPosts = f.posts || [];
    const prevLatestLink = prevPosts[0] ? prevPosts[0].link : null;
    // 取得・パース自体は成功したが記事が0件だった場合、そのまま上書きすると
    // プロキシ側の一時的な不具合（空レスポンス等）で既存の投稿一覧が消えてしまう。
    // 直前まで投稿があったのに今回だけ0件、というのは「動画が全部消えた」より
    // 「取得が一時的に不完全だった」可能性の方がはるかに高いため、その場合は
    // 既存のposts一覧を保持し、取得時刻・エラー状態のみ更新する。
    const emptyButHadPosts = posts.length === 0 && prevPosts.length > 0;
    if(!emptyButHadPosts) f.posts = posts;
    f.lastFetched = Date.now();
    f.error = null;
    if(hadError){
      const shortName = f.name.length > 16 ? f.name.slice(0, 16) + '…' : f.name;
      showToast(`✓ ${shortName} の取得が回復しました（登録できています）`, 4000);
    }
    if(feedTitle && f.name === f.url) f.name = feedTitle;
    // 新着があり、かつ最新動画とその前の動画の間隔が設定日数以上なら「久しぶり更新」
    try{
      if(posts.length && posts[0].link !== prevLatestLink && prevLatestLink !== null){
        const d0 = posts[0].date ? new Date(posts[0].date) : null;
        const d1 = posts[1] && posts[1].date ? new Date(posts[1].date) : null;
        if(d0 && d1 && !isNaN(d0) && !isNaN(d1)){
          const gapDays = (d0 - d1) / (24*60*60*1000);
          if(gapDays >= revivalThresholdDays){
            markRevival(f, Math.round(gapDays), posts[0]);
          }
        }
      }
    }catch(e){}
    addFetchLog(emptyButHadPosts
      ? {id:f.id, name:f.name, ok:false, proxy:lastUsedProxy, error:`0件のため既存の${prevPosts.length}件を保持`, ms:Date.now()-fetchStartAt, attempts:lastProxyAttempts.slice()}
      : {id:f.id, name:f.name, ok:true, proxy:lastUsedProxy, count:posts.length, ms:Date.now()-fetchStartAt, attempts:lastProxyAttempts.slice(), latestPub:(posts[0]&&posts[0].date)?new Date(posts[0].date).getTime():null, subs:f.subscriberCount!=null?f.subscriberCount:null});
  }catch(e){
    f.error = `取得エラー: ${e.message}`;
    f.posts = f.posts || [];
    const shortName = f.name.length > 16 ? f.name.slice(0, 16) + '…' : f.name;
    showToast(`⚠ ${shortName} の取得に失敗`, 4000);
    addFetchLog({id:f.id, name:f.name, ok:false, proxy:lastUsedProxy, error:e.message, ms:Date.now()-fetchStartAt, attempts:lastProxyAttempts.slice()});
  }finally{
    f.loading = false;
    activeFetches = Math.max(0, activeFetches - 1);
    loadingCount = Math.max(0, loadingCount - 1);
    fetchDone = Math.min(fetchTotal, fetchDone + 1);
    updateFetchStatus();
    save(true, false); // 自動取得結果の保存。ユーザー編集ではないのでGitHub読み込みガードは更新しない
    debouncedRender();
    drainQueue();
    // APIキーがあれば動画時間を自動取得
    if(ytApiKey) fetchDurationsForFollow(f);
    // アイコン未取得なら自動取得
    if(ytApiKey && !f.iconUrl) fetchIconForFollow(f);
  }
}

async function fetchFollow(f){
  enqueueFetch(f);
}

// チャンネルIDから決定的な0〜1の疑似ランダム値を作る（毎回同じチャンネルは同じ値になる）
function jitterRatio(id){
  let h = 0;
  const s = String(id);
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) >>> 0; }
  return (h % 10000) / 10000;
}

function shouldRefetch(f){
  if(f.suspended) return false;
  const interval = FREQ_INTERVAL[f.freq];
  if(interval == null) return false; // 手動は自動更新しない
  if(!f.lastFetched) return true;
  // 同じ更新頻度のチャンネルが全て同じタイミングで一斉に「更新対象」になると、
  // プロキシへのアクセスが集中しやすい。チャンネルごとに固定の位相（±15%）を
  // 持たせることで、次にいつ対象になるかを平均化・分散させる。
  // （IDベースの決定的な値なので、リロードしても同じチャンネルは常に同じ位相になる）
  const jitter = (jitterRatio(f.id) * 0.3 - 0.15) * interval; // -15%〜+15%
  return Date.now() - f.lastFetched > interval + jitter;
}

async function refreshAll(){
  document.querySelectorAll('.hdr-btn.refresh, .bnav-btn, .drawer-btn').forEach(btn=>{
    if(/更新/.test(btn.textContent)){
      btn.classList.add('refresh-flash');
      setTimeout(()=>btn.classList.remove('refresh-flash'), 600);
    }
  });
  showToast('更新を開始しました');
  const targets = follows.filter(f=>!f.suspended);
  fetchTotal = targets.length;
  fetchDone = 0;
  setStatus('loading', `更新中 0/${fetchTotal}（0%）`);
  targets.forEach(f=>{
    if(f.loading) return;
    if(fetchQueue.find(x=>x.id===f.id)) return;
    fetchQueue.push(f);
  });
  drainQueue();
}

let toastTimer = null;
function showToast(msg, duration){
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), duration || 1800);
}

// ── 久しぶり更新（長期休眠からの復活）──
let revivals = [];
let revivalHistory = [];
try{ const s=localStorage.getItem('fraidycat_revival_history'); if(s) revivalHistory=JSON.parse(s)||[]; }catch(e){ revivalHistory=[]; }
const REVIVAL_HISTORY_MAX = 200;
function markRevival(f, gapDays, post){
  // 他端末で既に検知・通知済み（GitHub同期で取り込んだ履歴に含まれる）なら、
  // このチャンネルの久しぶり検知については二重に通知しない
  if(revivalHistory.some(r=>r.link === post.link)) return;
  revivals = revivals.filter(r=>r.id !== f.id);
  revivals.unshift({id:f.id, name:f.name, gapDays, title:post.title, link:post.link, at:Date.now()});
  if(revivals.length > 30) revivals = revivals.slice(0,30);
  renderRevivalPanel();
  if(!revivalHistory.some(r=>r.link === post.link)){
    revivalHistory.unshift({id:f.id, name:f.name, gapDays, title:post.title, link:post.link, at:Date.now()});
    if(revivalHistory.length > REVIVAL_HISTORY_MAX) revivalHistory = revivalHistory.slice(0, REVIVAL_HISTORY_MAX);
    try{ localStorage.setItem('fraidycat_revival_history', JSON.stringify(revivalHistory)); mirrorToChromeStorage({ fraidycat_revival_history: revivalHistory }); }catch(e){}
  }
}

function dismissRevival(id){
  revivals = revivals.filter(r=>r.id !== id);
  renderRevivalPanel();
}
function dismissAllRevivals(){
  revivals = [];
  renderRevivalPanel();
}

// 久しぶり更新の履歴モーダル
function openRevivalHistory(){
  let m = document.getElementById('revivalHistModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'revivalHistModal';
    m.className = 'modal-backdrop';
    m.onclick = (e)=>{ if(e.target===m) m.style.display='none'; };
    m.innerHTML = `<div class="modal" style="max-width:640px;width:92%;max-height:84vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h2 style="margin:0">🎉 久しぶり更新の履歴</h2>
        <span id="revivalHistTip" title="${revivalTooltipText()}" style="cursor:help;color:var(--text-faint);font-size:13px;border:1px solid var(--border-strong);border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">?</span>
        <div style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted)">
          <input type="number" id="revivalThresholdInput" min="1" max="365" value="${revivalThresholdDays}" style="width:52px;padding:2px 4px;border:1px solid var(--border-strong);border-radius:4px;background:var(--bg);color:var(--text);font-size:12px" data-change="1" data-action="setRevivalThreshold" data-args='["@value"]'>
          <span>日以上で「久しぶり」</span>
        </div>
        <button class="btn-cancel" style="margin-left:auto" data-click="1" data-action="clearRevivalHistory">クリア</button>
        <button class="btn-cancel" data-click="1" data-action="closeRevivalHistModal">閉じる</button>
      </div>
      <div id="revivalHistBody" style="overflow-y:auto;flex:1;border-top:1px solid var(--border)"></div>
    </div>`;
    document.body.appendChild(m);
    // 背景クリックで閉じる処理はm.onclickの e.target===m 判定だけで十分
    // （中の要素をクリックした場合、targetは常にmではないため誤って閉じることはない）。
    // ここで.modalにstopPropagationを付けると、data-click委任リスナー（document側で
    // 拾う仕組み）までイベントが届かなくなり、モーダル内の全ボタンが反応しなくなる
    // 不具合になるため、あえて付けない。
  }
  m.style.display = 'flex';
  renderRevivalHistory();
}
function closeRevivalHistModal(){
  const m = document.getElementById('revivalHistModal');
  if(m) m.style.display = 'none';
}
function revivalTooltipText(){
  return `新着動画を検知した際、その投稿と直前の投稿の間隔が${revivalThresholdDays}日以上あいていた場合に表示されます`;
}
function setRevivalThreshold(v){
  const n = parseInt(v, 10);
  const input = document.getElementById('revivalThresholdInput');
  if(!n || n < 1){
    showToast('1以上の数値を入力してください', 2500);
    if(input) input.value = revivalThresholdDays;
    return;
  }
  revivalThresholdDays = n;
  try{ localStorage.setItem('fraidycat_revival_threshold_days', String(n)); mirrorToChromeStorage({ fraidycat_revival_threshold_days: n }); }catch(e){}
  if(input) input.value = n;
  const tip = document.getElementById('revivalHistTip');
  if(tip) tip.title = revivalTooltipText();
  const panelTip = document.getElementById('revivalPanelTip');
  if(panelTip) panelTip.title = revivalTooltipText();
  showToast(`「久しぶり」の判定を${n}日以上に変更しました`, 2500);
}
function clearRevivalHistory(){
  revivalHistory = [];
  try{ localStorage.removeItem('fraidycat_revival_history'); mirrorToChromeStorage({ fraidycat_revival_history: [] }); }catch(e){}
  renderRevivalHistory();
}
function renderRevivalHistory(){
  const body = document.getElementById('revivalHistBody');
  if(!body) return;
  if(!revivalHistory.length){
    body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px">履歴がありません</div>`;
    return;
  }
  body.innerHTML = revivalHistory.map(r=>{
    const t = new Date(r.at);
    const date = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid var(--border);font-size:12px">
      <span class="rv-badge" style="flex-shrink:0">${r.gapDays}日ぶり</span>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden">
        <span data-click="1" data-action="openFollowPanel" data-args="[${r.id}]" title="fraidycatでこのチャンネルを開く" style="cursor:pointer;text-decoration:underline dotted;width:fit-content;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</span>
        <a href="${esc(r.link)}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.title||'')}</a>
      </div>
      <span style="color:var(--text-faint);flex-shrink:0;font-family:'DM Mono',monospace">${date}</span>
    </div>`;
  }).join('');
}

function renderRevivalPanel(){
  let panel = document.getElementById('revivalPanel');
  if(!revivals.length){
    if(panel) panel.style.display = 'none';
    return;
  }
  if(!panel){
    panel = document.createElement('div');
    panel.id = 'revivalPanel';
    document.body.appendChild(panel);
  }
  panel.style.display = 'block';
  const items = revivals.map(r=>{
    const safeName = esc(r.name);
    const safeTitle = esc(r.title||'');
    return `<div class="rv-item">
      <span class="rv-badge">${r.gapDays}日ぶり</span>
      <div class="rv-link" style="display:flex;flex-direction:column;overflow:hidden">
        <span class="rv-name" data-click="1" data-action="openFollowPanel" data-args="[${r.id}]" title="fraidycatでこのチャンネルを開く" style="cursor:pointer;text-decoration:underline dotted;width:fit-content">${safeName}</span>
        <a class="rv-title" href="${esc(r.link)}" target="_blank" rel="noopener" title="${safeTitle}" style="text-decoration:none;color:inherit">${safeTitle}</a>
      </div>
      <button class="rv-x" data-click="1" data-action="dismissRevival" data-args="[${r.id}]" title="消す">✕</button>
    </div>`;
  }).join('');
  panel.innerHTML = `<div class="rv-head">
      <span class="rv-title-main">🎉 久しぶりに更新されたチャンネル（${revivals.length}）</span>
      <span id="revivalPanelTip" title="${revivalTooltipText()}" style="cursor:help;color:var(--text-faint);font-size:12px;border:1px solid var(--border-strong);border-radius:50%;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">?</span>
      <button class="rv-clear" data-click="1" data-action="openRevivalHistory">履歴</button>
      <button class="rv-clear" data-click="1" data-action="dismissAllRevivals">すべて消す</button>
    </div>
    <div class="rv-list">${items}</div>`;
}

// ── ログ画面 ──
let logFilter = 'all'; // all / ok / fail
let logIdFilter = null;   // 特定チャンネルのidで絞り込む場合に使用
let logNameFilter = null; // idが無い古いログ用に名前でも絞り込めるようにする
function openLogModal(f){
  logFilter = 'all';
  if(f){
    logIdFilter = f.id;
    logNameFilter = f.name;
  } else {
    logIdFilter = null;
    logNameFilter = null;
  }
  let m = document.getElementById('logModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'logModal';
    m.className = 'modal-backdrop';
    m.onclick = (e)=>{ if(e.target===m) closeLogModal(); };
    m.innerHTML = `<div class="modal" style="max-width:720px;width:92%;max-height:84vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h2 style="margin:0">取得ログ</h2>
        <div id="logFilterBtns" style="display:flex;gap:4px;margin-left:8px"></div>
        <div id="logChannelFilter"></div>
        <button class="btn-cancel" style="margin-left:auto" data-click="1" data-action="exportFetchLog">エクスポート</button>
        <button class="btn-cancel" data-click="1" data-action="clearFetchLog">クリア</button>
        <button class="btn-cancel" data-click="1" data-action="closeLogModal">閉じる</button>
      </div>
      <div id="logStats" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.7"></div>
      <div id="logModalBody" style="overflow-y:auto;flex:1;border-top:1px solid var(--border)"></div>
    </div>`;
    document.body.appendChild(m);
    // 背景クリックで閉じる処理はm.onclickの e.target===m 判定だけで十分
    // （中の要素をクリックした場合、targetは常にmではないため誤って閉じることはない）。
    // ここで.modalにstopPropagationを付けると、data-click委任リスナー（document側で
    // 拾う仕組み）までイベントが届かなくなり、モーダル内の全ボタンが反応しなくなる
    // 不具合になるため、あえて付けない。
  }
  m.style.display = 'flex';
  renderLogModal();
}
function closeLogModal(){
  const m = document.getElementById('logModal');
  if(m) m.style.display = 'none';
}
function setLogFilter(f){ logFilter = f; renderLogModal(); }

function clearLogChannelFilter(){
  logIdFilter = null;
  logNameFilter = null;
  renderLogModal();
}

function renderLogModal(){
  const body = document.getElementById('logModalBody');
  if(!body) return;
  // チャンネル絞り込みが指定されていれば対象を限定する
  // （idが記録されている新しいログはidで、無い古いログは名前で照合する）
  const scoped = (logIdFilter != null || logNameFilter)
    ? fetchLog.filter(l => (l.id != null && logIdFilter != null) ? l.id === logIdFilter : l.name === logNameFilter)
    : fetchLog;

  // チャンネル絞り込みチップの表示
  const chipEl = document.getElementById('logChannelFilter');
  if(chipEl){
    chipEl.innerHTML = logNameFilter
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:99px;background:var(--accent-light);color:var(--accent-mid);border:1px solid var(--accent-mid)">
          ${esc(logNameFilter)}
          <button data-click="1" data-action="clearLogChannelFilter" title="絞り込みを解除" style="border:none;background:none;cursor:pointer;color:inherit;font-size:12px;line-height:1;padding:0">✕</button>
        </span>`
      : '';
  }

  // 集計（チャンネル絞り込み中はその範囲のみで集計する）
  const total = scoped.length;
  const okCount = scoped.filter(l=>l.ok).length;
  const failCount = total - okCount;
  const rate = total ? Math.round(okCount/total*100) : 0;
  // プロキシ別集計
  const byProxy = {};
  scoped.forEach(l=>{
    const p = l.proxy || '(不明)';
    if(!byProxy[p]) byProxy[p] = {ok:0, fail:0};
    if(l.ok) byProxy[p].ok++; else byProxy[p].fail++;
  });
  const proxyStat = Object.entries(byProxy).map(([p,s])=>{
    const t = s.ok+s.fail; const r = t?Math.round(s.ok/t*100):0;
    return `${p}: ${s.ok}/${t}（${r}%）`;
  }).join(' ／ ');
  let freq5Warn = '';
  try{
    const five = follows.filter(f=>f.freq==='5分' && !f.suspended && f.lastFetched);
    if(five.length){
      const now = Date.now();
      // 長時間（30分以上）更新できていないチャンネルが1件でも混ざると、
      // 「一周にかかった時間」が実態とかけ離れた値（例: 700分超）になって
      // しまう。そうした停滞チャンネルは一周の計算から除外し、件数だけ
      // 別枠で警告する。
      const STUCK_MS = 30*60*1000;
      const healthy = five.filter(f => now - f.lastFetched < STUCK_MS);
      const stuckCount = five.length - healthy.length;
      const notYet = follows.filter(f=>f.freq==='5分' && !f.suspended && !f.lastFetched).length;
      const stuckNote = stuckCount
        ? `<br><span style="color:#D33;font-weight:500">⚠ ${stuckCount}件が30分以上未更新（プロキシ失敗等で停滞している可能性）</span>`
        : '';
      if(healthy.length){
        const times = healthy.map(f=>f.lastFetched);
        const rawSpan = Math.max(...times) - Math.min(...times);
        // タブが非アクティブだった時間はブラウザ側で取得処理自体が間引かれるため、
        // 純粋な「一周にかかった時間」からは除いて計算する（そうしないとタブの
        // アクティブ／非アクティブだけで数値が大きくぶれ、参考にしづらいため）。
        const hidden = hiddenMsWithin(Math.min(...times), Math.max(...times));
        const span = Math.max(0, rawSpan - hidden);
        const spanMin = Math.floor(span/60000), spanSec = Math.round((span%60000)/1000);
        const spanStr = spanMin>0 ? `${spanMin}分${spanSec}秒` : `${spanSec}秒`;
        const hiddenNote = hidden >= 5000 ? `（非アクティブ${Math.round(hidden/60000)}分を除く）` : '';
        const over = span > 5*60*1000;
        const color = over ? '#D33' : '#0A8';
        const mark = over ? '⚠' : '✓';
        freq5Warn = `<br><span style="color:${color};font-weight:500">${mark} 5分毎チャンネル: ${five.length}件 / 一周 約${spanStr}${hiddenNote}${over?'（5分超過：限界が近い、または超えています）':'（5分以内：余裕あり）'}</span>`
          + (notYet ? `<span style="color:var(--text-faint)">（未取得 ${notYet}件）</span>` : '')
          + stuckNote;
      } else {
        // 健全なチャンネルが1件もない（全て停滞中）場合
        freq5Warn = `<br><span style="color:#D33;font-weight:500">⚠ 5分毎チャンネル: ${five.length}件（すべて30分以上未更新）</span>`
          + (notYet ? `<span style="color:var(--text-faint)">（未取得 ${notYet}件）</span>` : '');
      }
    }
  }catch(e){}

  const stats = document.getElementById('logStats');
  if(stats){
    stats.innerHTML = `合計 ${total}件 ｜ 成功 ${okCount} ／ 失敗 ${failCount} ｜ 成功率 ${rate}%`
      + (proxyStat ? `<br>プロキシ別: ${proxyStat}` : '')
      + freq5Warn;
  }
  // フィルターボタン
  const fb = document.getElementById('logFilterBtns');
  if(fb){
    const mk = (key,label)=>`<button data-click="1" data-action="setLogFilter" data-args='["${key}"]' style="font-size:11px;padding:3px 10px;border-radius:99px;border:1px solid var(--border-strong);cursor:pointer;background:${logFilter===key?'var(--accent-mid)':'var(--surface)'};color:${logFilter===key?'#fff':'var(--text)'}">${label}</button>`;
    fb.innerHTML = mk('all','すべて')+mk('ok','成功')+mk('fail','失敗');
  }
  // 一覧
  let list = scoped;
  if(logFilter==='ok') list = scoped.filter(l=>l.ok);
  else if(logFilter==='fail') list = scoped.filter(l=>!l.ok);
  if(!list.length){
    body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px">ログがありません</div>`;
    return;
  }
  const logHeader = `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:2px solid var(--border-strong);position:sticky;top:0;background:var(--surface);z-index:1">
      <span style="width:14px;flex-shrink:0"></span>
      <span style="flex-shrink:0">日時</span>
      <span style="flex:1;min-width:0">チャンネル</span>
      <span style="flex-shrink:0">プロキシ</span>
      <span style="flex-shrink:0">時間</span>
      <span style="flex-shrink:0;max-width:40%">動画数</span>
    </div>`;
  body.innerHTML = logHeader + list.map(l=>{
    const t = new Date(l.at);
    const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    const date = `${t.getMonth()+1}/${t.getDate()}`;
    const icon = l.ok ? '✓' : '✕';
    const color = l.ok ? '#0A8' : '#D33';
    const detail = l.ok ? `${l.count}件` : `${esc(l.error||"失敗")}`;
    const via = l.proxy ? `<span style="color:var(--text-faint)">via ${esc(l.proxy)}</span>` : '';
    const ms = l.ms != null ? `<span style="color:var(--text-faint)">${l.ms}ms</span>` : '';
    let attemptsRow = '';
    if(Array.isArray(l.attempts) && l.attempts.length > 1){
      const parts = l.attempts.map(a=>{
        const c = a.ok ? '#0A8' : '#C66';
        return `<span style="color:${c}">${esc(a.proxy)}${a.ok?'✓':'：'+esc(a.reason||'失敗')}</span>`;
      }).join('<span style="color:var(--text-faint)"> → </span>');
      attemptsRow = `<div style="padding:0 8px 6px 36px;font-size:11px;border-bottom:1px solid var(--border);background:rgba(0,0,0,0.015)">${parts}</div>`;
    }
    // ログの対象チャンネルを特定（idがあればidで、無ければ名前で）
    const targetFollow = (l.id != null && follows.find(x=>x.id===l.id)) || follows.find(x=>x.name===l.name);
    const suspendBtn = (!l.ok && targetFollow)
      ? (targetFollow.suspended
          ? `<span style="flex-shrink:0;font-size:11px;color:var(--text-faint)">対象外済み</span>`
          : `<button data-click="1" data-action="suspendFromLog" data-args="[${targetFollow.id}]" style="flex-shrink:0;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--danger);color:var(--danger);background:none;cursor:pointer">対象外にする</button>`)
      : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;${attemptsRow?'':'border-bottom:1px solid var(--border);'}font-size:12px">
      <span style="color:${color};font-weight:bold;width:14px;flex-shrink:0">${icon}</span>
      <span style="color:var(--text-faint);font-family:'DM Mono',monospace;flex-shrink:0">${date} ${time}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${targetFollow?'cursor:pointer;color:var(--accent-mid);text-decoration:underline dotted':''}"
        ${targetFollow?`data-click="1" data-action="openFollowPanel" data-args="[${targetFollow.id}]" title="このチャンネルの設定を開く"`:''}
      >${esc(l.name||'')}</span>
      ${via} ${ms}
      <span style="color:${l.ok?'var(--text-muted)':color};flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${detail}</span>
      ${suspendBtn}
    </div>${attemptsRow}`;
  }).join('');
}

// ログ画面からチャンネル名をクリックして、そのチャンネルの設定（展開パネル）を開く
function openFollowPanel(id){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  closeLogModal();
  const rvHistModal = document.getElementById('revivalHistModal');
  if(rvHistModal) rvHistModal.style.display = 'none';
  // タイムライン系の表示（新着順・長い順・短い順）ではチャンネルごとの展開パネルが
  // そもそも存在しないため、先に「チャンネル順」表示へ切り替える。
  if(!['freq','registered-desc','registered-asc','subscribers-desc','fetched-desc','fetched-asc'].includes(sortMode)){
    sortMode = 'freq';
  }
  // タグ・検索の絞り込みで対象チャンネルが表示から除外されていないか確認する
  activeTag = 'すべて';
  activeFreq = null;
  if(searchQuery){
    searchQuery = '';
    const input = document.getElementById('searchInput');
    if(input) input.value = '';
    const clr = document.getElementById('searchClear');
    if(clr) clr.style.display = 'none';
  }
  // 先に展開状態にしてから描画する（toggleExpand経由だと仮想スクロールが
  // ページ0にリセットされてしまい、後段の追加ページ読み込みと競合するため使わない）
  expanded = f.id;
  renderSidebar();
  renderMain();
  renderTags();
  updateSortBtn();

  // 一覧は仮想スクロールで最初の30件しか描画されない。対象チャンネルがそれより
  // 後ろの順位にある場合、カード自体がまだDOMに存在しないので、
  // 含まれるページまで強制的に追加読み込みしてから表示・スクロールする。
  const idx = currentFiltered.findIndex(x=>x.id===f.id);
  if(idx >= 0){
    const targetPage = Math.floor(idx / PAGE_SIZE);
    let guard = 0;
    while(currentPage <= targetPage && currentPage * PAGE_SIZE < currentFiltered.length && guard < 500){
      renderChannelList(currentFiltered, true);
      guard++;
    }
  }

  const card = document.getElementById(`fc-${f.id}`);
  if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
}

// ログ画面から、エラーになったチャンネルを直接「更新対象外」にする
function suspendFromLog(id){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  f.suspended = true;
  save();
  renderLogModal();
  render();
  setStatus('ok', `「${f.name}」を更新対象外にしました`);
}

/* ── Render ── */
function allTags(){
  const t = new Set();
  follows.forEach(f=>f.tags.forEach(x=>t.add(x)));
  return ['すべて', ...t];
}

function colorOf(f){return COLORS[f.colorIdx % COLORS.length]}
function isDark(){return false;}

function renderFollowCard(f){
  const isExp = expanded === f.id;
  const c = colorOf(f);
  const bg = isDark() ? c.dark_bg : c.bg;
  const fg = isDark() ? c.dark_fg : c.fg;
  const latestPost = f.posts?.[0];
  const snippet = latestPost ? latestPost.title : (f.error ? '⚠ エラー' : '記事なし');
  const pillClass = FREQ_PILL[f.freq] || '';
  const agoText = f.lastFetched ? relativeTime(new Date(f.lastFetched)) : '未取得';
  const regDateText = f.registeredAt ? (()=>{ const d=new Date(f.registeredAt); return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; })() : '';

  // 頻度セレクター＋タグ編集（展開時に表示）
  const freqSelector = `
    <div class="fc-freq-row">
      <span class="fc-freq-label">更新頻度：</span>
      <div class="fc-freq-btns">
        ${FREQS.map(fr=>`<button class="fc-freq-btn${f.freq===fr?' active':''}"
          data-click="1" data-action="changeFreq" data-args="${dargs([f.id, fr])}">${freqLabel(fr)}</button>`).join('')}
      </div>
      <button class="fc-refresh-btn" data-click="1" data-action="enqueueFetchById" data-args="[${f.id}]">↻ 今すぐ更新</button>
      <button class="fc-refresh-btn" data-click="1" data-action="openLogModalById" data-args="[${f.id}]" title="このチャンネルの取得ログだけを表示">📋 取得ログ</button>
      ${f.suspended ? `<button class="fc-refresh-btn" style="color:var(--accent-mid);border-color:var(--accent-mid)" data-click="1" data-action="toggleSuspend" data-args="[${f.id}]">▶ 更新を再開</button>` : `<button class="fc-refresh-btn" style="color:var(--text-faint)" data-click="1" data-action="toggleSuspend" data-args="[${f.id}]">⏸ 更新外にする</button>`}
      <span class="fc-url-inline" id="url-text-${f.id}" title="${esc(f.url)}">${esc(f.url)}</span>
      <input class="fc-tag-input fc-url-inline" id="url-input-${f.id}"
        value="${esc(f.url)}"
        title="RSSフィードのURLを編集できます"
        data-blur="1" data-action="commitUrlEdit" data-args="${dargs([f.id, '@value'])}"
        data-enter-blur="1"
        style="display:none;flex:1;min-width:200px">
      <button class="fc-copy-btn" data-click="1" data-action="editUrlInline" data-args="[${f.id}]" title="URLを編集" style="color:var(--accent-mid)">✏️</button>
    </div>
    <div class="fc-tag-row">
      <span class="fc-freq-label">チャンネル名：</span>
      <input class="fc-tag-input" id="name-input-${f.id}"
        value="${esc(f.name)}"
        placeholder="チャンネル名"
        title="チャンネル名を編集できます"
        data-blur="1" data-action="changeName" data-args="${dargs([f.id, '@value'])}"
        data-enter-blur="1"
        style="max-width:180px">
      <span class="fc-freq-label" title="カンマ・スペース・全角スペースで区切って複数入力できます" style="cursor:help;text-decoration:underline dotted;margin-left:4px">タグ：</span>
      <input class="fc-tag-input" id="tag-input-${f.id}"
        value="${esc(f.tags.join(', '))}"
        placeholder="例: キャンプ tech（スペース・カンマ区切り）"
        title="カンマ・半角スペース・全角スペースで区切って複数入力できます"
        autocomplete="off"
        data-input="1" data-action="showTagSuggestions" data-args="${dargs(['@value', `tag-suggestions-${f.id}`, `tag-input-${f.id}`, f.id])}"
        data-focus="1" data-action-focus="showTagSuggestions" data-args-focus="${dargs(['@value', `tag-suggestions-${f.id}`, `tag-input-${f.id}`, f.id])}"
        data-blur="1" data-action-blur="handleCardTagBlur" data-args-blur="${dargs([f.id, '@value'])}"
        data-enter-blur="1">
      <div id="tag-suggestions-${f.id}" class="fc-tag-suggestions" style="display:none"></div>
    </div>
    <div class="fc-tag-row">
      <span class="fc-freq-label">メモ：</span>
      <input class="fc-tag-input" id="memo-input-${f.id}"
        value="${esc(f.memo||'')}"
        placeholder="メモや備考..."
        data-blur="1" data-action="changeMemo" data-args="${dargs([f.id, '@value'])}"
        data-enter-blur="1">
    </div>
    <div class="fc-tag-row">
      <span class="fc-freq-label">アイコン：</span>
      ${f.iconUrl ? `<img src="${esc(iconSrc(f))}" style="width:20px;height:20px;border-radius:4px;object-fit:cover;flex-shrink:0" data-error-action="hideSelf">` : ''}
      <input class="fc-tag-input" id="icon-input-${f.id}"
        value="${esc(f.iconUrl||'')}"
        placeholder="画像URLを入力（YouTube以外は自動取得されないため手動で設定できます）"
        title="アイコン画像のURLを設定できます"
        data-blur="1" data-action="changeIcon" data-args="${dargs([f.id, '@value'])}"
        data-enter-blur="1">
    </div>`;

  const markColor = f.markColor && MARK_COLORS[f.markColor] ? MARK_COLORS[f.markColor] : null;
  const markBg = markColor ? (isDark() ? markColor.darkBg : markColor.bg) : '';
  // マーク色が付いていないカードは、YouTube以外（RSS/ブログ・Podcast等）を
  // 背景色でひと目で区別できるようにする（マーク色が優先される）。
  // f.platformはURL編集時に追従しないことがあり古くなりうるため、
  // 実際のURLから直接YouTubeかどうかを判定する（fetcher.js等と同じ判定方法）
  const isYoutubeUrl = /youtube\.com|youtu\.be/i.test(f.url || '');
  const nonYoutubeClass = (!markBg && !isYoutubeUrl) ? ' non-youtube' : '';
  return `
  <div class="follow-card${isExp?' expanded':''}${f.suspended?' suspended':''}${nonYoutubeClass}" id="fc-${f.id}"
    style="${markBg?`background:${markBg};`:''}cursor:pointer">
    <div class="fc-row">
      <!-- PCではfc-previewにアイコンを表示、スマホではここに表示 -->
      <div class="fc-avatar-mobile-wrap" style="display:none;flex-direction:column;align-items:center;gap:1px;flex-shrink:0">
        <div class="fc-avatar-mobile fc-avatar" data-mark="${f.markColor||''}" style="background:${bg};color:${fg}">
          ${f.iconUrl ? `<img src="${esc(iconSrc(f))}" alt="${esc(f.initials)}" data-error-action="hideSelf">` : ''}
          ${f.initials}
        </div>
        ${fmtSubscribers(f.subscriberCount)?`<span class="fc-sub-count">${fmtSubscribers(f.subscriberCount)}</span>`:''}
      </div>
      <div class="fc-body">
        <div class="fc-top">
          ${(() => {
            const chId = ytChannelIdFromUrl(f.url);
            const plId = f.url.match(/playlist_id=([A-Za-z0-9_-]+)/)?.[1];
            const chUrl = chId
              ? `https://www.youtube.com/channel/${chId}`
              : plId
              ? `https://www.youtube.com/playlist?list=${plId}`
              : null;
            return chUrl
              ? `<a class="fc-name" href="${esc(chUrl)}" target="_blank" rel="noopener" title="${chId?'YouTubeチャンネルを開く':'YouTubeプレイリストを開く'}">${esc(f.name)}</a>`
              : `<span class="fc-name">${esc(f.name)}</span>`;
          })()}
          ${f.suspended ? `<span class="fc-tag" style="background:#E8E8E8;color:#888;border:1px solid #ccc">更新外</span>` : ''}
          ${f.tags.map(t=>`<span class="fc-tag" data-click="1" data-action="setTag" data-args="${dargs([t])}" title="このタグで絞り込む" style="cursor:pointer">${esc(t)}</span>`).join('')}
          ${f.memo ? `<span class="fc-memo-inline">📝 <span>${linkifyMemo(f.memo)}</span></span>` : ''}
          ${f.loading ? '<div class="fc-spinner"></div>' : ''}
          ${f.suspended ? '' : `<span class="freq-pill ${pillClass}">${freqLabel(f.freq)}</span>`}
          ${f.fetchTimes && f.fetchTimes.length>0 ? `<span class="sched-pill" title="個別指定: ${esc(f.fetchTimes)}">個別指定</span>` : ''}
          <span class="fc-ago" title="最終確認時刻">${f.lastFetched ? agoText+'取得' : agoText}</span>
          <button class="fc-fav-btn" data-mark="${f.markColor||''}" data-click="1" data-action="openMarkPopup" data-args="${dargs([f.id, '@el'])}" title="マーク色を設定">${f.markColor?'★':'☆'}</button>
          <button class="fc-cal-btn" data-click="1" data-action="toggleRegDateInput" data-args="[${f.id}]" title="登録日">📅</button>
          ${regDateText ? `<span class="fc-regdate-inline" title="登録日">${regDateText}登録</span>` : ''}
          <button class="fc-del" data-click="1" data-action="delFollow" data-args="[${f.id}]" title="削除">✕</button>
        </div>
      </div>
    </div>
    ${(f.posts||[]).length > 0 ? `
    <div class="fc-preview" style="padding:0 8px 2px">
      ${(f.posts||[]).slice(0,3).map((p, pi)=>{
        const dur = fmtDuration(p.duration);
        const isShort = p.link && p.link.includes('/shorts/');
        const liveBadge = getLiveBadge(p);
        const durText = liveBadge ? liveBadge.text : isShort ? `<span class="fc-short-label">[ショート]</span>${dur?' '+dur:''}` : dur;
        const durAttr = liveBadge ? liveBadge.attr : isShort ? ' data-short="true"' : '';
        const dateStr = fmtDatetime(p.date);
        const ytVid = p.link?.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1]
          || p.link?.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/)?.[1];
        const twPc = pi===0 ? 60 : 30; const thPc = pi===0 ? 34 : 17;
        const thumbHtml = ytVid
          ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" style="flex-shrink:0">
              <img src="https://i.ytimg.com/vi/${ytVid}/default.jpg"
                loading="lazy" data-error-action="hideParent"
                style="width:${twPc}px;height:${thPc}px;object-fit:cover;border-radius:3px;display:block">
            </a>` : '';
        // 1件目の左にアイコン、右に頻度・ボタン（PCのみ）
        const subStr = fmtSubscribers(f.subscriberCount);
        const leftAvatar = pi===0
          ? `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex-shrink:0">
              <div class="fc-row-avatar" style="background:${bg};color:${fg};width:34px;height:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;font-weight:500;font-family:'DM Mono',monospace;overflow:hidden;position:relative;border:2px solid transparent;${f.markColor&&MARK_COLORS[f.markColor]?`border-color:${MARK_COLORS[f.markColor].border};`:''}">
                ${f.iconUrl?`<img src="${esc(iconSrc(f))}" data-error-action="hideSelf" style="width:100%;height:100%;object-fit:cover;border-radius:5px;position:absolute;inset:0">`:''}
                ${esc(f.initials)}
              </div>
              ${subStr?`<span class="fc-sub-count">${subStr}</span>`:''}
            </div>`
          : `<div style="width:34px;flex-shrink:0"></div>`;
        const rightButtons = '';
        return `<div class="fc-preview-item">
          <div class="fc-avatar-col">${leftAvatar}</div>
          <div class="fc-preview-meta">
            ${dateStr?`<span class="fc-preview-date">${esc(dateStr)}</span>`:''}
            ${durText?`<span class="dp-dur"${durAttr}>${durText}</span>`:''}
          </div>
          <a class="fc-preview-title" href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a>
          ${(!geminiApiKey||p.duration===-2||p.duration===-3) ? '' : `<button class="fc-copy-btn" style="flex-shrink:0;font-size:11px;font-weight:500;font-family:'DM Sans',sans-serif;white-space:nowrap;color:var(--pill-summary);background:#0A5C6B22;border:none;border-radius:99px;padding:2px 9px" data-click="1" data-action="openSummaryModal" data-args="${dargs([f.id, p.link])}" title="AIで要約">要約</button>`}
          ${thumbHtml}
          <span class="fc-preview-spacer" style="flex:1"></span>
          ${rightButtons}
        </div>`;
      }).join('')}
    </div>` : ''}
    <div class="fc-regdate-popup" id="regdate-popup-${f.id}" style="display:none">
      <span class="fc-freq-label">登録日：</span>
      <input type="date" class="fc-tag-input"
        value="${f.registeredAt ? new Date(f.registeredAt).toISOString().slice(0,10) : ''}"
        data-change="1" data-action="changeRegDate" data-args="${dargs([f.id, '@value'])}"
        style="max-width:160px">
      <button class="fc-copy-btn" data-click="1" data-action="toggleRegDateInput" data-args="[${f.id}]">&#x2715;</button>
    </div>
    <div class="fc-detail">
      ${isExp ? freqSelector : ''}
      ${isExp ? renderDetail(f) : ''}
    </div>
  </div>`;
}

function openMarkPopup(id, btn){
  // 既存のポップアップを閉じる
  document.querySelectorAll('.mark-popup').forEach(el=>el.remove());

  const f = follows.find(x=>x.id===id);
  if(!f) return;

  const popup = document.createElement('div');
  popup.className = 'mark-popup';
  popup.onclick = ev=>ev.stopPropagation();

  Object.entries(MARK_COLORS).forEach(([key, val])=>{
    const cb = document.createElement('button');
    cb.className = 'mark-color-btn';
    cb.style.background = val.border;
    cb.title = val.label;
    if(f.markColor===key) cb.style.outline = `2px solid ${val.border}`;
    cb.onclick = ()=>{ setMark(id, key); popup.remove(); };
    popup.appendChild(cb);
  });

  // 解除ボタン
  if(f.markColor){
    const clr = document.createElement('button');
    clr.className = 'mark-clear-btn';
    clr.textContent = '解除';
    clr.onclick = ()=>{ setMark(id, null); popup.remove(); };
    popup.appendChild(clr);
  }

  btn.style.position = 'relative';
  btn.appendChild(popup);

  // 外クリックで閉じる
  setTimeout(()=>{
    document.addEventListener('click', function close(){
      popup.remove();
      document.removeEventListener('click', close);
    }, {once:true});
  }, 0);
}

function setMark(id, color){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  markLocalEdit();
  f.markColor = color || null;
  // favorite フラグと同期（サイドバーフィルター用）
  f.favorite = !!color;
  save();
  // アバターとボタンを即時更新
  const avatar = document.querySelector(`#fc-${id} .fc-avatar`);
  if(avatar) avatar.setAttribute('data-mark', color||'');
  const btn = document.querySelector(`#fc-${id} .fc-fav-btn`);
  if(btn){
    btn.setAttribute('data-mark', color||'');
    btn.textContent = color ? '★' : '☆';
  }
  renderSidebar();
}

function toggleFavorite(id, btn){ openMarkPopup(id, btn); } // 後方互換

function toggleRegDateInput(id){
  const popup = document.getElementById(`regdate-popup-${id}`);
  if(!popup) return;
  const isVisible = popup.style.display !== 'none';
  popup.style.display = isVisible ? 'none' : 'flex';
  if(!isVisible){
    // 日付入力欄にフォーカス
    popup.querySelector('input[type="date"]')?.focus();
  }
}

/* renderFollowCardのdata-action用の小さなラッパー群 */
// カード上のタグ編集欄からフォーカスが外れた時：値を確定保存しつつ、
// クリック確定（selectTag）が先に走れるよう少し遅らせて候補リストを閉じる
function handleCardTagBlur(id, val){
  changeTag(id, val);
  setTimeout(()=>hideTagSuggestions(`tag-suggestions-${id}`), 200);
}
function toggleSuspend(id){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  markLocalEdit();
  f.suspended = !f.suspended;
  save();
  render();
}
function enqueueFetchById(id){
  const f = follows.find(x=>x.id===id);
  if(f) enqueueFetch(f, false);
}
function retryFetchById(id){
  const f = follows.find(x=>x.id===id);
  if(f) fetchFollow(f);
}
function openLogModalById(id){
  const f = follows.find(x=>x.id===id);
  if(f) openLogModal(f);
}
function editUrlInline(id){
  const t = document.getElementById('url-text-'+id);
  const i = document.getElementById('url-input-'+id);
  if(t) t.style.display = 'none';
  if(i){ i.style.display = ''; i.focus(); i.select(); }
}
function commitUrlEdit(id, val){
  const i = document.getElementById('url-input-'+id);
  const t = document.getElementById('url-text-'+id);
  if(i) i.style.display = 'none';
  if(t) t.style.display = '';
  changeUrl(id, val);
}
function selectInputText(el){
  if(el && el.select) el.select();
}

/* ── ヘッダー・ドロワー・ボトムナビ用のラッパー関数（イベント委任のdata-actionから呼ぶ）── */
function scrollMainToTop(){
  const m = document.getElementById('main');
  if(m) m.scrollTo({top:0, behavior:'smooth'});
}
function triggerImportJsonFile(){
  document.getElementById('importJsonFile')?.click();
}
function triggerImportJsonFileMobile(){
  document.getElementById('importJsonFileMobile')?.click();
}
function handleStatusbarClick(){
  if(statusState === 'err') showErrorList();
}
function openModalMobile(){ openModal(); closeDrawer(); }
function refreshAllMobile(){ refreshAll(); closeDrawer(); }
function openLogModalMobile(){ openLogModal(); closeDrawer(); }
function openRevivalHistoryMobile(){ openRevivalHistory(); closeDrawer(); }
// #modalContainerに描画する系のモーダル共通のクローズ処理。
// 背景（バックドロップ）自体をクリックした時だけ閉じる（中身のクリックでは閉じない）。
// 以前はモーダルカード側にevent.stopPropagation()を付けて防いでいたが、
// それだと委任リスナー（documentに1つだけ登録）までイベントが届かなくなり
// モーダル内のボタンが反応しなくなる不具合の元になるため、
// 代わりに「クリックされた要素がバックドロップ自身かどうか」で判定する。
function closeModalContainerIfBackdrop(el, evt){
  if(evt.target === el) document.getElementById('modalContainer').innerHTML = '';
}
function closeModalContainer(){
  document.getElementById('modalContainer').innerHTML = '';
}
// 個別の閉じる関数（closeApiKeyModal等）を持つモーダル用の汎用「背景クリックで閉じる」ラッパー
function closeIfBackdrop(el, evt, closeFnName){
  if(evt.target === el){
    const fn = window[closeFnName];
    if(typeof fn === 'function') fn();
  }
}

/* ── フォロー追加モーダル（renderModal）のフォーム入力用ラッパー ── */
function handleUrlInput(val){
  formData.url = val;
  clearTimeout(window._urlTimer);
  window._urlTimer = setTimeout(()=>autoFetchTitle(val.trim()), 800);
}
function handleNameInput(val){ formData.name = val; }
function handleFreqSelect(val){ formData.freq = val; }
function handleTagsInput(val){ formData.tags = val; showTagSuggestions(val); }
function handleTagsBlur(){ setTimeout(()=>hideTagSuggestions(), 200); }
function handleMemoInput(val){ formData.memo = val; }
function handleImportTextInput(val){ importText = val; renderImportModal(); }
function selectBulkFreq(fr){ bulkFreqSelected = fr; renderBulkFreqModal(); }
function selectBulkTag(t){ bulkTagSelected = t; renderBulkFreqModal(); }
function openGhSettingsModalMobile(){ openGhSettingsModal(); closeDrawer(); }
function openApiKeyModalMobile(){ openApiKeyModal(); closeDrawer(); }
function bulkFetchDurationsMobile(){ bulkFetchDurations(); closeDrawer(); }
function openBulkFreqModalMobile(){ openBulkFreqModal(); closeDrawer(); }
function openImportModalMobile(){ openImportModal(); closeDrawer(); }
function exportJSONMobile(){ exportJSON(); closeDrawer(); }

function copyText(text, btn){
  navigator.clipboard.writeText(text).then(()=>{
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.style.color = 'var(--accent-mid)';
    setTimeout(()=>{ btn.textContent = orig; btn.style.color = ''; }, 1500);
  }).catch(()=>{
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    btn.textContent = '✓';
    setTimeout(()=>{ btn.textContent = '📋'; }, 1500);
  });
}

function changeName(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  const name = val.trim();
  if(!name) return;
  markLocalEdit();
  f.name = name;
  f.initials = name.split(/[\s\/\-_]+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase().slice(0,2) || '??';
  save();
  const nameEl = document.querySelector(`#fc-${id} .fc-name`);
  if(nameEl) nameEl.textContent = name;
  const avatarEl = document.querySelector(`#fc-${id} .fc-avatar`);
  if(avatarEl) avatarEl.textContent = f.initials;
}

function changeUrl(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  const url = val.trim();
  if(!url || url === f.url) return;
  markLocalEdit();
  f.url = url;
  f.error = null;
  save();
  render();
  // URL変更時は新しいフィードを即取得
  enqueueFetch(f, false);
}

function changeMemo(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  markLocalEdit();
  f.memo = val.trim();
  save();
  // カード上のメモインライン表示を更新
  const memoEl = document.querySelector(`#fc-${id} .fc-memo-inline`);
  if(memoEl){
    if(f.memo){ memoEl.innerHTML = '📝 <span>' + linkifyMemo(f.memo) + '</span>'; memoEl.style.display=''; }
    else memoEl.style.display='none';
  }
}

function changeIcon(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  const url = val.trim();
  markLocalEdit();
  f.iconUrl = url || null;
  save();
  render();
}

function changeRegDate(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  if(!val){ f.registeredAt = null; save(); return; }
  // 日付文字列をタイムスタンプに変換（その日の0時0分として保存）
  const d = new Date(val);
  if(isNaN(d.getTime())) return;
  f.registeredAt = d.getTime();
  save();
  // ヒントメッセージを消す
  const hint = document.querySelector(`#fc-${id} #regdate-input-${id} + span`);
  if(hint) hint.remove();
}

function changeFreq(id, freq){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  markLocalEdit();
  f.freq = freq;
  save();
  render();
  // 頻度変更時は即フェッチ
  enqueueFetch(f);
}

/* タグ文字列をカンマ・半角スペース・全角スペースで分割 */
function splitTags(val){
  return val.split(/[,、\s\u3000]+/).map(s=>s.trim()).filter(Boolean);
}

function changeTag(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  markLocalEdit();
  f.tags = splitTags(val);
  if(!f.tags.length) f.tags = ['一般'];
  save();
  renderTags(); // タグバーを更新
  // カードのタグ表示を更新（展開状態を保持したまま）
  const card = document.getElementById(`fc-${id}`);
  if(card){
    const topEl = card.querySelector('.fc-top');
    if(topEl){
      // タグpillだけ更新
      topEl.querySelectorAll('.fc-tag').forEach(el=>el.remove());
      f.tags.forEach(t=>{
        const span = document.createElement('span');
        span.className = 'fc-tag';
        span.textContent = t;
        span.title = 'このタグで絞り込む';
        span.style.cursor = 'pointer';
        span.onclick = (e)=>{ e.stopPropagation(); setTag(t); };
        topEl.appendChild(span);
      });
    }
  }
}

/* parseDate は parser.js に移動（DOMParser系の共通処理として抽出） */

function fmtDatetime(date){
  if(!date || isNaN(date.getTime())) return '';
  // M/D H:MM 形式（十の桁が0の場合は省略）
  const mo  = date.getMonth() + 1;
  const dy  = date.getDate();
  const h   = date.getHours();
  const mn  = String(date.getMinutes()).padStart(2,'0');
  return `${mo}/${dy} ${h}:${mn}`;
}

function fmtDuration(sec){
  if(sec === -2) return 'Live';   // ライブ配信中
  if(sec === -3) return '予定';   // 配信予定
  if(sec === -1) return '';        // 取得済みだが時間なし
  if(!sec || sec<=0) return '';
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec % 60;
  if(h>0) return `${h}時間${m}分`;
  if(m>0) return `${m}分${s>0?s+'秒':''}`;
  return `${s}秒`;
}

/* タイトルからライブ配信かどうかを判定 */
/* ライブバッジ情報を返す: {text, attr} */
function getLiveBadge(p){
  if(p.duration === -2) return {text:'🔴 Live', attr:' data-live="true"'};
  if(p.duration === -3){
    let text = '予定';
    const now = new Date();

    // RSSの<updated>（フィード側の最終更新日時）が長時間動いていない場合、
    // その配信予定はYouTube側でも放置されている可能性が高いとみなす。
    const RSS_STALE = 24 * 60 * 60 * 1000; // 24時間
    let rssStale = false;
    if(p.rssUpdated){
      const ru = p.rssUpdated instanceof Date ? p.rssUpdated : new Date(p.rssUpdated);
      if(!isNaN(ru.getTime())) rssStale = (now - ru) > RSS_STALE;
    }

    if(p.scheduledAt){
      const d = p.scheduledAt instanceof Date ? p.scheduledAt : new Date(p.scheduledAt);
      if(!isNaN(d.getTime())){
        const diff = d - now;
        if(diff > 0){
          // 未来の予定
          const h = Math.floor(diff/3600000);
          const m = Math.floor((diff%3600000)/60000);
          if(h >= 24){
            text = `予定 ${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
          } else if(h > 0){
            text = `予定 ${h}時間${m}分後`;
          } else {
            text = `予定 ${m}分後`;
          }
        } else {
          // 予定時刻を過ぎている。開始が遅れているだけの可能性があるため、
          // 一定時間（PAST_DUE_HIDE）以内は日時付きで「予定」表示を継続する。
          // ただしRSSが24時間以上動いていない（=放置されている可能性が高い）場合は、
          // その猶予を待たずに即バッジを出さない。
          const PAST_DUE_HIDE = 6 * 60 * 60 * 1000; // 6時間
          if(diff > -PAST_DUE_HIDE && !rssStale){
            text = `予定 ${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
          } else {
            return {text:'', attr:''};
          }
        }
      }
    } else if(rssStale){
      // 予定時刻の情報自体がない場合でも、RSSが長時間更新されていなければ
      // 放置された予定とみなしバッジを出さない。
      return {text:'', attr:''};
    }
    return {text, attr:' data-upcoming="true"'};
  }
  if(isLiveTitle(p.title)) return {text:'Live', attr:' data-live-archive="true"'};
  return null;
}

function isLiveTitle(title){
  if(!title) return false;
  const t = title.toLowerCase();
  return /\blive\b/.test(t)          // "live" 単語
    || t.includes('ライブ')
    || t.includes('生放送')
    || t.includes('生配信')
    || t.includes('配信中')
    || /\blive\s*(stream|配信|放送)/.test(t);
}

// 次回取得予定時刻を計算（fetchTimesから現在以降で最も近い時刻）
function nextFetchTime(f){
  if(!f.fetchTimes) return null;
  const times = f.fetchTimes.split(',').filter(Boolean);
  if(!times.length) return null;
  const now = new Date();
  let candidates = [];
  times.forEach(t=>{
    const [h,m] = t.split(':').map(Number);
    // 本日の予定時刻
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    // 翌日の予定時刻
    const tomorrow = new Date(today.getTime() + 86400000);
    if(today > now) candidates.push(today);
    candidates.push(tomorrow);
  });
  candidates.sort((a,b)=>a-b);
  return candidates[0] || null;
}

// 取得時刻の設定（@8:00,20:00形式の時刻リスト）
function setFetchTimes(id, val){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  // 正規化: 全角→半角、@や空白を除去し、HH:MM形式を抽出
  const cleaned = (val||'')
    .replace(/[０-９]/g, c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))
    .replace(/：/g, ':')
    .replace(/[@＠\s]/g, '');
  const times = cleaned.split(',')
    .map(t=>t.trim())
    .filter(t=>/^\d{1,2}:\d{2}$/.test(t))
    .filter(t=>{
      const [h,m] = t.split(':').map(Number);
      return h>=0 && h<=23 && m>=0 && m<=59;
    });
  f.fetchTimes = times.join(',');
  save();
  // 展開中なら次回予定の表示を更新
  const nextEl = document.querySelector(`#fc-${id} .dp-schedule-next`);
  const nextFt = nextFetchTime(f);
  if(nextFt){
    const now = new Date();
    const sameDay = nextFt.getDate()===now.getDate() && nextFt.getMonth()===now.getMonth();
    const dayLabel = sameDay ? '本日' : '明日';
    const hh = String(nextFt.getHours()).padStart(2,'0');
    const mm = String(nextFt.getMinutes()).padStart(2,'0');
    const txt = `次回取得予定: ${dayLabel} ${hh}:${mm}`;
    if(nextEl){ nextEl.textContent = txt; }
    else {
      const input = document.getElementById(`sched-${id}`);
      if(input){
        const span = document.createElement('span');
        span.className = 'dp-schedule-next';
        span.textContent = txt;
        input.insertAdjacentElement('afterend', span);
      }
    }
  } else if(nextEl){
    nextEl.remove();
  }
}

// 取得時刻スケジュールのチェック（1分ごとに呼ばれる）
function checkFetchSchedules(){
  const now = new Date();
  follows.forEach(f=>{
    if(!f.fetchTimes || f.suspended) return;
    const times = f.fetchTimes.split(',').filter(Boolean);
    const lastFetched = f.lastFetched ? new Date(f.lastFetched) : null;
    for(const t of times){
      const [h,m] = t.split(':').map(Number);
      // 本日のその予定時刻
      const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
      // 予定時刻を過ぎていて、まだその時刻以降に取得していなければ取得
      if(scheduled <= now && (!lastFetched || lastFetched < scheduled)){
        enqueueFetch(f, false);
        break; // 1チャンネルにつき1回でOK
      }
    }
  });
}

// 登録者数を万単位で整形（例: 12345→1.2万人, 3456789→345万人）
function fmtSubscribers(n){
  if(n == null || isNaN(n)) return '';
  if(n < 10000) return n.toLocaleString('ja-JP') + '人'; // 1万未満は実数
  const man = n / 10000;
  if(man < 10) return man.toFixed(1).replace(/\.0$/,'') + '万人'; // 1.2万人
  return Math.round(man) + '万人'; // 345万人
}

function renderDetail(f){
  const nextFt = nextFetchTime(f);
  const nextFtStr = nextFt
    ? (()=>{
        const now = new Date();
        const sameDay = nextFt.getDate()===now.getDate() && nextFt.getMonth()===now.getMonth();
        const dayLabel = sameDay ? '本日' : '明日';
        const hh = String(nextFt.getHours()).padStart(2,'0');
        const mm = String(nextFt.getMinutes()).padStart(2,'0');
        return `${dayLabel} ${hh}:${mm}`;
      })()
    : null;
  // 頻度ベースの次回更新予定
  const freqInterval = FREQ_INTERVAL[f.freq];
  let freqNextStr = null;
  if(freqInterval != null && f.lastFetched){
    const freqNext = new Date(f.lastFetched + freqInterval);
    const now = new Date();
    if(freqNext <= now){
      freqNextStr = 'まもなく';
    } else {
      const sameDay = freqNext.getDate()===now.getDate() && freqNext.getMonth()===now.getMonth();
      const hh = String(freqNext.getHours()).padStart(2,'0');
      const mm = String(freqNext.getMinutes()).padStart(2,'0');
      freqNextStr = sameDay ? `${hh}:${mm}` : `明日 ${hh}:${mm}`;
    }
  } else if(freqInterval != null && !f.lastFetched){
    freqNextStr = 'まもなく';
  }
  const scheduleUI = `<div class="dp-schedule">
    <label class="dp-schedule-label">個別指定
      <span class="dp-schedule-hint" title="毎日この時刻に自動取得します。複数指定はカンマ区切り。例: 8:00,20:00">?</span>
    </label>
    <input type="text" class="dp-schedule-input" id="sched-${f.id}"
      value="${esc(f.fetchTimes || '')}"
      placeholder="例: 8:00,20:00"
      data-change="1" data-action="setFetchTimes" data-args="${dargs([f.id, '@value'])}">
    ${nextFtStr ? `<span class="dp-schedule-next">時刻指定: ${nextFtStr}</span>` : ''}
    ${freqNextStr ? `<span class="dp-schedule-next" style="background:var(--surface)">頻度(${esc(freqLabel(f.freq))})次回: ${freqNextStr}</span>` : ''}
    <div class="dp-schedule-desc">毎日この時刻に自動取得（空欄で従来通り）。頻度タグでも定期取得されます。</div>
  </div>`;
  if(f.loading) return scheduleUI + '<div class="dp-empty">読み込み中...</div>';
  if(f.error) return scheduleUI + `<div class="dp-err">${esc(f.error)}</div><button class="dp-refresh" data-click="1" data-action="retryFetchById" data-args="[${f.id}]">再試行</button>`;
  if(!f.posts || f.posts.length===0) return scheduleUI + '<div class="dp-empty">記事が見つかりませんでした</div>';
  return scheduleUI + `<ul class="detail-posts">
    ${f.posts.map(p=>{
      const dur = fmtDuration(p.duration);
      const dateStr = fmtDatetime(p.date);
      const isShort = p.link && p.link.includes('/shorts/');
      const liveBadge = getLiveBadge(p);
      const durAttr = liveBadge ? liveBadge.attr : isShort ? ' data-short="true"' : '';
      const durText = liveBadge ? liveBadge.text : isShort ? `[ショート]${dur ? ' '+dur : ''}` : dur;
      return `<li class="dp-item">
        <div class="dp-dot"></div>
        ${dateStr ? `<span class="dp-date">${esc(dateStr)}</span>` : ''}
        ${durText ? `<span class="dp-dur"${durAttr}>${esc(durText)}</span>` : ''}
        <a class="dp-link" href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      </li>`;
    }).join('')}
  </ul>`;
}

/* YouTube動画IDをURLから抽出 */
/* YouTube動画IDをURLから抽出（Shorts対応） */
function ytVideoId(url){
  if(!url) return null;
  const m1 = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if(m1) return m1[1];
  const m2 = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if(m2) return m2[1];
  const m3 = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if(m3) return m3[1];
  return null;
}

/* 動画IDから秒数を返す */
async function fetchYTDurationById(videoId){
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails&id=${videoId}&key=${ytApiKey}`,
    {signal: AbortSignal.timeout(10000)}
  );
  if(!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  const dur = json.items?.[0]?.contentDetails?.duration; // "PT1H23M45S"
  if(!dur) return 0;
  let sec = 0;
  const h = dur.match(/(\d+)H/); if(h) sec += parseInt(h[1])*3600;
  const m = dur.match(/(\d+)M/); if(m) sec += parseInt(m[1])*60;
  const s = dur.match(/(\d+)S/); if(s) sec += parseInt(s[1]);
  return sec;
}

async function fetchDurationsForFollow(f){
  if(!ytApiKey) return;
  const ytPosts = (f.posts||[]).filter(p=>{
    if(!p.link) return false;
    const isYT = p.link.includes('youtube.com')||p.link.includes('youtu.be');
    return isYT && !p.duration;
  });
  if(!ytPosts.length) return;
  const pairs = ytPosts.map(p=>({vid:ytVideoId(p.link), post:p})).filter(x=>x.vid);
  if(!pairs.length) return;
  try{
    const ids = pairs.map(x=>x.vid).join(',');
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails&id=${ids}&key=${ytApiKey}&maxResults=50`,
      {signal: AbortSignal.timeout(15000)}
    );
    if(!res.ok) return;
    const json = await res.json();
    const itemMap = {};
    (json.items||[]).forEach(item=>{ itemMap[item.id]=item; });
    pairs.forEach(x=>{
      const item = itemMap[x.vid];
      if(!item){ x.post.duration=-1; return; }
      // ライブ配信チェック
      const liveStatus = item.snippet?.liveBroadcastContent; // 'live'|'upcoming'|'none'
      const dur = item.contentDetails?.duration;
      if(liveStatus==='live'){
        x.post.duration = -2; // -2=ライブ配信中
        return;
      }
      if(liveStatus==='upcoming'){
        x.post.duration = -3; // -3=配信予定
        // 配信予定時刻を保存
        const scheduledTime = item.liveStreamingDetails?.scheduledStartTime;
        if(scheduledTime) x.post.scheduledAt = new Date(scheduledTime);
        return;
      }
      if(!dur || dur==='PT0S'){ x.post.duration=-1; return; }
      let sec = 0;
      const h = dur.match(/(\d+)H/); if(h) sec += parseInt(h[1])*3600;
      const m = dur.match(/(\d+)M/); if(m) sec += parseInt(m[1])*60;
      const s = dur.match(/(\d+)S/); if(s) sec += parseInt(s[1]);
      x.post.duration = sec > 0 ? sec : -1;
    });
    save(true, false); // 自動取得（毎回のRSS取得後に付随して走る）のためユーザー編集扱いにしない
    debouncedRender();
  }catch(e){}
}

/* 全フォローの動画時間を一括取得 */
async function bulkFetchDurations(){
  if(!ytApiKey){
    openApiKeyModal();
    return;
  }
  // 未取得のYouTube動画を全部集める（shorts含む）
  const allPosts = [];
  let skipped = 0;
  follows.forEach(f=>{
    (f.posts||[]).forEach(p=>{
      if(!p.link) return;
      const isYT = p.link.includes('youtube.com') || p.link.includes('youtu.be');
      if(!isYT) return;
      if(p.duration > 0) return; // 取得済み
      const vid = ytVideoId(p.link);
      if(vid) allPosts.push({vid, post: p});
      else skipped++;
    });
  });

  if(!allPosts.length){
    setStatus('ok', `未取得の動画はありません${skipped>0?`（ID取得不可: ${skipped}件）`:''}`);
    return;
  }

  setStatus('loading', `動画時間を取得中... 0/${allPosts.length}件`);

  const CHUNK = 50;
  let done = 0;
  let failed = 0;
  for(let i=0; i<allPosts.length; i+=CHUNK){
    const chunk = allPosts.slice(i, i+CHUNK);
    const ids = chunk.map(x=>x.vid).join(',');
    try{
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails&id=${ids}&key=${ytApiKey}&maxResults=50`,
        {signal: AbortSignal.timeout(15000)}
      );
      if(!res.ok){
        const err = await res.json().catch(()=>({}));
        const msg = err.error?.message || `HTTP ${res.status}`;
        if(res.status===403 && msg.includes('quota')){
          setStatus('err', `クォータ超過: 1日の上限(1万回)に達しました。明日また試してください`);
        } else {
          setStatus('err', `APIエラー: ${msg}`);
        }
        save(); render();
        return;
      }
      const json = await res.json();
      const itemMap = {};
      (json.items||[]).forEach(item=>{ itemMap[item.id]=item; });
      chunk.forEach(x=>{
        const item = itemMap[x.vid];
        if(!item){ failed++; return; }
        const liveStatus = item.snippet?.liveBroadcastContent;
        const dur = item.contentDetails?.duration;
        if(liveStatus==='live'){ x.post.duration=-2; done++; return; }
        if(liveStatus==='upcoming'){ 
          x.post.duration=-3; 
          const scheduledTime = item.liveStreamingDetails?.scheduledStartTime;
          if(scheduledTime) x.post.scheduledAt = new Date(scheduledTime);
          done++; return; 
        }
        if(!dur || dur==='PT0S'){ x.post.duration=-1; failed++; return; }
        let sec = 0;
        const h = dur.match(/(\d+)H/); if(h) sec += parseInt(h[1])*3600;
        const m = dur.match(/(\d+)M/); if(m) sec += parseInt(m[1])*60;
        const s = dur.match(/(\d+)S/); if(s) sec += parseInt(s[1]);
        x.post.duration = sec > 0 ? sec : -1;
        done++;
      });
      save();
      setStatus('loading', `動画時間を取得中... ${done}/${allPosts.length}件`);
      if(i+CHUNK < allPosts.length) await new Promise(r=>setTimeout(r,200));
    }catch(e){
      setStatus('err', `取得エラー: ${e.message}`);
      save(); render();
      return;
    }
  }

  save();
  debouncedRender();
  const msg = `動画時間の取得完了: ${done}件取得${failed>0?` / ${failed}件取得不可`:''}${skipped>0?` / ${skipped}件ID不明`:''}`;
  setStatus('ok', msg);
}

/* APIキー設定モーダル */
function openApiKeyModal(){
  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeApiKeyModal"]'>
    <div class="modal">
      <h2>YouTube APIキー設定</h2>
      <div class="form-row">
        <label class="form-label">APIキー</label>
        <input class="form-input" id="apiKeyInput" type="text"
          value="${esc(ytApiKey)}" placeholder="AIza...">
        <div class="form-hint">
          Google Cloud Consoleで発行した YouTube Data API v3 のキーを入力してください。
          1日1万回まで無料です。
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeApiKeyModal">キャンセル</button>
        <button class="btn-ok" data-click="1" data-action="saveApiKey">保存</button>
      </div>
    </div>
  </div>`;
}
function closeApiKeyModal(){ document.getElementById('modalContainer').innerHTML=''; }
function saveApiKey(){
  const key = document.getElementById('apiKeyInput').value.trim();
  ytApiKey = key;
  localStorage.setItem('fraidycat_yt_api_key', key);
  mirrorToChromeStorage({ fraidycat_yt_api_key: key });
  closeApiKeyModal();
  setStatus('ok', 'APIキーを保存しました');
}

/* ── 動画要約（Google Gemini API・無料枠あり）── */
function openSummaryApiKeyModal(){
  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeSummaryApiKeyModal"]'>
    <div class="modal">
      <h2>要約APIキー設定</h2>
      <div class="form-row">
        <label class="form-label">Google Gemini APIキー</label>
        <input class="form-input" id="summaryApiKeyInput" type="text"
          value="${esc(geminiApiKey)}" placeholder="AIza...">
        <div class="form-hint">
          aistudio.google.com/apikey で発行したAPIキーを入力してください（無料・クレジットカード登録不要、1日1,500回まで）。動画タイトルの横の「要約」から使用できます。
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeSummaryApiKeyModal">キャンセル</button>
        <button class="btn-ok" data-click="1" data-action="saveSummaryApiKey">保存</button>
      </div>
    </div>
  </div>`;
}
function closeSummaryApiKeyModal(){ document.getElementById('modalContainer').innerHTML=''; }
function saveSummaryApiKey(){
  const key = document.getElementById('summaryApiKeyInput').value.trim();
  geminiApiKey = key;
  localStorage.setItem('fraidycat_gemini_api_key', key);
  mirrorToChromeStorage({ fraidycat_gemini_api_key: key });
  closeSummaryApiKeyModal();
  setStatus('ok', '要約APIキーを保存しました');
}

// 要約モーダルを開く（follow id と 動画linkで対象を特定する）
function openSummaryModal(fid, link){
  const f = follows.find(x=>x.id===fid);
  const p = f && f.posts.find(x=>x.link===link);
  if(!f || !p) return;

  let m = document.getElementById('summaryModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'summaryModal';
    m.className = 'modal-backdrop';
    m.onclick = (e)=>{ if(e.target===m) closeSummaryModal(); };
    document.body.appendChild(m);
  }
  m.style.display = 'flex';
  m.innerHTML = `<div class="modal" style="max-width:560px;width:92%;max-height:80vh;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <h2 style="margin:0;font-size:16px">📝 要約</h2>
      <button class="btn-cancel" style="margin-left:auto" data-click="1" data-action="closeSummaryModal">閉じる</button>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">${esc(p.title)}</div>
    <div id="summaryBody" style="overflow-y:auto;flex:1;font-size:13px;line-height:1.7;white-space:pre-wrap">要約を生成中…</div>
  </div>`;

  runSummary(f, p);
}
function closeSummaryModal(){
  const m = document.getElementById('summaryModal');
  if(m) m.style.display = 'none';
}

async function runSummary(f, p){
  const body = document.getElementById('summaryBody');
  if(!geminiApiKey){
    if(body) body.textContent = '要約APIキーが未設定です。ヘッダーの「🧠 要約APIキー」から設定してください。';
    return;
  }
  // RSSの説明文があれば使う（無ければタイトルのみで試みる）
  const desc = (p.description || '').slice(0, 3000);
  const prompt = desc
    ? `あなたは日本語でYouTube動画の要約を作るアシスタントです。以下の動画情報を日本語で3〜5行程度に簡潔に要約してください。\n\nチャンネル名: ${f.name}\nタイトル: ${p.title}\n説明文:\n${desc}`
    : `あなたは日本語でYouTube動画の要約を作るアシスタントです。以下はタイトルのみです。説明文が無いため内容の推測であることが分かるように一言添えたうえで、日本語で短く要約・補足してください。\n\nチャンネル名: ${f.name}\nタイトル: ${p.title}`;

  try{
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    if(!res.ok){
      const errJson = await res.json().catch(()=>null);
      const msg = errJson?.error?.message || `HTTP ${res.status}`;
      if(body) body.textContent = `要約の生成に失敗しました: ${msg}`;
      return;
    }
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(要約を取得できませんでした)';
    if(body) body.textContent = text;
  }catch(e){
    if(body) body.textContent = `要約の生成に失敗しました: ${e.message}`;
  }
}

const SORT_LABELS = {
  'freq':              {icon:'📋', label:'チャンネル順'},
  'latest':            {icon:'🕐', label:'新着順'},
  'duration-desc':     {icon:'⏬', label:'長い順'},
  'duration-asc':      {icon:'⏫', label:'短い順'},
  'registered-desc':   {icon:'🆕', label:'登録新しい順'},
  'registered-asc':    {icon:'🕰', label:'登録古い順'},
  'subscribers-desc':  {icon:'👥', label:'登録者数順'},
  'fetched-desc':      {icon:'🔄', label:'取得新しい順'},
  'fetched-asc':       {icon:'⏳', label:'取得古い順'},
};

function updateSortBtn(){
  const pcMap = {
    'freq':'pcSortFreq','latest':'pcSortLatest',
    'duration-desc':'pcSortDurDesc','duration-asc':'pcSortDurAsc',
    'registered-desc':'pcSortRegDesc','registered-asc':'pcSortRegAsc',
    'subscribers-desc':'pcSortSubDesc',
    'fetched-desc':'pcSortFetchDesc','fetched-asc':'pcSortFetchAsc',
  };
  Object.entries(pcMap).forEach(([mode,id])=>{
    const el = document.getElementById(id);
    if(el) el.classList.toggle('active', sortMode===mode);
  });
  const dBtn = document.getElementById('drawerSortBtn');
  if(dBtn){
    const info = SORT_LABELS[sortMode];
    dBtn.querySelector('.drawer-icon').textContent = info.icon;
    dBtn.childNodes[1].textContent = info.label + 'で表示中';
  }
  const bMap = {
    'freq':'bnavFreq','latest':'bnavLatest',
    'duration-desc':'bnavDurDesc','duration-asc':'bnavDurAsc'
  };
  Object.entries(bMap).forEach(([mode,id])=>{
    const el = document.getElementById(id);
    if(el) el.classList.toggle('active', sortMode===mode);
  });
}

function linkifyMemo(text){
  if(!text) return '';
  const escaped = esc(text);
  return escaped.replace(/(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>'
  );
}

function setSearch(val){
  searchQuery = val.trim();
  const clr = document.getElementById('searchClear');
  if(clr) clr.style.display = searchQuery ? 'block' : 'none';
  renderMain();
}

function clearSearch(){
  searchQuery = '';
  const input = document.getElementById('searchInput');
  if(input) input.value = '';
  const clr = document.getElementById('searchClear');
  if(clr) clr.style.display = 'none';
  renderMain();
}

function setSortMode(mode){
  sortMode = mode;
  updateSortBtn();

  // タイムライン系は重いので、先にローディング表示してから非同期描画
  const isHeavy = ['latest','duration-desc','duration-asc'].includes(mode);
  if(isHeavy && follows.length > 50){
    const main = document.getElementById('main');
    main.innerHTML = `<div class="sort-loading">
      <div class="sort-loading-spinner"></div>
      <div class="sort-loading-text">並べ替え中...</div>
    </div>`;
    // ローディング表示を描画させてから実行
    requestAnimationFrame(()=>{
      requestAnimationFrame(()=>{
        renderMain();
      });
    });
  } else {
    renderMain();
  }
}

function openDrawer(){
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('open');
  document.body.style.overflow='hidden';

  const freqDiv = document.getElementById('drawerFreqFilter');
  if(freqDiv){
    const freqCounts = {};
    follows.forEach(f=>{ freqCounts[f.freq]=(freqCounts[f.freq]||0)+1; });
    const suspendedCount = follows.filter(f=>f.suspended).length;
    const favoriteCount = follows.filter(f=>f.favorite).length;

    // 検索欄の値を同期（静的HTMLに設定済み）
    const searchEl2 = document.getElementById('drawerSearchStatic');
    if(searchEl2) searchEl2.value = searchQuery;
    let html = '';

    // 頻度フィルターボタンをevent delegationで安全に生成
    const makeBtn = (label, icon, isActive, freq, tag, sort) => {
      const dataAttrs = [];
      if(freq !== undefined) dataAttrs.push(`data-freq="${freq===null?'__null__':freq}"`);
      if(tag !== undefined) dataAttrs.push(`data-tag="${tag}"`);
      if(sort !== undefined) dataAttrs.push(`data-sort="${sort}"`);
      return `<button class="drawer-btn${isActive?' primary':''}" ${dataAttrs.join(' ')}
        style="padding:8px 12px;font-size:13px">
        <span class="drawer-icon">${icon}</span>${label}
      </button>`;
    };

    html += makeBtn(`すべて（${follows.length}）`, '📋', !activeFreq && activeTag==='すべて' && !searchQuery, null, 'すべて');
    // 頻度は横並びの小さなピルで省スペース化（カード側のfreq-pillと同じ配色）
    const allFreqs = [...new Set([...FREQS, ...Object.keys(freqCounts)])];
    html += `<div style="display:flex;flex-wrap:wrap;gap:5px;padding:2px 12px 8px">`;
    allFreqs.forEach(fr=>{
      const cnt = freqCounts[fr]||0;
      if(!cnt) return;
      const pillClass = FREQ_PILL[fr] || '';
      html += `<button class="freq-pill sb-freq-chip ${pillClass}${activeFreq===fr?' active':''}" data-freq="${fr}">${freqLabel(fr)} ${cnt}</button>`;
    });
    html += `</div>`;
    // 個別指定（取得時刻設定済み）を別枠で
    const scheduledCount = follows.filter(f=>f.fetchTimes && f.fetchTimes.length>0).length;
    if(scheduledCount > 0){
      html += `<div style="height:0;border-top:1px dashed var(--border-strong);margin:4px 12px;opacity:.6"></div>`;
      html += makeBtn(`個別指定（${scheduledCount}）`, '🕗', activeTag==='__scheduled__', undefined, '__scheduled__');
    }
    if(favoriteCount > 0){
      html += makeBtn(`マーク済み（${favoriteCount}）`, '★', activeTag==='__favorite__', undefined, '__favorite__');
      // 色ごとの内訳を横並びの小さなスウォッチで表示（省スペース）。
      // タップでその色のチャンネルだけに絞り込める
      html += `<div style="display:flex;gap:8px;padding:2px 12px 8px 42px">`;
      Object.entries(MARK_COLORS).forEach(([key, val])=>{
        const markCnt = follows.filter(f=>f.markColor===key).length;
        if(!markCnt) return;
        const markTag = `__mark_${key}__`;
        const textColor = key==='yellow' ? val.darkBg : '#fff';
        html += `<button data-tag="${markTag}" title="${val.label}マーク（${markCnt}件）"
          style="width:18px;height:18px;border-radius:50%;background:${val.border};color:${textColor};
          border:1.5px solid ${activeTag===markTag?'var(--text)':'transparent'};cursor:pointer;
          font-size:8px;font-family:'DM Mono',monospace;display:flex;align-items:center;justify-content:center;flex-shrink:0">${markCnt}</button>`;
      });
      html += `</div>`;
    }
    if(suspendedCount > 0)
      html += makeBtn(`更新外（${suspendedCount}）`, '⏸', activeTag==='__suspended__', undefined, '__suspended__');

    html += `<div style="padding:6px 12px 2px;font-size:11px;font-weight:500;color:var(--text-faint);letter-spacing:.06em;text-transform:uppercase">登録順</div>`;
    html += makeBtn('登録 新しい順', '🆕', sortMode==='registered-desc', undefined, undefined, 'registered-desc');
    html += makeBtn('登録 古い順', '🕰', sortMode==='registered-asc', undefined, undefined, 'registered-asc');
    html += makeBtn('登録者数順', '👥', sortMode==='subscribers-desc', undefined, undefined, 'subscribers-desc');
    html += makeBtn('取得 新しい順', '🔄', sortMode==='fetched-desc', undefined, undefined, 'fetched-desc');
    html += makeBtn('取得 古い順', '⏳', sortMode==='fetched-asc', undefined, undefined, 'fetched-asc');

    freqDiv.innerHTML = html;

    // event delegation でボタンのクリックを処理
    freqDiv.onclick = freqDiv.ontouchend = (e) => {
      if(e.type === 'touchend') e.preventDefault();
      const btn = e.target.closest('button[data-freq],button[data-tag],button[data-sort]');
      if(!btn) return;
      if(btn.dataset.sort){ setSortMode(btn.dataset.sort); }
      if(btn.dataset.freq !== undefined){ setFreq(btn.dataset.freq === '__null__' ? null : btn.dataset.freq); }
      if(btn.dataset.tag !== undefined){ setTag(btn.dataset.tag); }
      closeDrawer();
    };
  }
}
function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('open');
  document.body.style.overflow='';
}

/* ── ドロワーのスワイプ操作（タップだけでなく、指の動きでも開閉できるように）──
   ドロワーは画面右端に固定され、右へtranslateX(100%)することで隠れている。
   1) 画面右端（EDGE_ZONE以内）から始まる左スワイプ → ドロワーを開く
   2) ドロワーが開いている状態で、ドロワー上を右へドラッグ → 指に追従して
      閉じる方向へ動き、一定距離を超えたら閉じる（離した位置で閉じるか
      元に戻るかが決まる、ネイティブアプリのような操作感）
   縦スクロールを誤って妨げないよう、横方向の動きが縦方向より明確に
   大きい場合のみスワイプとして扱う。また、スワイプが成立した場合は
   （既存のタップ用の委任リスナーがtouchendで誤発火しないよう）
   captureフェーズでイベントの伝播を止める。

   スマホを片手で持って親指で操作する場合、親指の付け根（右下付近）を
   支点にした弧を描く動きになるため、「まっすぐ上」に動かしたつもりでも
   軌跡は右上方向にずれやすい。これを単純に「横方向が縦方向より大きければ
   横スワイプ」と判定すると、上方向スクロールのつもりが誤って横スワイプ
   （メニューを開く／閉じる）と判定されてしまう。これを防ぐため、
   ①判定を始めるまでの遊び（DEADZONE）を広めに取り、②横方向の動きが
   縦方向よりも明確に（AXIS_RATIO倍以上）大きい場合のみ横スワイプと
   判定するようにして、弧を描く動きによる誤判定を抑えている。 */
(function(){
  const EDGE_ZONE = 24;       // 画面右端からこの範囲内で始まったタッチのみ「開く」対象にする
  const OPEN_THRESHOLD = 60;  // これ以上左へ動いたら開く
  const CLOSE_THRESHOLD = 70; // これ以上右へドラッグしたら閉じる
  const DEADZONE = 18;        // 判定を始めるまでの遊び（片手操作の弧による初期ぶれを吸収）
  const AXIS_RATIO = 1.8;     // 横方向が縦方向のこの倍数を超えて初めて横スワイプと判定
  let startX = null, startY = null, tracking = false, mode = null; // mode: 'open' | 'close'
  let drawerEl = null;

  function isDrawerOpen(){
    const d = document.getElementById('drawer');
    return !!(d && d.classList.contains('open'));
  }

  document.addEventListener('touchstart', (e)=>{
    if(e.touches.length !== 1){ mode = null; return; }
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; tracking = false; mode = null; drawerEl = null;
    if(isDrawerOpen()){
      const d = document.getElementById('drawer');
      if(d && d.contains(e.target)){
        mode = 'close';
        drawerEl = d;
      }
    } else if(window.innerWidth - t.clientX <= EDGE_ZONE){
      mode = 'open';
    }
  }, {capture:true, passive:true});

  document.addEventListener('touchmove', (e)=>{
    if(mode === null || startX === null) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if(!tracking){
      if(Math.abs(dx) < DEADZONE && Math.abs(dy) < DEADZONE) return;
      // 横方向が縦方向よりAXIS_RATIO倍以上大きい場合のみ横スワイプとして確定させる。
      // 片手操作の弧による初期ぶれ程度では横スワイプと判定されないようにするため。
      if(Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO){ mode = null; return; } // 縦方向優勢ならスクロールに譲る
      tracking = true;
    }
    if(mode === 'close' && drawerEl){
      if(dx > 0){
        if(e.cancelable) e.preventDefault();
        drawerEl.style.transition = 'none';
        drawerEl.style.transform = `translateX(${Math.min(dx, 280)}px)`;
      }
    } else if(mode === 'open'){
      if(dx < 0 && e.cancelable) e.preventDefault();
    }
  }, {capture:true, passive:false});

  document.addEventListener('touchend', (e)=>{
    if(mode === 'close' && drawerEl){
      drawerEl.style.transition = '';
      drawerEl.style.transform = '';
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      if(tracking){
        e.stopPropagation(); // タップ用の委任リスナー（ボタン誤発火）を防ぐ
        if(dx > CLOSE_THRESHOLD) closeDrawer();
      }
    } else if(mode === 'open' && tracking){
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      e.stopPropagation();
      if(dx < -OPEN_THRESHOLD) openDrawer();
    }
    startX = null; startY = null; tracking = false; mode = null; drawerEl = null;
  }, {capture:true});
})();

let skipScrollRestore = false;

function render(){
  const main = document.getElementById('main');
  const scrollTop = main ? main.scrollTop : 0;
  renderSidebar();
  renderMain();
  renderTags();
  updateSortBtn();
  if(main && !skipScrollRestore) requestAnimationFrame(()=>{ main.scrollTop = scrollTop; });
  skipScrollRestore = false;
}


function renderTags(){
  // PCサイドバーのタグを更新
  renderSidebar();
  // スマホ用ヘッダータグバーを更新（PCで設定した順序を反映）
  const mobileBar = document.getElementById('mobileTagsScroll');
  if(!mobileBar) return;
  const allTagsList = ['すべて', ...getSortedTags()];
  mobileBar.innerHTML = allTagsList.map(t=>
    `<button class="tag-btn${activeTag===t?' active':''}"
      style="white-space:nowrap;font-size:12px;padding:4px 10px;border-radius:99px;border:1px solid var(--border);background:${activeTag===t?'var(--accent)':'transparent'};color:${activeTag===t?'#fff':'var(--text-muted)'};cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;"
      data-click="1" data-action="setTag" data-args="${dargs([t])}">${t}</button>`
  ).join('');
}

// タグの並び順をlocalStorageで管理
function saveTagOrder(){
  localStorage.setItem('fraidycat_tag_order', JSON.stringify(tagOrder));
  mirrorToChromeStorage({ fraidycat_tag_order: tagOrder });
}

function getSortedTags(){
  const allTags = [...new Set(follows.flatMap(f=>f.tags))];
  // tagOrderに含まれるものを先に、残りはアルファベット順
  const ordered = tagOrder.filter(t=>allTags.includes(t));
  const rest = allTags.filter(t=>!ordered.includes(t)).sort();
  return [...ordered, ...rest];
}

function renderSidebar(){
  const sb = document.getElementById('sidebar');
  const freqCounts = {};
  follows.forEach(f=>{ freqCounts[f.freq] = (freqCounts[f.freq]||0)+1; });
  const suspendedCount = follows.filter(f=>f.suspended).length;
  const favoriteCount = follows.filter(f=>f.favorite).length;

  let html = `<div class="sb-total">計 ${follows.length}件</div>`;

  // 頻度フィルター（横並びの小さなピルで省スペース化。カード側のfreq-pillと同じ配色）
  html += `<div class="sb-section">頻度</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:5px;padding:0 1.25rem 8px">`;
  FREQS.forEach(fr=>{
    const cnt = freqCounts[fr] || 0;
    if(!cnt) return;
    const pillClass = FREQ_PILL[fr] || '';
    html += `<button class="freq-pill sb-freq-chip ${pillClass}${activeFreq===fr?' active':''}" data-click="1" data-action="setFreq" data-args="${dargs([fr])}">${freqLabel(fr)} ${cnt}</button>`;
  });
  if(activeFreq){
    html += `<button class="freq-pill sb-freq-chip" data-click="1" data-action="setFreq" data-args="${dargs([null])}">すべて</button>`;
  }
  html += `</div>`;

  // 個別指定（取得時刻が設定されたチャンネル）を別枠で表示
  const scheduledCount = follows.filter(f=>f.fetchTimes && f.fetchTimes.length>0).length;
  if(scheduledCount > 0){
    html += `<div class="sb-divider"></div>`;
    html += `<button class="sb-btn sb-btn-special${activeTag==='__scheduled__'?' active':''}" data-click="1" data-action="setTag" data-args="${dargs(['__scheduled__'])}">
      <div class="sb-dot" style="background:var(--accent-mid)"></div>個別指定
      <span class="sb-count">${scheduledCount}</span>
    </button>`;
  }

  // お気に入り・更新外（状態セクション）
  if(favoriteCount > 0 || suspendedCount > 0){
    html += `<div class="sb-section" style="margin-top:0.5rem">状態</div>`;
    if(favoriteCount > 0){
      html += `<button class="sb-btn${activeTag==='__favorite__'?' active':''}" data-click="1" data-action="setTag" data-args="${dargs(['__favorite__'])}">
        <div class="sb-dot" style="background:linear-gradient(135deg,#E00 25%,#07C 25%,#07C 50%,#080 50%,#080 75%,#E6B800 75%)"></div>マーク済み
        <span class="sb-count">${favoriteCount}</span>
      </button>`;
      // 色ごとの内訳を横並びの小さなスウォッチで表示（省スペース）。
      // カーソルを乗せると色名・件数がツールチップで出る。クリックでその色に絞り込める
      html += `<div style="display:flex;gap:8px;padding:2px 1.25rem 8px 2.25rem">`;
      Object.entries(MARK_COLORS).forEach(([key, val])=>{
        const markCnt = follows.filter(f=>f.markColor===key).length;
        if(!markCnt) return;
        const markTag = `__mark_${key}__`;
        const textColor = key==='yellow' ? val.darkBg : '#fff';
        html += `<button class="sb-mark-swatch${activeTag===markTag?' active':''}" data-click="1" data-action="setTag" data-args="${dargs([markTag])}"
          title="${val.label}マーク（${markCnt}件）"
          style="background:${val.border};color:${textColor}">${markCnt}</button>`;
      });
      html += `</div>`;
    }
    if(suspendedCount > 0){
      html += `<button class="sb-btn${activeTag==='__suspended__'?' active':''}" data-click="1" data-action="setTag" data-args="${dargs(['__suspended__'])}">
        <div class="sb-dot" style="background:#999"></div>更新外
        <span class="sb-count">${suspendedCount}</span>
      </button>`;
    }
  }

  // タグフィルター（ドラッグ&ドロップ対応）
  const sortedTags = getSortedTags();
  if(sortedTags.length){
    html += `<div class="sb-section" style="margin-top:0.75rem;display:flex;align-items:center;justify-content:space-between">
      <span>タグ</span>
      <span style="font-size:10px;color:var(--text-faint)">ドラッグで並び替え</span>
    </div>`;
    html += `<button class="sb-btn${activeTag==='すべて'?' active':''}" data-click="1" data-action="setTag" data-args="${dargs(['すべて'])}">
      <div class="sb-dot"></div>すべて
      <span class="sb-count">${follows.length}</span>
    </button>`;
    html += `<div id="tagList">`;
    sortedTags.forEach(t=>{
      const cnt = follows.filter(f=>f.tags.includes(t)).length;
      html += `<button class="sb-btn sb-tag-draggable${activeTag===t?' active':''}"
        data-tag="${esc(t)}"
        draggable="true"
        data-click="1" data-action="setTag" data-args="${dargs([t])}">
        <div class="sb-drag-handle" title="ドラッグして並び替え">⠿</div>
        ${esc(t)}
        <span class="sb-count">${cnt}</span>
      </button>`;
    });
    html += `</div>`;
  }

  sb.innerHTML = html;

  // ドラッグ&ドロップのイベント設定
  initTagDragDrop();
}

function initTagDragDrop(){
  const tagList = document.getElementById('tagList');
  if(!tagList) return;
  const btns = tagList.querySelectorAll('.sb-tag-draggable');
  let dragSrc = null;

  btns.forEach(btn=>{
    btn.addEventListener('dragstart', e=>{
      dragSrc = btn;
      btn.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    btn.addEventListener('dragend', e=>{
      btn.style.opacity = '';
      tagList.querySelectorAll('.sb-tag-draggable').forEach(b=>b.classList.remove('drag-over'));
    });
    btn.addEventListener('dragover', e=>{
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if(btn !== dragSrc){
        tagList.querySelectorAll('.sb-tag-draggable').forEach(b=>b.classList.remove('drag-over'));
        btn.classList.add('drag-over');
      }
    });
    btn.addEventListener('drop', e=>{
      e.preventDefault();
      if(btn === dragSrc) return;
      const tags = getSortedTags();
      const fromTag = dragSrc.dataset.tag;
      const toTag = btn.dataset.tag;
      const fromIdx = tags.indexOf(fromTag);
      const toIdx = tags.indexOf(toTag);
      tags.splice(fromIdx, 1);
      tags.splice(toIdx, 0, fromTag);
      tagOrder = tags;
      saveTagOrder();
      renderSidebar();
    });
  });
}

function dayLabel(date){
  if(!date) return '日付不明';
  const now = new Date();
  const d = new Date(date);
  const diffDays = Math.floor((now - d) / 86400000);
  if(diffDays === 0) return '今日';
  if(diffDays === 1) return '昨日';
  if(diffDays < 7) return `${diffDays}日前`;
  return d.toLocaleDateString('ja-JP', {month:'long', day:'numeric'});
}


function renderTimeline(filtered, mode){
  // 全フォローの全投稿を1つの配列に展開
  const allPosts = [];
  filtered.forEach(f=>{
    const c = colorOf(f);
    const bg = isDark() ? c.dark_bg : c.bg;
    const fg = isDark() ? c.dark_fg : c.fg;
    (f.posts||[]).forEach(p=>{
      allPosts.push({...p, follow:f, bg, fg});
    });
  });

  if(allPosts.length === 0){
    return `<div class="empty"><h2>動画がありません</h2><p>↻ 更新してフィードを取得してください。</p></div>`;
  }

  // ソート
  if(mode === 'duration-desc'){
    allPosts.sort((a,b)=>{
      // duration<=0（Live/予定/未取得）は末尾
      const da = (a.duration > 0) ? a.duration : -1;
      const db = (b.duration > 0) ? b.duration : -1;
      if(da < 0 && db < 0) return 0;
      if(da < 0) return 1;
      if(db < 0) return -1;
      return db - da;
    });
  } else if(mode === 'duration-asc'){
    allPosts.sort((a,b)=> {
      // duration<=0（Live/予定/未取得）は末尾
      const da = (a.duration > 0) ? a.duration : Infinity;
      const db = (b.duration > 0) ? b.duration : Infinity;
      return da - db;
    });
  } else {
    // latest: 新着順
    allPosts.sort((a,b)=>{
      if(!a.date && !b.date) return 0;
      if(!a.date) return 1;
      if(!b.date) return -1;
      return b.date - a.date;
    });
  }

  // 新着順・長さ順でグループラベルを出し分け
  const useDayGroup = (mode === 'latest');

  if(useDayGroup){
    // 日付ごとにグループ化
    const groups = {};
    const groupOrder = [];
    allPosts.forEach(p=>{
      const key = p.date ? p.date.toDateString() : '__nodate__';
      const label = dayLabel(p.date);
      if(!groups[key]){ groups[key]=[]; groupOrder.push({key,label}); }
      groups[key].push(p);
    });
    let html = '';
    groupOrder.forEach(({label})=>{
      html += `<div class="tl-day-label">${label}</div>`;
      groups[label] || (groups[label] = groups[Object.keys(groups).find(k=>dayLabel(new Date(k))===label)||'']);
    });
    // グループ順に描画
    let rendered = '';
    groupOrder.forEach(({key,label})=>{
      rendered += `<div class="tl-day-label">${label}</div>`;
      groups[key].forEach(p=>{ rendered += tlCard(p, mode); });
    });
    return rendered;
  } else {
    // フラット表示（長い順・短い順）
    const modeLabel = mode==='duration-desc' ? '長い順' : '短い順';
    return `<div class="tl-day-label">${modeLabel}</div>`
      + allPosts.map(p=>tlCard(p, mode)).join('');
  }
}

function tlCard(p, mode){
  const dur = fmtDuration(p.duration);
  const dateStr = fmtDatetime(p.date);
  const isShort = p.link && p.link.includes('/shorts/');
  const liveBadge = getLiveBadge(p);
  const durAttr = liveBadge ? liveBadge.attr : isShort ? ' data-short="true"' : '';
  const durText = liveBadge ? liveBadge.text : isShort ? `[ショート]${dur ? ' '+dur : ''}` : dur;
  // YouTubeサムネイル取得
  const ytVideoId = p.link?.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1]
    || p.link?.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/)?.[1];
  const thumbHtml = ytVideoId
    ? `<img src="https://i.ytimg.com/vi/${ytVideoId}/default.jpg"
        alt="" loading="lazy"
        data-error-action="hideSelf"
        style="width:60px;height:34px;object-fit:cover;border-radius:4px;flex-shrink:0">`
    : '';

  const tlMarkColor = p.follow.markColor && MARK_COLORS[p.follow.markColor] ? MARK_COLORS[p.follow.markColor] : null;
  return `<div class="tl-card">
    <div class="tl-avatar" style="background:${p.bg};color:${p.fg};border:2px solid ${tlMarkColor ? tlMarkColor.border : 'transparent'}">
      ${p.follow.iconUrl ? `<img src="${esc(iconSrc(p.follow))}" alt="${esc(p.follow.initials)}" data-error-action="hideSelf" style="width:100%;height:100%;object-fit:cover;border-radius:6px;position:absolute;inset:0">` : ''}
      ${p.follow.initials}
    </div>
    <div class="tl-body">
      <div class="tl-channel" style="cursor:pointer" title="チャンネル設定を開く"
        data-click="1" data-action="openChannelFromTimeline" data-args="${dargs([p.follow.id])}">${esc(p.follow.name)}</div>
      <div class="tl-title">
        ${dateStr ? `<span class="tl-datetime">${esc(dateStr)}</span>` : ''}
        <a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      </div>
    </div>
    ${thumbHtml ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" style="flex-shrink:0">${thumbHtml}</a>` : ''}
    <div class="tl-right">
      ${durText ? `<span class="tl-dur"${durAttr}>${durText}</span>` : ''}
    </div>
  </div>`;
}

/* 仮想スクロール用ページング */
let currentPage = 0;
const PAGE_SIZE = 30; // 一度に表示する件数
let currentFiltered = []; // 現在のフィルター済みリスト

let infiniteScrollObserver = null;

function renderChannelList(list, append=false){
  const main = document.getElementById('main');
  if(!append){
    main.innerHTML = '';
    currentPage = 0;
    // 既存のObserverを解除
    if(infiniteScrollObserver){ infiniteScrollObserver.disconnect(); infiniteScrollObserver=null; }
  }
  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const chunk = list.slice(start, end);

  let html = chunk.map(f=>renderFollowCard(f)).join('');

  // 続きがあればセンチネル要素を追加（ボタンの代わり）
  if(end < list.length){
    html += `<div id="scroll-sentinel" style="height:40px;display:flex;align-items:center;justify-content:center">
      <div class="fc-spinner"></div>
    </div>`;
  }

  if(append){
    const sentinel = document.getElementById('scroll-sentinel');
    if(sentinel) sentinel.outerHTML = html;
    else main.insertAdjacentHTML('beforeend', html);
  } else {
    main.innerHTML = html;
  }
  currentPage++;

  // 次のページがあればIntersectionObserverをセット
  if(end < list.length){
    const sentinel = document.getElementById('scroll-sentinel');
    if(sentinel){
      infiniteScrollObserver = new IntersectionObserver(entries=>{
        if(entries[0].isIntersecting){
          infiniteScrollObserver.disconnect();
          infiniteScrollObserver = null;
          renderChannelList(list, true);
        }
      }, {root: main, rootMargin:'100px'});
      infiniteScrollObserver.observe(sentinel);
    }
  }
}

function loadMoreChannels(){
  renderChannelList(currentFiltered, true);
}

function renderMain(){
  const main = document.getElementById('main');
  let filtered = follows.filter(f=>{
    // 検索クエリがある場合は検索のみで絞り込む
    if(searchQuery){
      const q = normalizeForSearch(searchQuery);
      // アルファベットのみの入力なら、ローマ字読み間違いを想定してひらがな変換版でも照合する
      const qKana = /^[a-z]+$/.test(searchQuery.trim().toLowerCase()) ? romajiToHiragana(searchQuery) : '';
      const matchStr = (str)=>{
        if(!str) return false;
        const norm = normalizeForSearch(str);
        return norm.includes(q) || (!!qKana && norm.includes(qKana));
      };
      return matchStr(f.name) || matchStr(f.memo) || f.tags.some(t=>matchStr(t));
    }
    if(activeTag === '__suspended__') return f.suspended;
    if(activeTag === '__favorite__') return f.favorite;
    if(activeTag === '__scheduled__') return f.fetchTimes && f.fetchTimes.length>0;
    // マーク色ごとの絞り込み（例: __mark_yellow__ → markColorが'yellow'のものだけ表示）
    if(activeTag && activeTag.startsWith('__mark_')) return f.markColor === activeTag.slice(7, -2);
    if(activeTag !== 'すべて' && !f.tags.includes(activeTag)) return false;
    if(activeFreq && f.freq !== activeFreq) return false;
    return true;
  });

  if(follows.length===0){
    main.innerHTML = `<div class="empty">
      <h2>フォローしていません</h2>
      <p>「+ 追加」からRSSフィードのURLを入力して<br>フォローを開始しましょう。</p>
    </div>`;
    return;
  }
  if(filtered.length===0){
    main.innerHTML = `<div class="empty"><h2>該当なし</h2><p>フィルターを変更してください。</p></div>`;
    return;
  }

  if(sortMode === 'freq'){
    filtered.sort((a,b)=>{
      const da = a.posts?.[0]?.date || new Date(0);
      const db = b.posts?.[0]?.date || new Date(0);
      return db - da;
    });
    currentFiltered = filtered;
    renderChannelList(filtered);
  } else if(sortMode === 'registered-desc' || sortMode === 'registered-asc'){
    filtered.sort((a,b)=>{
      const da = a.registeredAt || a.id;
      const db = b.registeredAt || b.id;
      return sortMode === 'registered-desc' ? db - da : da - db;
    });
    currentFiltered = filtered;
    renderChannelList(filtered);
  } else if(sortMode === 'subscribers-desc'){
    filtered.sort((a,b)=>(b.subscriberCount||0)-(a.subscriberCount||0));
    currentFiltered = filtered;
    renderChannelList(filtered);
  } else if(sortMode === 'fetched-desc' || sortMode === 'fetched-asc'){
    filtered.sort((a,b)=>{
      const fa = a.lastFetched || 0;
      const fb = b.lastFetched || 0;
      return sortMode === 'fetched-desc' ? fb - fa : fa - fb;
    });
    currentFiltered = filtered;
    renderChannelList(filtered);
  } else {
    main.innerHTML = renderTimeline(filtered, sortMode);
  }
}

/* ── Modal ── */
function openModal(){
  showModal = true;
  formData = {name:'',url:'',platform:'RSS/ブログ',freq:'6時間',tags:'',memo:'',colorIdx: Math.floor(Math.random()*COLORS.length)};
  renderModal();
}
function closeModal(){ showModal=false; document.getElementById('modalContainer').innerHTML=''; }

function renderModal(){
  if(!showModal){document.getElementById('modalContainer').innerHTML='';return;}

  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeModal"]'>
    <div class="modal">
      <h2>フォローを追加</h2>
      <div class="form-row">
        <label class="form-label">RSS / Atom フィード URL</label>
        <input class="form-input" id="f-url" type="url" value="${esc(formData.url)}"
          data-input="1" data-action="handleUrlInput" data-args='["@value"]'
          placeholder="https://example.com/feed">
        <div class="form-hint" id="f-url-status" style="min-height:16px">URLを入力すると名前を自動取得します</div>
      </div>
      <div class="form-row">
        <label class="form-label">名前</label>
        <input class="form-input" id="f-name" type="text" value="${esc(formData.name)}"
          data-input="1" data-action="handleNameInput" data-args='["@value"]' placeholder="URLを入力後に自動入力されます">
      </div>

      <div class="form-row">
        <label class="form-label">チェック頻度</label>
        <select class="form-select" id="f-freq" data-change="1" data-action="handleFreqSelect" data-args='["@value"]'>
          ${FREQS.map(f=>`<option${f===formData.freq?' selected':''}>${f}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label class="form-label">タグ</label>
        <input class="form-input" id="f-tags" type="text" value="${esc(formData.tags)}"
          data-input="1" data-action="handleTagsInput" data-args='["@value"]'
          data-focus="1" data-action-focus="showTagSuggestions" data-args-focus='["@value"]'
          data-blur="1" data-action-blur="handleTagsBlur"
          placeholder="例: tech, news（スペース・カンマ区切り）"
          autocomplete="off">
        <div id="tag-suggestions" style="display:none;position:absolute;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);max-height:160px;overflow-y:auto;width:100%"></div>
      </div>
      <div class="form-row">
        <label class="form-label">メモ（任意）</label>
        <textarea class="form-input" id="f-memo" rows="1"
          data-input="1" data-action="handleMemoInput" data-args='["@value"]'
          placeholder="このチャンネルに関するメモや備考..."
          style="resize:none;line-height:1.5">${esc(formData.memo)}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeModal">キャンセル</button>
        <button class="btn-ok" data-click="1" data-action="addFollow">追加して取得</button>
      </div>
    </div>
  </div>`;
}

async function addFollow(){
  let url = document.getElementById('f-url').value.trim();
  const name = document.getElementById('f-name').value.trim() || url;
  if(!url){ alert('URLは必須です'); return; }

  // 引用符・空白・山括弧など、URLに混入しやすい不正な文字が含まれていないか確認
  // （コピー元のHTML属性などから引用符ごとコピーしてしまうミスを早期に検出する）
  const badCharMatch = url.match(/["'<>\s]/);
  if(badCharMatch){
    alert(`URLに使用できない文字（${JSON.stringify(badCharMatch[0])}）が含まれています。\nコピー元から余分な文字が混ざっていないか確認してください。\n\n${url}`);
    return;
  }

  // YouTubeのチャンネルURL等をRSS形式に自動変換（HTML解析まで粘る）
  if(/youtube\.com|youtu\.be/.test(url) && !/feeds\/videos\.xml/.test(url)){
    const btn = document.querySelector('.btn-ok');
    const orig = btn ? btn.textContent : '';
    if(btn){ btn.textContent = 'RSS検索中…'; btn.disabled = true; }
    try{
      const resolved = await resolveYouTubeFeed(url);
      if(/feeds\/videos\.xml/.test(resolved)){
        url = resolved;
      } else {
        if(btn){ btn.textContent = orig; btn.disabled = false; }
        addFetchLog({id:null, name: name || url, ok:false, error:'RSSフィードを見つけられませんでした（登録時）', stage:'add'});
        alert('このURLからRSSフィードを見つけられませんでした。\nチャンネルページの「/channel/UC...」形式のURL、またはRSS URLを直接入力してください。');
        return;
      }
    }catch(e){
      if(btn){ btn.textContent = orig; btn.disabled = false; }
      addFetchLog({id:null, name: name || url, ok:false, error:'RSS検索に失敗（登録時）: '+e.message, stage:'add'});
      alert('RSS検索に失敗しました: ' + e.message);
      return;
    }
    if(btn){ btn.textContent = orig; btn.disabled = false; }
  }

  // 登録前に実際にRSSとして取得・解析できるかを確認する。
  // ここで失敗する場合はURLが誤っている可能性が高いため、登録せずエラーを表示して修正を促す。
  {
    const btn = document.querySelector('.btn-ok');
    const orig = btn ? btn.textContent : '';
    if(btn){ btn.textContent = '確認中…'; btn.disabled = true; }
    const preCheckStart = Date.now();
    try{
      const raw = await fetchRSSRaw(url);
      const {posts} = parseRSS(raw);
      if(!posts.length){
        if(btn){ btn.textContent = orig; btn.disabled = false; }
        addFetchLog({id:null, name: name || url, ok:false, proxy:lastUsedProxy, error:'記事を1件も取得できませんでした（登録時）', ms:Date.now()-preCheckStart, attempts:lastProxyAttempts.slice(), stage:'add'});
        alert('このURLからは記事を1件も取得できませんでした。\nURLが正しいかご確認のうえ、修正して登録してください。\n\n' + url);
        return;
      }
    }catch(e){
      if(btn){ btn.textContent = orig; btn.disabled = false; }
      addFetchLog({id:null, name: name || url, ok:false, proxy:lastUsedProxy, error:'登録時の取得エラー: '+e.message, ms:Date.now()-preCheckStart, attempts:lastProxyAttempts.slice(), stage:'add'});
      alert('このURLの取得に失敗しました: ' + e.message + '\nURLが正しいかご確認のうえ、修正して登録してください。\n\n' + url);
      return;
    }
    if(btn){ btn.textContent = orig; btn.disabled = false; }
  }

  // 重複チェック
  const duplicate = follows.find(f => f.url === url);
  if(duplicate){
    const msg = `「${duplicate.name}」として既に登録されています。\n\n重複して登録しますか？`;
    if(!confirm(msg)) return;
  }

  // 名前の類似チェック（URLが違っても名前が似ている場合）
  if(!duplicate && name !== url){
    const nameLower = name.toLowerCase();
    const similar = follows.filter(f => {
      const fName = f.name.toLowerCase();
      return fName.includes(nameLower) || nameLower.includes(fName);
    });
    if(similar.length > 0){
      const msg = `似た名前のチャンネルが既に登録されています：\n${similar.slice(0,3).map(f=>`・${f.name}`).join('\n')}\n\n続けて登録しますか？`;
      if(!confirm(msg)) return;
    }
  }
  const tags = splitTags(document.getElementById('f-tags').value);
  const memo = document.getElementById('f-memo')?.value.trim() || '';
  const initials = name.split(/[\s\/\-_]+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase().slice(0,2) || '??';
  const f = {
    id: Date.now(),
    registeredAt: Date.now(),
    name, url,
    platform: url.includes('youtube.com')||url.includes('youtu.be') ? 'YouTube' : url.includes('spotify.com')||url.includes('anchor.fm')||url.includes('simplecast') ? 'Podcast' : 'RSS/ブログ',
    freq: document.getElementById('f-freq').value,
    tags: tags.length ? tags : ['一般'],
    colorIdx: formData.colorIdx,
    initials,
    memo,
    posts: [],
    loading: false,
    lastFetched: null,
    error: null,
  };
  follows.push(f);
  save();
  closeModal();
  render();
  enqueueFetch(f);
}

function delFollow(id){
  if(!confirm('このフォローを削除しますか？')) return;
  follows = follows.filter(f=>f.id!==id);
  if(expanded===id) expanded=null;
  save();
  render();
}

function toggleExpand(id){
  const main = document.getElementById('main');
  const prevScrollTop = main ? main.scrollTop : 0;

  // 閉じる場合は展開前のカード位置を記憶
  const prevCard = expanded === id ? document.getElementById(`fc-${id}`) : null;
  const prevCardTop = prevCard ? prevCard.getBoundingClientRect().top : 0;
  const isClosing = expanded === id;

  skipScrollRestore = true;
  expanded = expanded === id ? null : id;

  // 検索で見つけたチャンネルを開いて編集し、そのカードを閉じたタイミングで
  // 検索条件が残っていれば自動的にクリアする（×ボタンを押したのと同じ状態にする）
  if(isClosing && searchQuery){
    searchQuery = '';
    const input = document.getElementById('searchInput');
    if(input) input.value = '';
    const clr = document.getElementById('searchClear');
    if(clr) clr.style.display = 'none';
  }

  render();

  if(!main) return;

  if(expanded === id){
    // 展開した場合：カードが見えるようにスクロール
    requestAnimationFrame(()=>{
      const card = document.getElementById(`fc-${id}`);
      if(card){
        const cardRect = card.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        // カードが画面外なら見える位置に移動
        if(cardRect.top < mainRect.top || cardRect.bottom > mainRect.bottom){
          card.scrollIntoView({behavior:'smooth', block:'nearest'});
        }
      }
    });
  } else {
    // 閉じた場合：スクロール位置を維持
    requestAnimationFrame(()=>{
      main.scrollTop = prevScrollTop;
    });
  }
}

// 新着順等のタイムライン表示（動画単位）からチャンネル名をクリックした時、
// そのチャンネルの設定パネルを開く。タイムライン表示にはチャンネル単位の
// カードが存在しないため、まず「📋 チャンネル順」表示に切り替えてから
// 該当チャンネルを展開する（検索中であれば検索条件は維持したまま）。
function openChannelFromTimeline(id){
  sortMode = 'freq';
  expanded = id;
  skipScrollRestore = true;
  render();
  requestAnimationFrame(()=>{
    const card = document.getElementById(`fc-${id}`);
    if(card) card.scrollIntoView({behavior:'smooth', block:'nearest'});
  });
}

function setTag(t){
  activeTag=t;
  // 特殊フィルター選択時は頻度フィルターをクリア
  if(t==='__scheduled__' || t==='__suspended__' || t==='__favorite__') activeFreq=null;
  render();
}
function setFreq(f){ activeFreq=f; render(); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// data-args属性用: 配列をJSONにしてHTML属性として安全な形にエスケープする
// （文字列に引用符や&などが含まれていても安全に埋め込める）
function dargs(arr){ return esc(JSON.stringify(arr)); }

// アイコン画像のsrcを組み立てる。
// YouTube/Googleのサムネイル画像はキャッシュ回避用の?vパラメータを付けても問題ないが、
// X(Twitter)のpbs.twimg.comなど、想定外のクエリパラメータが付くと画像を返さないCDNもあるため、
// そういったURLにはパラメータを付けずそのまま使う。
function iconSrc(f){
  if(!f || !f.iconUrl) return '';
  if(/ytimg\.com|googleusercontent\.com/i.test(f.iconUrl)){
    return `${f.iconUrl}?v=${f.id}`;
  }
  return f.iconUrl;
}

/* ── Import ── */
function parseImportText(text){
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const items = [];
  let currentTag = '一般';

  for(const line of lines){
    // タグ行: #キャンプ
    if(line.startsWith('#')){
      currentTag = line.slice(1).trim() || '一般';
      continue;
    }
    // URL + 名前 or 名前 + URL
    const urlMatch = line.match(/https?:\/\/\S+/);
    if(!urlMatch) continue;
    const url = urlMatch[0];
    const rest = line.replace(url, '').trim();
    const name = rest || url;
    items.push({url, name, tag: currentTag});
  }
  return items;
}

let importText = '';

function openImportModal(){
  importText = '';
  renderImportModal();
}

function renderImportModal(){
  const parsed = parseImportText(importText);
  const existingUrls = new Set(follows.map(f=>f.url));
  const newItems = parsed.filter(p=>!existingUrls.has(p.url));
  const dupItems = parsed.filter(p=>existingUrls.has(p.url));

  let previewHtml = '';
  if(!importText.trim()){
    previewHtml = `<div class="ip-empty">テキストを貼り付けるとプレビューが表示されます</div>`;
  } else if(parsed.length === 0){
    previewHtml = `<div class="ip-empty">URLが見つかりませんでした</div>`;
  } else {
    previewHtml = parsed.map(p=>{
      const dup = existingUrls.has(p.url);
      return `<div class="ip-row">
        <span class="ip-tag">${esc(p.tag)}</span>
        <span class="ip-name">${esc(p.name)}</span>
        <span class="ip-url">${esc(p.url.replace('https://www.youtube.com/feeds/videos.xml?channel_id=','yt:'))}</span>
        ${dup ? '<span class="ip-dup">登録済み</span>' : ''}
      </div>`;
    }).join('');
  }

  const summaryHtml = parsed.length > 0
    ? `<div class="import-summary">
        合計 <b>${parsed.length}</b> 件 &nbsp;／&nbsp;
        新規 <b>${newItems.length}</b> 件 &nbsp;／&nbsp;
        重複スキップ ${dupItems.length} 件
       </div>`
    : '';

  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeImportModal"]'>
    <div class="modal" style="width:520px">
      <h2>一括インポート</h2>
      <div class="form-row">
        <label class="form-label">テキストを貼り付け</label>
        <textarea class="import-textarea" id="import-ta"
          placeholder="#タグ名&#10;https://... チャンネル名&#10;https://... チャンネル名&#10;&#10;#別のタグ&#10;https://..."
          data-input="1" data-action="handleImportTextInput" data-args='["@value"]'>${esc(importText)}</textarea>
        <div class="form-hint">
          # から始まる行はタグ、URLの後ろにチャンネル名を書く形式に対応しています
        </div>
      </div>
      <div class="import-preview">${previewHtml}</div>
      ${summaryHtml}
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeImportModal">キャンセル</button>
        <button class="btn-ok" ${newItems.length===0?'disabled style="opacity:0.4;cursor:not-allowed"':''} data-click="1" data-action="execImport">
          ${newItems.length} 件を登録
        </button>
      </div>
    </div>
  </div>`;

  // テキストエリアにフォーカス＆カーソルを末尾に
  const ta = document.getElementById('import-ta');
  if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function closeImportModal(){
  document.getElementById('modalContainer').innerHTML='';
}

function execImport(){
  const parsed = parseImportText(importText);
  const existingUrls = new Set(follows.map(f=>f.url));
  const newItems = parsed.filter(p=>!existingUrls.has(p.url));
  if(newItems.length === 0) return;

  const newFollows = newItems.map((p, i) => {
    const name = p.name;
    const initials = name.split(/[\s\/\-_]+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase().slice(0,2) || '??';
    return {
      id: Date.now() + i,
      registeredAt: Date.now() + i,
      name, url: p.url,
      platform: p.url.includes('youtube.com') ? 'YouTube' : 'RSS/ブログ',
      freq: '6時間',
      tags: [p.tag],
      colorIdx: (follows.length + i) % COLORS.length,
      initials,
      posts: [],
      loading: false,
      lastFetched: null,
      error: null,
    };
  });

  follows.push(...newFollows);
  save();
  closeImportModal();
  render();

  // 順番にフェッチ（一気に全部飛ばさず少し間隔を空ける）
  newFollows.forEach((f, i) => {
    setTimeout(() => enqueueFetch(f), i * 300);
  });
}


/* ── チャンネルアイコン取得 ── */
function ytChannelIdFromUrl(url){
  const m = url.match(/channel_id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// YouTubeのチャンネルURL等をRSSフィードURLに変換（最終的にHTML解析まで粘る）
async function resolveYouTubeFeed(input){
  let url = input.trim();
  // 既にRSS形式ならそのまま
  if(/feeds\/videos\.xml\?channel_id=/.test(url)) return url;
  // channel/UC... 形式 → 即変換
  let m = url.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/);
  if(m) return `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`;
  // playlist は playlist_id フィードに
  m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if(m) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${m[1]}`;
  // YouTube以外はそのまま（一般RSS）
  if(!/youtube\.com|youtu\.be/.test(url)) return url;

  // @ハンドル・/c/・/user/ 形式 → APIで検索してID取得（APIキーがあれば）
  const handleMatch = url.match(/youtube\.com\/@([A-Za-z0-9_.\-]+)/);
  if(handleMatch && ytApiKey){
    try{
      const q = handleMatch[1];
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent('@'+q)}&maxResults=1&key=${ytApiKey}`);
      if(r.ok){
        const d = await r.json();
        const cid = d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId;
        if(cid) return `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`;
      }
    }catch(e){ /* 次の手段へ */ }
  }

  // 最終手段: チャンネルページのHTMLをプロキシ経由で取得し、channelIdを抜き出す
  try{
    const raw = await fetchRSSRaw(url); // 既存のプロキシ取得を流用
    const html = typeof raw === 'string' ? raw : (raw?.contents || '');
    // HTML内の "channelId":"UC..." / "externalId":"UC..." / channel/UC... を順に探す
    let cm = html.match(/"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]+)"/);
    if(!cm) cm = html.match(/channel\/(UC[A-Za-z0-9_-]+)/);
    if(!cm) cm = html.match(/(UC[A-Za-z0-9_-]{20,})/);
    if(cm) return `https://www.youtube.com/feeds/videos.xml?channel_id=${cm[1]}`;
  }catch(e){ /* 諦める */ }

  // 変換できなければ元のURLを返す（呼び出し側で判断）
  return url;
}

async function fetchIconForFollow(f){
  if(!ytApiKey) return;
  if(f.iconUrl) return; // 取得済みはスキップ
  const chId = ytChannelIdFromUrl(f.url);
  if(!chId) return;
  try{
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${chId}&key=${ytApiKey}`,
      {signal: AbortSignal.timeout(10000)}
    );
    if(!res.ok) return;
    const json = await res.json();
    const iconUrl = json.items?.[0]?.snippet?.thumbnails?.default?.url;
    const subCount = json.items?.[0]?.statistics?.subscriberCount;
    if(subCount != null){ f.subscriberCount = parseInt(subCount); f.subscriberFetchedAt = Date.now(); }
    if(iconUrl){
      f.iconUrl = iconUrl;
      save(true, false); // 自動取得（毎回のRSS取得後に付随して走る）のためユーザー編集扱いにしない
      // アバターを即時更新
      const avatarEl = document.querySelector(`#fc-${f.id} .fc-avatar img`);
      if(avatarEl){ avatarEl.src = iconUrl; }
      else {
        const av = document.querySelector(`#fc-${f.id} .fc-avatar`);
        if(av){ av.insertAdjacentHTML('afterbegin', `<img src="${iconUrl}" data-error-action="hideSelf">`); }
      }
    }
  }catch(e){}
}

async function bulkFetchIcons(){
  if(!ytApiKey){ openApiKeyModal(); return; }

  const targets = follows.filter(f => !f.iconUrl && ytChannelIdFromUrl(f.url));
  if(!targets.length){
    setStatus('ok', 'アイコン取得済みです'); return;
  }

  setStatus('loading', `アイコンを取得中... 0/${targets.length}件`);
  const CHUNK = 50;
  let done = 0;

  for(let i=0; i<targets.length; i+=CHUNK){
    const chunk = targets.slice(i, i+CHUNK);
    const ids = chunk.map(f=>ytChannelIdFromUrl(f.url)).join(',');
    try{
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids}&key=${ytApiKey}&maxResults=50`,
        {signal: AbortSignal.timeout(15000)}
      );
      if(!res.ok){
        const err = await res.json().catch(()=>({}));
        setStatus('err', `APIエラー: ${err.error?.message||res.status}`);
        return;
      }
      const json = await res.json();
      const itemMap = {};
      (json.items||[]).forEach(item=>{ itemMap[item.id]=item; });
      chunk.forEach(f=>{
        const chId = ytChannelIdFromUrl(f.url);
        const item = itemMap[chId];
        const iconUrl = item?.snippet?.thumbnails?.default?.url;
        if(iconUrl){ f.iconUrl = iconUrl; done++; }
        const subCount = item?.statistics?.subscriberCount;
        if(subCount != null){ f.subscriberCount = parseInt(subCount); f.subscriberFetchedAt = Date.now(); }
      });
      save(false); // ループ中はlocalStorageのみ（GitHub連続コミット防止）
      setStatus('loading', `アイコンを取得中... ${done}/${targets.length}件`);
      if(i+CHUNK < targets.length) await new Promise(r=>setTimeout(r,200));
    }catch(e){
      setStatus('err', `取得エラー: ${e.message}`); return;
    }
  }

  debouncedRender();
  save(); // 完了後に1回だけGitHub同期
  setStatus('ok', `アイコンを取得しました（${done}件）`);
}

/* ── 頻度一括変更 ── */
let bulkFreqSelected = '5分';
let bulkTagSelected = null; // null=すべて

const FREQ_DESC = {
  '5分':   '5分ごとにチェック',
  '15分':  '15分ごとにチェック',
  '30分':  '30分ごとにチェック',
  '1時間': '1時間ごとにチェック',
  '6時間': '6時間ごとにチェック',
};

function openBulkFreqModal(){
  bulkFreqSelected = '5分';
  bulkTagSelected = null;
  renderBulkFreqModal();
}

function closeBulkFreqModal(){
  document.getElementById('modalContainer').innerHTML = '';
}

function bulkFreqTargetCount(){
  return follows.filter(f =>
    bulkTagSelected === null || f.tags.includes(bulkTagSelected)
  ).length;
}

function renderBulkFreqModal(){
  const allTags = [...new Set(follows.flatMap(f => f.tags))];
  const count = bulkFreqTargetCount();

  const freqOptions = FREQS.map(fr => `
    <div class="freq-option${fr === bulkFreqSelected ? ' selected' : ''}"
         data-click="1" data-action="selectBulkFreq" data-args="${dargs([fr])}">
      <div>
        <div class="freq-option-label">${freqLabel(fr)}</div>
        <div class="freq-option-desc">${FREQ_DESC[fr]}</div>
      </div>
      <span class="freq-option-check">✓</span>
    </div>`).join('');

  const tagBtns = [
    `<button class="bulk-tag-btn${bulkTagSelected===null?' selected':''}"
       data-click="1" data-action="selectBulkTag" data-args="${dargs([null])}">すべて</button>`,
    ...allTags.map(t =>
      `<button class="bulk-tag-btn${bulkTagSelected===t?' selected':''}"
         data-click="1" data-action="selectBulkTag" data-args="${dargs([t])}">${t}</button>`)
  ].join('');

  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeBulkFreqModal"]'>
    <div class="modal">
      <h2>頻度を一括変更</h2>
      <div class="form-row">
        <label class="form-label">変更後の頻度</label>
        <div class="freq-grid">${freqOptions}</div>
      </div>
      <div class="bulk-target">
        <span class="bulk-target-label">対象タグで絞り込む</span>
        <div class="bulk-tag-list">${tagBtns}</div>
        <div class="bulk-summary">
          対象: <b>${count}</b> 件のフォローを「<b>${bulkFreqSelected}</b>」に変更します
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeBulkFreqModal">キャンセル</button>
        <button class="btn-ok" data-click="1" data-action="execBulkFreq">
          ${count}件に適用
        </button>
      </div>
    </div>
  </div>`;
}

function execBulkFreq(){
  const targets = follows.filter(f =>
    bulkTagSelected === null || f.tags.includes(bulkTagSelected)
  );
  targets.forEach(f => { f.freq = bulkFreqSelected; });
  save();
  closeBulkFreqModal();
  render();
  // 頻度変更時は即フェッチ
  targets.forEach((f, i) => setTimeout(() => fetchFollow(f), i * 300));
}

/* ── 重複検出・統合 ── */

// 名前を正規化（記号・括弧・スペースを除去して比較用に）
function normalizeName(name){
  return name
    .toLowerCase()
    .replace(/[【】\[\]「」『』()（）・\-_\s]/g, '')
    .replace(/[ａ-ｚＡ-Ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .trim();
}

// チャンネルIDをURLから抽出
function ytChannelId(url){
  const m = url.match(/channel_id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 重複グループを検出
function detectDuplicates(){
  const groups = [];
  const used = new Set();

  follows.forEach((f, i) => {
    if(used.has(f.id)) return;
    const group = [f];
    const fNorm = normalizeName(f.name);
    const fChId = ytChannelId(f.url);

    follows.forEach((g, j) => {
      if(i >= j || used.has(g.id)) return;
      const gNorm = normalizeName(g.name);
      const gChId = ytChannelId(g.url);

      // 同じURL / 同じチャンネルID / 名前が80%以上一致
      const sameUrl = f.url === g.url;
      const sameChId = fChId && gChId && fChId === gChId;
      const nameSimilar = fNorm.length > 3 && gNorm.length > 3 && (
        fNorm.includes(gNorm) || gNorm.includes(fNorm) ||
        similarity(fNorm, gNorm) >= 0.75
      );

      if(sameUrl || sameChId || nameSimilar){
        group.push(g);
      }
    });

    if(group.length > 1){
      group.forEach(g => used.add(g.id));
      groups.push(group);
    }
  });
  return groups;
}

// 簡易文字列類似度（Dice係数）
function similarity(a, b){
  if(a === b) return 1;
  if(a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Set();
  for(let i = 0; i < a.length-1; i++) bigramsA.add(a[i]+a[i+1]);
  let inter = 0;
  for(let i = 0; i < b.length-1; i++){
    const bg = b[i]+b[i+1];
    if(bigramsA.has(bg)){ inter++; bigramsA.delete(bg); }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

let dupGroups = [];
let dupKeepIds = {}; // groupIndex -> keepId

function openDuplicateModal(){
  dupGroups = detectDuplicates();
  // デフォルト: 各グループの先頭を残す
  dupKeepIds = {};
  dupGroups.forEach((g, i) => { dupKeepIds[i] = g[0].id; });
  renderDuplicateModal();
}

function closeDuplicateModal(){
  document.getElementById('modalContainer').innerHTML = '';
}

function renderDuplicateModal(){
  const isDark = false;

  let content = '';
  if(dupGroups.length === 0){
    content = `<div class="dup-no-dups">重複するチャンネルは見つかりませんでした ✓</div>`;
  } else {
    dupGroups.forEach((group, gi) => {
      const c = colorOf(group[0]);
      content += `<div class="dup-group">
        <div class="dup-group-header">重複グループ ${gi+1} （${group.length}件）</div>`;
      group.forEach(f => {
        const col = colorOf(f);
        const bg = isDark ? col.dark_bg : col.bg;
        const fg = isDark ? col.dark_fg : col.fg;
        const isKeep = dupKeepIds[gi] === f.id;
        content += `<div class="dup-item">
          <div class="dup-avatar" style="background:${bg};color:${fg}">${esc(f.initials)}</div>
          <div style="flex:1;min-width:0">
            <div class="dup-name">${esc(f.name)}</div>
            <div class="dup-url">${esc(f.url)}</div>
          </div>
          <button class="${isKeep?'dup-keep selected':'dup-keep'}"
            data-click="1" data-action="setDupKeep" data-args="${dargs([gi, f.id])}">残す</button>
        </div>`;
      });
      content += `</div>`;
    });
  }

  const deleteCount = dupGroups.reduce((sum, g) => sum + g.length - 1, 0);

  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeIfBackdrop" data-args='["@el","@evt","closeDuplicateModal"]'>
    <div class="modal" style="width:500px;max-height:80vh;overflow-y:auto">
      <h2>重複チャンネルの検出・統合</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:1rem">
        「残す」を選んだチャンネルを残し、それ以外を削除します。
      </div>
      ${content}
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeDuplicateModal">キャンセル</button>
        ${dupGroups.length > 0 ? `<button class="btn-ok" data-click="1" data-action="execMerge">
          ${deleteCount}件を削除して統合
        </button>` : ''}
      </div>
    </div>
  </div>`;
}

function setDupKeep(groupIdx, keepId){
  dupKeepIds[groupIdx] = keepId;
  renderDuplicateModal();
}

function execMerge(){
  const keepIds = new Set(Object.values(dupKeepIds));
  const deleteIds = new Set(
    dupGroups.flatMap(g => g.map(f => f.id)).filter(id => !keepIds.has(id))
  );
  follows = follows.filter(f => !deleteIds.has(f.id));
  if(expanded && deleteIds.has(expanded)) expanded = null;
  save();
  closeDuplicateModal();
  render();
}

/* ── JSON Export / Import ── */
function exportJSON(){
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    follows: follows.map(f=>({
      id: f.id, name: f.name, url: f.url,
      platform: f.platform, freq: f.freq,
      tags: f.tags, colorIdx: f.colorIdx, initials: f.initials,
      memo: f.memo, markColor: f.markColor, suspended: f.suspended,
      registeredAt: f.registeredAt, favorite: f.favorite, fetchTimes: f.fetchTimes,
      subscriberCount: f.subscriberCount, subscriberFetchedAt: f.subscriberFetchedAt,
      iconUrl: f.iconUrl,
    }))
  };
  const json = JSON.stringify(data, null, 2);
  // User-Agent判定でiOS/デスクトップを分岐していたが、Brave等一部ブラウザは
  // プライバシー保護のためUser-Agentを偽装・簡略化することがあり、判定が
  // 外れて「本来はモーダルを開くべきなのに動作しないダウンロードのまま」に
  // なる不具合につながっていた。判定に頼らず、常に確実なモーダルを使う。
  showExportModal(json);
}

// iOS向け: JSONを画面表示してコピー/ファイル保存できるモーダル
function showExportModal(json){
  const blob = new Blob([json], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const fname = `fraidycat_${new Date().toISOString().slice(0,10)}.json`;
  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeModalContainerIfBackdrop" data-args='["@el","@evt"]'>
    <div class="modal" style="max-width:560px">
      <h2>JSONエクスポート（${follows.length}件）</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
        下のボタンでコピーするか、リンクを長押し→「リンク先のファイルをダウンロード」で保存できます。
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn-ok" data-click="1" data-action="copyExportJson" data-args='["@el"]'>クリップボードにコピー</button>
        <a class="btn-ok" href="${url}" download="${fname}"
           style="text-decoration:none;display:inline-flex;align-items:center"
           target="_blank" rel="noopener">ファイルとして開く</a>
      </div>
      <textarea id="exportJsonArea" readonly
        style="width:100%;height:240px;font-family:'DM Mono',monospace;font-size:11px;
        border:1px solid var(--border-strong);border-radius:8px;padding:8px;
        background:var(--bg);color:var(--text);resize:vertical;-webkit-user-select:all;user-select:all"
        data-click="1" data-action="selectInputText" data-args='["@el"]'>${esc(json)}</textarea>
      <div class="modal-actions">
        <button class="btn-cancel" data-click="1" data-action="closeModalContainer">閉じる</button>
      </div>
    </div>
  </div>`;
}

// navigator.clipboard.writeText()（Promise）は一部のiOSブラウザで許可待ちの
// まま解決も失敗もせず固まることがあるため使わず、同期的に成否が分かる
// document.execCommand('copy')のみを使う（copyTextExportAreaと同じ方式）。
function copyExportJson(btn){
  const ta = document.getElementById('exportJsonArea');
  if(!ta) return;
  ta.focus();
  ta.select();
  try{ ta.setSelectionRange(0, ta.value.length); }catch(e){}
  let ok = false;
  try{ ok = document.execCommand('copy'); }catch(e){ ok = false; }
  const orig = btn.textContent;
  if(ok){
    btn.textContent = '✓ コピーしました';
    showToast('クリップボードにコピーしました', 2500);
  } else {
    btn.textContent = '✕ コピー失敗';
    showToast('自動コピーに失敗しました。テキスト欄を長押しして手動でコピーしてください', 4500);
  }
  setTimeout(()=>{ btn.textContent = orig; }, 1800);
}

function importJSON(event){
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const data = JSON.parse(e.target.result);
      // 旧形式（配列そのもの）・新形式（{follows:[...]}）の両方に対応
      // （GitHub同期側のloadFromGitHubと同じ考え方）
      const followsArr = Array.isArray(data) ? data : data.follows;
      if(!followsArr || !Array.isArray(followsArr))
        throw new Error('follows フィールドが見つかりません');
      const existingUrls = new Set(follows.map(f=>f.url));
      const newFollows = followsArr
        .filter(f => f.url && !existingUrls.has(f.url))
        .map((f,i) => ({
          ...f,
          id: Date.now() + i,
          posts: [], loading: false,
          lastFetched: null, error: null,
        }));
      const skipped = followsArr.length - newFollows.length;
      if(newFollows.length === 0){
        alert(`インポートするデータがありません（${skipped}件はすでに登録済みです）`);
        return;
      }
      follows.push(...newFollows);
      save();
      render();
      newFollows.forEach((f,i)=>{ setTimeout(()=>fetchFollow(f), i*300); });
      alert(`${newFollows.length}件をインポートしました${skipped>0?`（${skipped}件は重複のためスキップ）`:''}`);
    } catch(err){
      alert('読み込みエラー: ' + err.message);
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

setInterval(()=>{
  // 5分ごとにチェック（60秒から延長）
  follows.forEach(f=>{ if(shouldRefetch(f)) enqueueFetch(f, false); });
}, 5 * 60 * 1000);

/* エラー一覧表示 */
function showErrorList(){
  const errs = follows.filter(f=>f.error);
  if(!errs.length) return;
  const errIds = errs.map(f=>f.id); // IDを先に取得しておく

  document.getElementById('modalContainer').innerHTML = `
  <div class="modal-backdrop" data-click="1" data-action="closeModalContainerIfBackdrop" data-args='["@el","@evt"]'>
    <div class="modal" style="max-height:80vh;overflow-y:auto">
      <h2>取得エラー（${errs.length}件）</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:1rem">
        「更新外」にするとチャンネルを残したまま自動更新をスキップします
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${errs.map(f=>`
          <div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
              <span style="font-size:13px;font-weight:500">${esc(f.name)}</span>
              <button class="btn-cancel" style="margin-left:auto;font-size:11px;padding:2px 8px"
                data-click="1" data-action="retrySingle" data-args="${dargs([f.id])}">
                再試行
              </button>
              <button class="btn-cancel" style="font-size:11px;padding:2px 8px;color:var(--accent-mid);border-color:var(--accent-mid)"
                data-click="1" data-action="suspendFollow" data-args="${dargs([f.id])}">
                更新外にする
              </button>
            </div>
            <div style="font-size:11px;color:var(--danger);font-family:var(--font-mono,monospace)">${esc(f.error||'')}</div>
            <div style="font-size:10px;color:var(--text-faint);margin-top:2px;word-break:break-all">${esc(f.url)}</div>
          </div>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn-ok" data-click="1" data-action="suspendAllErrors">
          全件を更新外にする
        </button>
        <button class="btn-cancel" data-click="1" data-action="retryAllErrors" data-args="${dargs([errIds])}">全件再試行</button>
        <button class="btn-cancel" data-click="1" data-action="closeModalContainer">閉じる</button>
      </div>
    </div>
  </div>`;
}

/* 個別再試行 */
function retrySingle(id){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  f.error = null;
  f.suspended = false;
  save();
  document.getElementById('modalContainer').innerHTML='';
  enqueueFetch(f, true); // 進捗カウント対象
  fetchTotal = fetchTotal || 1;
}

/* 全件再試行 */
function retryAllErrors(ids){
  document.getElementById('modalContainer').innerHTML=''; // 先にモーダルを閉じる
  const targets = ids.map(id=>follows.find(x=>x.id===id)).filter(Boolean);
  targets.forEach(f=>{ f.error=null; f.suspended=false; });
  save();
  // 進捗表示付きで再フェッチ
  fetchTotal = targets.length;
  fetchDone = 0;
  setStatus('loading', `再試行中 0/${fetchTotal}（0%）`);
  targets.forEach(f=>{
    if(fetchQueue.find(x=>x.id===f.id)) return;
    fetchQueue.push(f);
  });
  drainQueue();
}

function clearErrorAndRetry(id){ retrySingle(id); } // 後方互換

function suspendFollow(id){
  const f = follows.find(x=>x.id===id);
  if(!f) return;
  f.suspended = true;
  f.error = null;
  save();
  document.getElementById('modalContainer').innerHTML='';
  render();
}

function suspendAllErrors(){
  follows.forEach(f=>{ if(f.error){ f.suspended=true; f.error=null; } });
  save();
  document.getElementById('modalContainer').innerHTML='';
  render();
}

// 配信予定（duration===-3）の項目だけをYouTube APIで軽量に再チェックする。
// チャンネル全体のRSS再取得（enqueueFetch）は行わず、対象動画IDだけをvideos.listに問い合わせる。
async function refetchScheduledStatuses(){
  if(!ytApiKey) return;
  const now = Date.now();
  const CHECK_INTERVAL = 5 * 60 * 1000; // 同一動画の再チェックは5分に1回まで
  const targets = [];
  follows.forEach(f=>{
    (f.posts||[]).forEach(p=>{
      if(p.duration !== -3 || !p.link) return;
      if(p.lastLiveCheck && now - p.lastLiveCheck < CHECK_INTERVAL) return;
      // まだ予定時刻前のものはチェック不要
      if(p.scheduledAt){
        const d = p.scheduledAt instanceof Date ? p.scheduledAt : new Date(p.scheduledAt);
        if(!isNaN(d.getTime()) && d - now > 0) return;
      }
      const vid = ytVideoId(p.link);
      if(!vid) return;
      targets.push({f, p, vid});
    });
  });
  if(!targets.length) return;
  // YouTube APIは1リクエストあたり最大50件のIDを指定可能
  for(let i=0; i<targets.length; i+=50){
    const batch = targets.slice(i, i+50);
    const ids = batch.map(x=>x.vid).join(',');
    try{
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails&id=${ids}&key=${ytApiKey}&maxResults=50`,
        {signal: AbortSignal.timeout(15000)}
      );
      if(!res.ok) continue;
      const json = await res.json();
      const itemMap = {};
      (json.items||[]).forEach(item=>{ itemMap[item.id]=item; });
      batch.forEach(x=>{
        x.p.lastLiveCheck = now;
        const item = itemMap[x.vid];
        if(!item) return; // 動画が見つからない（削除等）場合は変更しない
        const liveStatus = item.snippet?.liveBroadcastContent;
        const dur = item.contentDetails?.duration;
        if(liveStatus === 'live'){
          x.p.duration = -2; // ライブ配信中に切り替わった
          return;
        }
        if(liveStatus === 'upcoming'){
          // まだ予定のまま。予定時刻が更新されていれば反映
          const scheduledTime = item.liveStreamingDetails?.scheduledStartTime;
          if(scheduledTime) x.p.scheduledAt = new Date(scheduledTime);
          return;
        }
        // 配信終了 or 通常動画になった → 実際の長さに更新
        if(!dur || dur==='PT0S'){ x.p.duration = -1; return; }
        let sec = 0;
        const h = dur.match(/(\d+)H/); if(h) sec += parseInt(h[1])*3600;
        const m = dur.match(/(\d+)M/); if(m) sec += parseInt(m[1])*60;
        const s = dur.match(/(\d+)S/); if(s) sec += parseInt(s[1]);
        x.p.duration = sec > 0 ? sec : -1;
      });
    }catch(e){ /* 通信エラー時は次の周期で再試行 */ }
  }
  save(true, false); // 1分ごとの自動チェックのためユーザー編集扱いにしない
  debouncedRender();
}

// 配信予定のカウントダウン＋時刻表示の自動更新（1分ごと）
setInterval(()=>{
  // 配信予定（-3）の項目はチャンネル全体のRSS再取得ではなく、動画単位の軽量チェックで更新する
  refetchScheduledStatuses();

  // カウントダウン表示を更新（予定バッジのみ）
  document.querySelectorAll('.dp-dur[data-upcoming="true"], .tl-dur[data-upcoming="true"]').forEach(el=>{
    const card = el.closest('[id^="fc-"]');
    if(!card) return;
    const id = parseInt(card.id.replace('fc-',''));
    const f = follows.find(x=>x.id===id);
    if(!f) return;
    f.posts.forEach(p=>{
      if(p.duration !== -3) return;
      const badge = getLiveBadge(p);
      if(badge) el.textContent = badge.text;
    });
  });

  // 最終確認時刻（fc-ago）を更新
  document.querySelectorAll('.fc-ago').forEach(el=>{
    const card = el.closest('[id^="fc-"]');
    if(!card) return;
    const id = parseInt(card.id.replace('fc-',''));
    const f = follows.find(x=>x.id===id);
    if(!f || !f.lastFetched) return;
    el.textContent = relativeTime(new Date(f.lastFetched)) + '取得';
  });

  // チャンネル個別の取得時刻スケジュールをチェック
  checkFetchSchedules();

}, 60000); // 1分ごと
load(); // まずlocalStorageから読み込む
// 拡張機能内で実行されている場合、起動時点の状態を一通りchrome.storage.localにも
// ミラーしておく（Service Workerがまだ一度もsave()を経由していない状態でも
// フォロー一覧・設定を参照できるようにするため）。
if(hasChromeStorage){
  mirrorToChromeStorage({
    fraidycat_follows: JSON.parse(localStorage.getItem('fraidycat_follows') || '[]'),
    fraidycat_tag_order: tagOrder,
    fraidycat_yt_api_key: ytApiKey,
    fraidycat_gemini_api_key: geminiApiKey,
    fraidycat_revival_threshold_days: revivalThresholdDays,
    fraidycat_revival_history: revivalHistory,
    fraidycat_gh_token: ghToken,
    fraidycat_gh_repo: ghRepo,
    fraidycat_gh_path: ghPath,
    fraidycat_gh_sync: ghSyncEnabled,
  });
}
searchQuery = '';
render();
setStatus('idle','準備完了');
// 起動時にも取得時刻スケジュールをチェック（取りこぼし防止）
setTimeout(()=>{ try{ checkFetchSchedules(); }catch(e){} }, 8000);

// 拡張機能のService Workerが、このタブを開いていない間にバックグラウンドで
// 取得した新しい投稿があれば起動時に取り込む（chrome.storage.local →
// localStorageへ一方向でマージ。GitHub同期の二重pushを避けるためsave(false)）。
async function reconcileFromChromeStorage(){
  try{
    const stored = await chrome.storage.local.get('fraidycat_follows');
    const bgFollows = stored.fraidycat_follows;
    if(!Array.isArray(bgFollows) || !bgFollows.length) return;
    const byId = new Map(bgFollows.map(bf=>[bf.id, bf]));
    let changed = false;
    follows.forEach(f=>{
      const bg = byId.get(f.id);
      if(!bg || !bg.lastFetched) return;
      if(!f.lastFetched || bg.lastFetched > f.lastFetched){
        f.posts = (bg.posts||[]).map(p=>({
          ...p,
          // 文字列で保存されたdateをDateオブジェクトに復元（load()と同じ規約）
          date: p.date ? new Date(p.date) : null
        })).filter(p => !p.date || !isNaN(p.date.getTime()));
        f.lastFetched = bg.lastFetched;
        f.error = bg.error !== undefined ? bg.error : f.error;
        if(bg.name) f.name = bg.name;
        changed = true;
      }
    });
    if(changed){
      save(false, false); // バックグラウンド取得結果の取り込みなのでユーザー編集扱いにしない
      render();
    }
  }catch(e){ console.warn('chrome.storage.localからの取り込みに失敗:', e); }
}
if(hasChromeStorage) reconcileFromChromeStorage();

/* スマホ用検索バーのイベント設定 */
(function(){
  // ドロワー内の静的検索欄
  const input = document.getElementById('drawerSearchStatic');
  const clear = document.getElementById('drawerSearchClearStatic');
  if(input){
    input.addEventListener('input', function(){
      setSearch(this.value);
      if(clear) clear.style.display = this.value ? 'block' : 'none';
    });
    input.addEventListener('keydown', function(e){ e.stopPropagation(); });
    input.addEventListener('keypress', function(e){ e.stopPropagation(); });
  }
  if(clear){
    clear.addEventListener('click', function(){
      clearSearch();
      if(input) input.value = '';
      this.style.display = 'none';
    });
  }
})();

/* GitHub同期が有効なら起動時に読み込み。
   以前はここに専用の読み込み処理を別途持っていたが、
   {follows,tagOrder}形式のデータを配列と誤判定して常に無処理で終わってしまう
   不具合があり、実質的に起動時の同期が機能していなかった。
   loadFromGitHub()（設定画面から手動同期する際に使う、形式に正しく対応した
   関数）を共通で使うようにして修正した。 */
async function syncPullFromGitHub(showStatus){
  if(!ghSyncEnabled || !ghToken || !ghRepo) return false;
  if(showStatus) setStatus('loading', 'GitHub同期中...');
  const ok = await loadFromGitHub();
  if(ok){
    render();
    renderTags();
    renderRevivalPanel();
    if(showStatus) setStatus('ok',`GitHub同期完了（${follows.length}件・タグ順${tagOrder.length}件）`);
  } else if(showStatus){
    setStatus('warn', '⚠ GitHub読込に失敗、またはスキップしました');
  }
  return ok;
}
if(ghSyncEnabled && ghToken && ghRepo){
  console.log('Boot: GitHub同期開始', 'enabled:', ghSyncEnabled, 'token:', !!ghToken, 'repo:', ghRepo);
  setTimeout(()=>{ syncPullFromGitHub(true); }, 500);
}
// タブを開きっぱなしにしていても、他端末の更新（久しぶり履歴・設定日数など）を
// 取り込めるよう、前回の読み込みから24時間以上経っていれば再同期する
// （起動時の1回だけでは反映されないため）。
// 以前は単純にsetInterval(24時間)で実装していたが、スマホのブラウザは
// バックグラウンドのタブのタイマーを間引く・停止することがあり、
// 「開きっぱなしでも24時間ごとに同期」が実質機能しないケースがあった。
// 経過時間ベースの判定にし、タブが再びアクティブになったタイミング
// （visibilitychange）でもチェックすることで、スマホでタブを行き来する
// 使い方でも取りこぼしにくくする。
function resyncFromGitHubIfStale(){
  if(!ghSyncEnabled || !ghToken || !ghRepo) return;
  if(Date.now() - ghLastPullAt > GH_RESYNC_INTERVAL_MS) syncPullFromGitHub(false);
}
setInterval(resyncFromGitHubIfStale, 60 * 60 * 1000); // 1時間ごとにチェック（間引かれても次のtickで拾える）
if(typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden) resyncFromGitHubIfStale();
  });
}
/* 初回フェッチ: キューに順番に追加（setTimeoutを大量生成しない） */
if(follows.length){
  const toFetch = follows.filter(f => shouldRefetch(f));
  let idx = 0;
  function scheduleNext(){
    if(idx >= toFetch.length) return;
    enqueueFetch(toFetch[idx++], false);
    setTimeout(scheduleNext, 2000);
  }
  setTimeout(scheduleNext, 1000);
}

/* 起動時アイコン・登録者数自動取得（APIキーがある場合・5秒後にサイレント実行） */
setTimeout(async ()=>{
  if(!ytApiKey) return;
  const SUB_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 登録者数は30日で再取得
  const now = Date.now();
  // アイコン未取得、または登録者数が未取得/30日以上前のチャンネル
  const needFetch = follows.filter(f=>{
    if(!ytChannelIdFromUrl(f.url)) return false;
    if(!f.iconUrl) return true;
    if(f.subscriberCount == null) return true;
    if(!f.subscriberFetchedAt || (now - f.subscriberFetchedAt) > SUB_MAX_AGE) return true;
    return false;
  });
  if(!needFetch.length) return;
  const CHUNK = 50;
  for(let i=0; i<needFetch.length; i+=CHUNK){
    const chunk = needFetch.slice(i, i+CHUNK);
    const ids = chunk.map(f=>ytChannelIdFromUrl(f.url)).join(',');
    try{
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids}&key=${ytApiKey}&maxResults=50`,
        {signal: AbortSignal.timeout(15000)}
      );
      if(!res.ok) break;
      const json = await res.json();
      const itemMap = {};
      (json.items||[]).forEach(item=>{ itemMap[item.id]=item; });
      chunk.forEach(f=>{
        const chId = ytChannelIdFromUrl(f.url);
        const iconUrl = itemMap[chId]?.snippet?.thumbnails?.default?.url;
        if(iconUrl) f.iconUrl = iconUrl;
        const subCount = itemMap[chId]?.statistics?.subscriberCount;
        if(subCount != null){ f.subscriberCount = parseInt(subCount); f.subscriberFetchedAt = Date.now(); }
      });
      save(false, false); // ループ中はlocalStorageのみ。起動時の自動取得なのでユーザー編集扱いにしない
      if(i+CHUNK < needFetch.length) await new Promise(r=>setTimeout(r,300));
    }catch(e){ break; }
  }
  debouncedRender();
  save(true, false); // 完了後に1回だけGitHub同期。起動時の自動取得なのでユーザー編集扱いにしない
}, 5000);
