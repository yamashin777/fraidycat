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
