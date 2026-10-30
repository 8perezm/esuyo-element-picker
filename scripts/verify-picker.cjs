// End-to-end check of the picker against the shared debug Chrome.
// Drives trusted input (Input.dispatchMouseEvent/KeyEvent) so the test exercises
// the real hover->lock->copy->Esc path listeners use. Clipboard may fail without
// a user gesture; lock state + payload are the assertions.
// Usage: node scripts/verify-picker.cjs [--port 9222]
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const PORT = Number((args[args.indexOf("--port") + 1] || "9222"));
const TEST_PAGE = "file:///C:/SERVER/REPOS/Esuyo/esuyo-browser-control/extension/test-page.html";
const pickerSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "picker.js"), "utf8");

let wsSeq = 0;
function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const call = (method, params = {}) =>
    ready.then(() => new Promise((resolve, reject) => {
      const id = ++wsSeq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout " + method))), 20000);
    }));
  return { call, close: () => { try { ws.close(); } catch {} } };
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const s = session(page.webSocketDebuggerUrl);
  const ev = async (expr) => (await s.call("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

  await s.call("Page.navigate", { url: TEST_PAGE });
  await new Promise((r) => setTimeout(r, 2500));

  await s.call("Runtime.evaluate", { expression: pickerSrc });
  let st = JSON.parse(await ev("JSON.stringify(window.__esuyoPicker.status())"));
  check("picker installed + api", st && st.picking === false && st.locked === false);

  // Arm picking, hover the data-ref h1 via trusted mouse move.
  await ev("window.__esuyoPicker.toggle()");
  const box = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('h1[data-ref=\"report-title\"]').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })())`));
  await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await new Promise((r) => setTimeout(r, 400));
  const hl = JSON.parse(await ev(`JSON.stringify((() => { const h = document.getElementById('__esuyo-picker-highlight'); return h ? h.style.display : 'missing'; })())`));
  check("hover shows border", hl === "block", "display=" + hl);

  // Click to lock.
  await s.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await s.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 600));
  st = JSON.parse(await ev("JSON.stringify(window.__esuyoPicker.status())"));
  check("click locks pick", st.locked === true);
  const payload = JSON.parse(await ev("JSON.stringify(window.__esuyoPicker.lastPayload())"));
  check("payload targets h1", payload && payload.target.tag === "h1");
  check("payload uses data-ref selector", payload && /data-ref="report-title"/.test(payload.target.selector), payload && payload.target.selector);
  check("payload has fullPath fallback", payload && payload.target.fullPath.includes("h1"));
  check("payload has ancestors", payload && payload.target.ancestors.length > 0);
  check("payload url is test page", payload && payload.page.url.includes("test-page.html"), payload && payload.page.url);
  const paste = await ev("window.__esuyoPicker.pasteText()");
  check("paste text starts with marker", typeof paste === "string" && paste.startsWith("@picked-element v1"));
  check("paste contains selector+fullPath", paste.includes("selector:") && paste.includes("fullPath:"));

  // Esc clears (trusted key events).
  for (const type of ["keyDown", "keyUp"]) {
    await s.call("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await new Promise((r) => setTimeout(r, 300));
  st = JSON.parse(await ev("JSON.stringify(window.__esuyoPicker.status())"));
  check("Esc clears lock", st.locked === false && st.hasLast === false);

  // Whole-page retrofit prompt.
  const retro = await ev("window.__esuyoPicker.retrofitText()");
  check("retrofit text has counts", typeof retro === "string" && retro.startsWith("@retrofit-data-ref v1") && retro.includes("h1"));

  s.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
