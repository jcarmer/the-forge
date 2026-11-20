# Forge Collector

A small browser extension that lets your Forge collect data from sites you are logged in to.
About 150 lines of code, no build step, no dependencies. Read it in this order: `manifest.json`, `background.js`, `options.js`.

## What it can do

For each **action** you configure in the Forge (Extension tab), when you open a page whose URL matches:

1. optionally check the page text against a regex,
2. `fetch` one path on that same site, with your logged-in cookies,
3. POST the raw response to your Forge, saved under a name you chose.

Actions are data (JSON), never code. The Forge cannot make the extension run anything else.

## Review checklist

- `manifest.json`: permissions are only `scripting` and `storage`. There are **no** static host permissions; every site (and your Forge) is allowed by you, one prompt each (`optional_host_permissions`).
- `background.js` `pageStep`: the request is built with `new URL(path, location.origin)` and refused if the origin differs, so it can only reach the site you are on. The only other network call is to the Forge URL you saved.
- Requests carry your session cookies, so a configured action can read anything you can read on that site. Only add actions you wrote.
- The token authenticates the extension to the Forge. Rotate it in the Forge UI any time.
- Nothing is loaded from the network, nothing is `eval`ed, and there is no analytics.

## Install

Desktop Chrome only: open `chrome://extensions`, turn on Developer mode, **Load unpacked**, pick this folder. Phones and other browsers are not supported (Chrome for Android cannot run extensions).

Then open the extension's options: enter your Forge URL and the token, click **Save**, then **Allow sites used by actions**.

## Limits

- Actions run when a matching tab finishes loading, not on a clock. Use `minIntervalMinutes` to avoid re-running on every visit. To refresh daily, open the page daily.
- The page text check runs at "load complete"; pages that render their content later may need a looser (or no) `contains`.
