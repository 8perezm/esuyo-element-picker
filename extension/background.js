chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICK" });
  } catch {
    // content script not yet injected (e.g. chrome://) — try injecting then retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICK" });
    } catch {}
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-pick") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICK" }); } catch {}
});
