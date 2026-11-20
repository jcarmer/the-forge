const $ = (id) => document.getElementById(id);
const say = (t, bad) => { $("msg").textContent = t; $("msg").className = bad ? "bad" : ""; };

// "https://example.com/account/*" -> "https://example.com/*"  (a permission is per site, not per path; the port is left out so any port matches)
function sitePermission(pattern) {
  const m = /^(https?|\*):\/\/([^/]+)\//.exec(pattern);
  return m ? `${m[1]}://${m[2].replace(/:\d+$/, "")}/*` : null;
}

async function render() {
  const s = await chrome.storage.local.get({ forgeUrl: "", token: "", actions: [], lastRun: {} });
  $("url").value = s.forgeUrl;
  $("token").value = s.token;
  const list = $("actions");
  list.replaceChildren();
  for (const a of s.actions) {
    const li = document.createElement("li");
    const r = s.lastRun[a.id];
    li.textContent = `${a.label || a.id}: ${a.matchUrl} -> ${a.request.method} ${a.request.path} -> ${a.storeAs}  [${r ? (r.ok ? "" : "FAILED ") + r.text + " at " + new Date(r.at).toLocaleString() : "not run yet"}]`;
    if (r && !r.ok) li.className = "bad";
    list.append(li);
  }
}

$("save").onclick = async () => {
  try {
    const u = new URL($("url").value.trim());
    const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    if (!granted) return say("Permission to reach the Forge was refused.", true);
    await chrome.storage.local.set({ forgeUrl: u.origin, token: $("token").value.trim() });
    const r = await chrome.runtime.sendMessage({ type: "sync" });
    say(r.ok ? `Synced ${r.count} action(s).` : r.error, !r.ok);
    await render();
  } catch (e) { say(String(e.message || e), true); }
};

$("grant").onclick = async () => {
  const { actions } = await chrome.storage.local.get({ actions: [] });
  const origins = [...new Set(actions.map((a) => sitePermission(a.matchUrl)).filter(Boolean))];
  if (!origins.length) return say("No actions yet. Save and sync first.", true);
  const ok = await chrome.permissions.request({ origins });
  say(ok ? `Allowed: ${origins.join(", ")}` : "Permission refused.", !ok);
};

render();
