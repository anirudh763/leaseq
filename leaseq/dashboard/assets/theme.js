"use strict";
/* Light is the default, whatever the OS prefers. Dark applies only after the
   person chooses it with the "Use dark theme" button; that choice (and nothing
   else) is remembered in localStorage. Storage can be unavailable (private
   windows, blocked site data), so every access is wrapped in try/catch. */
(function () {
  var theme = "light";
  try { if (window.localStorage.getItem("leaseq-theme") === "dark") theme = "dark"; } catch (e) { /* light */ }
  document.documentElement.setAttribute("data-theme", theme);
})();
