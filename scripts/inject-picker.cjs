// Injects extension/picker.js into open pages of the shared debug Chrome via CDP.
// Why CDP injection and not --load-extension: Chrome 137+ branded builds ignore
// --load-extension ("--load-extension is not allowed in Google Chrome, ignoring").
// The supported programmatic path is Extensions.loadUnpacked, but manifest-declared
// content scripts did not auto-inject in our verification (Chrome 156, port-based
// CDP). Runtime.evaluate injection is verified working (window.__esuyoPickerInstalled).
// Re-run after user navigates. Zero dependencies (global WebSocket, Node 22+).
// Usage: node scripts/inject-picker.cjs [--port 9222] [--url-filter <substr>]
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(opt("--port", "9222"));
const FILTER = opt("--url-filter", null);

const pickerSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "picker.js"), "utf8");

function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("cdp timeout " + method)); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        clearTimeout(t);
        try { ws.close(); } catch {}
        m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error("ws connect failed: " + wsUrl)); };
  });
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter(
    (t) => t.type === "page" && /^https?:|^file:/.test(t.url) && (!FILTER || t.url.includes(FILTER))
  );
  if (!pages.length) throw new Error("no matching page targets on port " + PORT);
  for (const p of pages) {
    // Best-effort persistence for future documents in this target.
    try {
      await cdp(p.webSocketDebuggerUrl, "Page.addScriptToEvaluateOnNewDocument", { source: pickerSrc });
    } catch (e) { console.log(`WARN addScript ${p.url}: ${e.message}`); }
    await cdp(p.webSocketDebuggerUrl, "Runtime.evaluate", { expression: pickerSrc, returnByValue: false });
    const check = await cdp(p.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: "JSON.stringify({installed: !!window.__esuyoPickerInstalled, api: !!window.__esuyoPicker})",
      returnByValue: true,
    });
    console.log(`OK ${p.url} ->`, check.result.value);
  }
  console.log(`picker live in ${pages.length} page(s). Re-run after navigation. Hotkey: Alt+X, Esc clears.`);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
