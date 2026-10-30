async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function send(type) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    // inject on demand (e.g. after install without reload)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    return await chrome.tabs.sendMessage(tab.id, { type });
  }
}
const status = document.getElementById("status");
async function refresh() {
  try {
    const s = await send("STATUS");
    status.textContent = s ? `picking=${s.picking} locked=${s.locked} hasLast=${s.hasLast}\nEsc clears.` : "no response on this page";
  } catch (e) { status.textContent = String(e).slice(0, 200); }
}
document.getElementById("pick").onclick = async () => { await send("TOGGLE_PICK"); refresh(); };
document.getElementById("copy").onclick = async () => {
  const r = await send("COPY_LAST");
  status.textContent = r?.ok ? "copied — paste into TUI" : "nothing picked yet";
};
document.getElementById("retrofit").onclick = async () => {
  const r = await send("COPY_RETROFIT");
  status.textContent = r?.ok ? "retrofit request copied — paste into TUI" : "copy failed";
};
refresh();
