/* esuyo-element-picker content script.
 * Pick mode: hover shows border + tooltip, click locks border and copies
 * a text-only locator payload for paste into the (possibly remote over SSH) TUI.
 * Last-pick-wins. Esc clears highlight AND invalidates the pick.
 * No screenshots transferred (remote scp problem) — agent re-reads DOM itself.
 */
(() => {
  if (window.__esuyoPickerInstalled) return;
  window.__esuyoPickerInstalled = true;

  // Works both as an extension content script AND when injected via CDP
  // (Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate).
  const hasChrome = (typeof chrome !== "undefined") && chrome && chrome.storage && chrome.runtime;
  const storeGet = async () => {
    if (!hasChrome) return null;
    try { return (await chrome.storage.local.get("esuyoLastPick")).esuyoLastPick || null; } catch { return null; }
  };
  const storeSet = async (v) => {
    if (!hasChrome) return;
    try { await chrome.storage.local.set({ esuyoLastPick: v }); } catch {}
  };
  const storeDel = async () => {
    if (!hasChrome) return;
    try { await chrome.storage.local.remove("esuyoLastPick"); } catch {}
  };

  const HIGHLIGHT_ID = "__esuyo-picker-highlight";
  const TOOLTIP_ID = "__esuyo-picker-tooltip";
  const TOAST_ID = "__esuyo-picker-toast";

  const SAFE_ATTRS = new Set([
    "id", "class", "name", "role", "href", "type", "alt", "title",
    "src", "placeholder", "value", "data-ref", "data-testid", "aria-label"
  ]);
  const SECRET_RE = /(token|secret|password|passwd|auth|api[_-]?key|session|cookie)/i;
  const SECRET_VAL_RE = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,})/i;

  let picking = false;
  let lockedEl = null;
  let lastPayload = null;

  function sanitizeUrl(raw) {
    try {
      if (!raw) return "";
      if (raw === "about:blank") return "about:blank";
      const u = new URL(raw, location.href);
      if (u.protocol === "about:") return u.href === "about:blank" ? "about:blank" : "";
      if (!["http:", "https:", "file:"].includes(u.protocol)) return "";
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch { return ""; }
  }

  function clamp(s, max) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + " …" : s;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function uniqueSelector(el) {
    // Prefer stable hooks, then id, then testids, then structural path.
    const ref = el.getAttribute && (el.getAttribute("data-ref") || el.getAttribute("data-testid"));
    if (ref && /^[a-zA-Z0-9-_:.]+$/.test(ref)) {
      const attr = el.hasAttribute("data-ref") ? "data-ref" : "data-testid";
      const sel = `${el.tagName.toLowerCase()}[${attr}="${ref}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    if (el.id) {
      const sel = `#${cssEscape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    return fullPath(el);
  }

  function fullPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length > 12) break;
    }
    return parts.join(" > ");
  }

  function ancestorBreadcrumb(el) {
    const crumbs = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && crumbs.length < 6) {
      let c = cur.tagName.toLowerCase();
      if (cur.id) c += `#${cur.id}`;
      else {
        const ref = cur.getAttribute && (cur.getAttribute("data-ref") || cur.getAttribute("data-testid"));
        if (ref) c += `[${ref}]`;
        else if (cur.classList && cur.classList.length) c += `.${Array.from(cur.classList).slice(0, 2).join(".")}`;
      }
      crumbs.unshift(c);
      cur = cur.parentElement;
    }
    return crumbs.join(" / ");
  }

  function safeAttributes(el) {
    const out = {};
    if (!el.attributes) return out;
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (!SAFE_ATTRS.has(name) && !name.startsWith("aria-")) continue;
      let v = clamp(a.value, name === "class" ? 200 : 500);
      if (SECRET_RE.test(name) || SECRET_VAL_RE.test(v)) v = "[redacted]";
      if ((name === "href" || name === "src") && v && !v.startsWith("[") && !v.startsWith("data:")) {
        v = sanitizeUrl(v) || v;
      }
      out[name] = v;
    }
    return out;
  }

  function computedSubset(el) {
    try {
      const cs = getComputedStyle(el);
      const pick = ["display", "position", "color", "background-color", "font-size", "font-weight", "margin", "padding"];
      const out = {};
      for (const k of pick) out[k] = cs.getPropertyValue(k).trim();
      return out;
    } catch { return {}; }
  }

  function nearbyText(el) {
    const texts = [];
    const parent = el.parentElement;
    if (!parent) return texts;
    for (const sib of Array.from(parent.children).slice(0, 10)) {
      if (sib === el) continue;
      const t = clamp(sib.innerText || sib.textContent || "", 120);
      if (t) texts.push(t);
      if (texts.length >= 5) break;
    }
    return texts;
  }

  function frameContext() {
    // Top-level pages: not framed. Same-origin iframes: include frame url.
    // Cross-origin iframes: url access throws — report framed:true, url:null.
    try {
      if (window.self === window.top) return { framed: false, frameUrl: null };
      return { framed: true, frameUrl: sanitizeUrl(window.self.location.href) || null };
    } catch {
      return { framed: true, frameUrl: null };
    }
  }

  function stableHook(el) {
    const ref = el.getAttribute && (el.getAttribute("data-ref") || el.getAttribute("data-testid"));
    if (ref) return { has: true, kind: el.hasAttribute("data-ref") ? "data-ref" : "data-testid", value: ref };
    if (el.id) return { has: true, kind: "id", value: el.id };
    return { has: false, kind: null, value: null };
  }

  function visibility(el) {
    let visible = true;
    try {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      visible = cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" &&
        r.width > 0 && r.height > 0;
    } catch { visible = false; }
    const enabled = !("disabled" in el) || el.disabled === false;
    return { visible, enabled };
  }

  function buildPayload(el) {
    const rect = el.getBoundingClientRect();
    const hook = stableHook(el);
    return {
      v: 2,
      page: {
        url: sanitizeUrl(location.href),
        title: clamp(document.title, 200),
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) }
      },
      target: {
        tag: el.tagName.toLowerCase(),
        frame: frameContext(),
        hook,
        state: visibility(el),
        selector: uniqueSelector(el),
        fullPath: fullPath(el),
        ancestors: ancestorBreadcrumb(el),
        text: clamp(el.innerText || el.textContent || "", 300),
        html: clamp(el.outerHTML, 4000),
        attributes: safeAttributes(el),
        styles: computedSubset(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        nearby: nearbyText(el)
      },
      capturedAt: new Date().toISOString()
    };
  }

  function toPasteText(p) {
    const t = p.target;
    const lines = [
      "@picked-element v2",
      `url: ${p.page.url}`,
      `title: ${p.page.title}`,
      `viewport: ${p.page.viewport.w}x${p.page.viewport.h} dpr=${p.page.viewport.dpr} scroll=${p.page.scroll.x},${p.page.scroll.y}`,
      `frame: ${t.frame.framed ? "framed frameUrl=" + (t.frame.frameUrl || "cross-origin") : "top-level"}`,
      `selector: ${t.selector}`,
      `fullPath: ${t.fullPath}`,
      `ancestors: ${t.ancestors}`,
      `tag: ${t.tag}  text: ${JSON.stringify(t.text)}`,
      `hook: ${t.hook.has ? t.hook.kind + "=" + JSON.stringify(t.hook.value) : "none — consider adding data-ref"}`,
      `state: visible=${t.state.visible} enabled=${t.state.enabled}`,
      `attrs: ${JSON.stringify(t.attributes)}`,
      `styles: ${JSON.stringify(t.styles)}`,
      `rect: ${t.rect.x},${t.rect.y} ${t.rect.w}x${t.rect.h}`,
      `nearby: ${JSON.stringify(t.nearby)}`,
      `html: ${t.html}`,
      `capturedAt: ${p.capturedAt}`
    ];
    return lines.join("\n");
  }

  function ensureOverlay() {
    let hl = document.getElementById(HIGHLIGHT_ID);
    if (!hl) {
      hl = document.createElement("div");
      hl.id = HIGHLIGHT_ID;
      hl.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c3aed;box-shadow:0 0 0 1px #fff inset;border-radius:3px;display:none;";
      document.documentElement.appendChild(hl);
    }
    let tip = document.getElementById(TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement("div");
      tip.id = TOOLTIP_ID;
      tip.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;background:#1e1b4b;color:#fff;font:12px/1.4 monospace;padding:4px 8px;border-radius:6px;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      document.documentElement.appendChild(tip);
    }
    return { hl, tip };
  }

  function showBox(el, locked) {
    const { hl, tip } = ensureOverlay();
    const r = el.getBoundingClientRect();
    hl.style.display = "block";
    hl.style.left = r.left + "px";
    hl.style.top = r.top + "px";
    hl.style.width = r.width + "px";
    hl.style.height = r.height + "px";
    hl.style.borderColor = locked ? "#dc2626" : "#7c3aed";
    tip.style.display = "block";
    tip.textContent = `${locked ? "LOCKED " : ""}${el.tagName.toLowerCase()}  ${uniqueSelector(el).slice(0, 120)}  ${Math.round(r.width)}x${Math.round(r.height)}`;
    const top = Math.min(window.innerHeight - 34, r.bottom + 6);
    tip.style.left = Math.max(6, Math.min(window.innerWidth - 430, r.left)) + "px";
    tip.style.top = Math.max(6, top) + "px";
  }

  function hideOverlay() {
    const hl = document.getElementById(HIGHLIGHT_ID);
    const tip = document.getElementById(TOOLTIP_ID);
    if (hl) hl.style.display = "none";
    if (tip) tip.style.display = "none";
  }

  function toast(msg) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      el.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;background:#111827;color:#fff;font:13px system-ui;padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);";
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el.__t);
    el.__t = setTimeout(() => (el.style.display = "none"), 2600);
  }

  async function copyText(s) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;opacity:0;";
      document.documentElement.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function setPicking(on) {
    picking = on;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on && !lockedEl) hideOverlay();
    if (on && lockedEl) showBox(lockedEl, true);
  }

  document.addEventListener("mousemove", (e) => {
    if (!picking || lockedEl) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !(el instanceof Element)) return;
    if (el.id === HIGHLIGHT_ID || el.id === TOOLTIP_ID || el.id === TOAST_ID) return;
    showBox(el, false);
  }, true);

  document.addEventListener("click", async (e) => {
    if (!picking || lockedEl) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !(el instanceof Element)) return;
    if (el.id === HIGHLIGHT_ID || el.id === TOOLTIP_ID || el.id === TOAST_ID) return;
    e.preventDefault();
    e.stopPropagation();
    lockedEl = el;
    lastPayload = buildPayload(el);
    showBox(el, true);
    const ok = await copyText(toPasteText(lastPayload));
    await storeSet(lastPayload);
    toast(ok ? "Locked + copied — paste into TUI. Esc clears." : "Locked, but clipboard blocked — use popup Copy.");
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearPick();
    // Same hotkey as the extension command, for CDP-injected use (no extension).
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      if (lockedEl) clearPick(); else setPicking(!picking);
    }
  }, true);

  function clearPick() {
    lockedEl = null;
    lastPayload = null;
    setPicking(false);
    hideOverlay();
    storeDel();
  }

  function buildRetrofitText() {
    const counts = {};
    for (const sel of ["button", "a", "input", "select", "textarea", "h1", "h2", "h3", "[data-ref]", "[data-testid]"]) {
      try { counts[sel] = document.querySelectorAll(sel).length; } catch { counts[sel] = 0; }
    }
    return [
      "@retrofit-data-ref v1 (whole page)",
      `url: ${sanitizeUrl(location.href)}`,
      `title: ${clamp(document.title, 200)}`,
      `counts: ${JSON.stringify(counts)}`,
      "request: add missing data-ref hooks to the template(s) rendering this page.",
      "rules: kebab-case, feature-scoped, unique; selection-only, never read by CSS/JS logic.",
      "verify: list files touched + new hooks added."
    ].join("\n");
  }

  // Public API for CDP-driven control + automated verification.
  // (Extension popup/background keep working via chrome.runtime messages.)
  window.__esuyoPicker = {
    toggle() { if (lockedEl) clearPick(); else setPicking(!picking); return this.status(); },
    clear() { clearPick(); return true; },
    pasteText() { return lastPayload ? toPasteText(lastPayload) : null; },
    lastPayload() { return lastPayload; },
    status() { return { picking, locked: !!lockedEl, hasLast: !!(lockedEl || lastPayload) }; },
    async copyLast() {
      const p = lastPayload || await storeGet();
      if (!p) return false;
      return copyText(toPasteText(p));
    },
    async copyRetrofit() { return copyText(buildRetrofitText()); },
    retrofitText() { return buildRetrofitText(); }
  };

  if (!hasChrome) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === "TOGGLE_PICK") {
        if (lockedEl) clearPick();
        else setPicking(!picking);
        sendResponse({ picking, locked: !!lockedEl });
      } else if (msg.type === "CLEAR") {
        clearPick();
        sendResponse({ ok: true });
      } else if (msg.type === "COPY_LAST") {
        const stored = (await chrome.storage.local.get("esuyoLastPick")).esuyoLastPick || lastPayload;
        if (!stored) { sendResponse({ ok: false, reason: "no-pick" }); return; }
        sendResponse({ ok: await copyText(toPasteText(stored)) });
      } else if (msg.type === "COPY_RETROFIT") {
        sendResponse({ ok: await copyText(buildRetrofitText()) });
      } else if (msg.type === "STATUS") {
        sendResponse({ picking, locked: !!lockedEl, hasLast: !!(lastPayload || (await chrome.storage.local.get("esuyoLastPick")).esuyoLastPick) });
      }
    })();
    return true;
  });
})();
