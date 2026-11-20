// Forge Collector: the whole extension's behaviour lives in this file.
//
//   1. A tab finishes loading a page whose URL matches an action's `matchUrl`.
//   2. If the action has `contains`, the page text must match that regex.
//   3. The page itself fetches `request.path` on its own site, using your logged-in cookies.
//   4. The raw response is POSTed to your Forge and stored under `storeAs`.
//
// Nothing else happens. It only touches sites you granted on the options page, and only sends data to the Forge URL you typed there.

const CONFIG_MAX_AGE_MS = 5 * 60 * 1000;

// Chrome match pattern ("https://example.com/account/*") -> RegExp.
function patternToRegExp(pattern) {
  const m = /^(https?|\*):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const scheme = m[1] === "*" ? "https?" : m[1];
  const host = m[2] === "*" ? "[^/]+" : m[2].startsWith("*.") ? `(?:[^/]+\\.)?${esc(m[2].slice(2))}` : esc(m[2]);
  return new RegExp(`^${scheme}://${host}(?::\\d+)?${esc(m[3]).replace(/\*/g, ".*")}$`);
}

// Runs INSIDE the page (chrome.scripting.executeScript serialises this function), so fetch() carries the page's cookies.
async function pageStep(action) {
  if (action.contains && !new RegExp(action.contains).test(document.body ? document.body.innerText : "")) {
    return { skipped: "page text did not match" };
  }
  const url = new URL(action.request.path, location.origin);
  if (url.origin !== location.origin) return { error: "refused: request leaves the page's site" };
  const r = await fetch(url, {
    method: action.request.method,
    headers: action.request.headers,
    body: action.request.method === "POST" ? action.request.body : undefined,
    credentials: "include",
  });
  return { status: r.status, contentType: r.headers.get("content-type") || "", url: url.href, body: await r.text() };
}

async function note(actionId, ok, text) {
  const { lastRun = {} } = await chrome.storage.local.get("lastRun");
  lastRun[actionId] = { at: Date.now(), ok, text };
  await chrome.storage.local.set({ lastRun });
}

async function syncConfig(force) {
  const s = await chrome.storage.local.get({ forgeUrl: "", token: "", actions: [], fetchedAt: 0 });
  if (!s.forgeUrl || !s.token) throw new Error("set the Forge URL and token on the options page");
  if (!force && Date.now() - s.fetchedAt < CONFIG_MAX_AGE_MS) return s.actions;
  const r = await fetch(`${s.forgeUrl}/api/ext/config`, { headers: { authorization: `Bearer ${s.token}` } });
  if (!r.ok) throw new Error(`Forge answered ${r.status} to the config request`);
  const { actions } = await r.json();
  await chrome.storage.local.set({ actions, fetchedAt: Date.now() });
  return actions;
}

async function runActions(tabId, tabUrl) {
  const { forgeUrl, token } = await chrome.storage.local.get({ forgeUrl: "", token: "" });
  if (!forgeUrl || !token) return;
  let actions;
  try {
    actions = await syncConfig(false);
  } catch {
    actions = (await chrome.storage.local.get({ actions: [] })).actions; // Forge unreachable: use the last config
  }
  for (const a of actions) {
    const re = patternToRegExp(a.matchUrl);
    if (!re || !re.test(tabUrl)) continue;
    const { lastRun = {} } = await chrome.storage.local.get("lastRun");
    if (lastRun[a.id] && Date.now() - lastRun[a.id].at < a.minIntervalMinutes * 60_000) continue;
    await note(a.id, true, "running"); // claims the slot so two tabs do not both run it
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageStep, args: [a] });
      if (result.skipped) { await note(a.id, true, `skipped: ${result.skipped}`); continue; }
      if (result.error) throw new Error(result.error);
      const up = await fetch(`${forgeUrl}/api/ext/result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ actionId: a.id, name: a.storeAs, url: result.url, status: result.status, contentType: result.contentType, body: result.body }),
      });
      if (!up.ok) throw new Error(`Forge answered ${up.status} to the upload`);
      await note(a.id, true, `sent ${result.body.length} chars (HTTP ${result.status} from site)`);
    } catch (e) {
      await note(a.id, false, String(e.message || e));
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // `tab.url` is only visible for sites you granted, so this ignores everything else.
  if (change.status === "complete" && tab.url) runActions(tabId, tab.url).catch(() => {});
});

// The options page asks for a fresh copy of the config.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "sync") {
    syncConfig(true).then((actions) => reply({ ok: true, count: actions.length }), (e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
