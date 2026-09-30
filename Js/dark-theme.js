/* ==========================================================================
   dark-theme.js  —  Cardioa ECG dark mode controller

   Load as a plain, synchronous <script> in <head> (no defer/async) so the
   theme attribute is set before first paint and there is no white flash.

   Behaviour
   - Saved choice ("dark" | "light") wins; otherwise follows the OS setting
     (prefers-color-scheme) and keeps following it while no choice is saved.
   - Sets data-theme="dark" | "light" on <html>. All CSS is scoped to
     [data-theme="dark"]; "light" has no rules, i.e. the original design.
   - Every localStorage / matchMedia access is wrapped in try/catch, so a
     blocked or unavailable storage can never throw.
   - Adds one fixed-position button (created after DOMContentLoaded). It does
     not touch or move any existing element.
   ========================================================================== */
(function () {
  "use strict";

  if (window.__cardioaDarkTheme) return; // guard against double inclusion
  window.__cardioaDarkTheme = true;

  var STORAGE_KEY = "cardioa-theme";
  var META_DARK = "#0f1514"; // = --bg in dark-theme.css
  var root = document.documentElement;

  var mql = null;
  try {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
  } catch (_) {}

  var saved = null;
  try {
    var v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") saved = v;
  } catch (_) {}

  var originalMeta = null; // the site's own theme-color, restored in light mode
  var button = null;

  function systemPrefersDark() {
    return !!(mql && mql.matches);
  }

  function currentTheme() {
    return saved || (systemPrefersDark() ? "dark" : "light");
  }

  function syncMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return; // not parsed yet; called again on DOMContentLoaded
    if (originalMeta === null) originalMeta = meta.getAttribute("content") || "";
    meta.setAttribute("content", theme === "dark" ? META_DARK : originalMeta);
  }

  function syncButton(theme) {
    if (!button) return;
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    button.title = theme === "dark" ? "تغییر به حالت روشن" : "تغییر به حالت تیره";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    syncMeta(theme);
    syncButton(theme);
  }

  // Runs immediately (in <head>) -> theme is set before the first paint.
  apply(currentTheme());

  // Follow OS changes live, but only while the user has not chosen manually.
  if (mql) {
    var onSystemChange = function () {
      if (!saved) apply(currentTheme());
    };
    try {
      if (mql.addEventListener) mql.addEventListener("change", onSystemChange);
      else if (mql.addListener) mql.addListener(onSystemChange); // old Safari
    } catch (_) {}
  }

  function buildButton() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "dt-toggle";
    b.setAttribute("aria-label", "حالت تیره"); // fixed name + aria-pressed state
    b.innerHTML =
      '<svg class="dt-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
      '<svg class="dt-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<circle cx="12" cy="12" r="4.5"/>' +
      '<path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

    b.addEventListener("click", function () {
      saved = currentTheme() === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, saved);
      } catch (_) {} // storage blocked: the choice still applies for this visit
      apply(saved);
    });
    return b;
  }

  function init() {
    if (button || !document.body) return;
    button = buildButton();
    document.body.appendChild(button);
    syncMeta(currentTheme());
    syncButton(currentTheme());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
