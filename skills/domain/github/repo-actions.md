# GitHub — Repo actions (star, unstar, watch, fork)

`https://github.com/{owner}/{repo}` — user-triggered actions on the repo header (Star, Unstar, Watch, Unwatch) are HTML forms that POST back to GitHub. **Submit the form — do not click the button.**

## Do this first

```javascript
// Precondition: user is logged in
const loggedIn = await page.evaluate(() => !!document.querySelector("meta[name=user-login]"));
if (!loggedIn) throw new Error("not logged in to GitHub");

// Star the current repo — use form.submit(), NOT button.click()
const result = await page.evaluate(() => {
  const f = document.querySelector('form[action$="/star"]');
  if (!f) return 'already-starred-or-missing';
  f.submit();
  return 'submitted';
});
await page.waitForTimeout(2000);
await page.waitForLoadState('networkidle').catch(() => {});

// Verify — the toggle swaps which form is present
const starred = await page.evaluate(() => !!document.querySelector('form[action$="/unstar"]'));
```

## Why not click the button

The visible Star button looks like `button[aria-label^="Star "]`, but:

- **There are two matching buttons.** The first `querySelector` returns is a hidden fallback inside the sticky sub-header with `getBoundingClientRect() == {x:0, y:0, w:0, h:0}`. Coordinate-clicking it does nothing.
- **Synthetic `.click()` on the visible React button does not persist the star.** The click fires, `aria-label` stays `Star ...`, network tab shows no POST. GitHub's component swallows the synthetic event in its React fiber handler.

`form.submit()` bypasses React entirely and goes straight to the HTML form's POST.

## Unstar / Unwatch

```javascript
// Unstar: use form[action$="/unstar"]
await page.evaluate(() => {
  const f = document.querySelector('form[action$="/unstar"]');
  if (f) f.submit();
});

// Watch all activity: use form[action$="/subscription"]
await page.evaluate(() => {
  const f = document.querySelector('form[action$="/subscription"]');
  if (f) f.submit();
});
```

## Gotchas

- **Star count lags.** The count in the button updates on soft navigation — don't use it as an assertion target. Use which form is present: `form[action$="/star"]` = unstarred, `form[action$="/unstar"]` = starred.
- **`form.submit()` bypasses submit event listeners.** Works for GitHub, but if they switch to XHR, use `form.requestSubmit()` instead.
- **Not logged in → forms not rendered.** `meta[name="user-login"]` is the cheapest pre-check.
- **For read-only star counts, use the API.** `fetch("https://api.github.com/repos/{owner}/{repo}")` returns `stargazers_count` without browser interaction.

## Quick sketch

```javascript
// Minimal: star a repo using browser-control
// Precondition: navigate to repo page, verify logged in
const mgr = getBrowserControlManager();
await mgr.evaluate(`
  (() => {
    const f = document.querySelector('form[action$="/star"]');
    if (!f) return 'already-starred';
    f.submit();
    return 'starred';
  })()
`, 'default');
await new Promise(r => setTimeout(r, 2000));
const isStarred = await mgr.evaluate(
  `!!document.querySelector('form[action$="/unstar"]')`,
  'default'
);
```

---

_Adapted from Browser Harness domain-skills/github/repo-actions.md. Last verified: 2026-06-29_
