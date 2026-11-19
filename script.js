(function () {
  "use strict";
  var root = document.documentElement;
  var btn = document.querySelector(".theme");
  var dark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function current() {
    var set = root.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return dark && dark.matches ? "dark" : "light";
  }
  function label() {
    if (!btn) return;
    var next = current() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", "Switch to " + next + " theme");
    btn.setAttribute("title", "Switch to " + next + " theme");
  }
  if (btn) {
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
      label();
    });
  }
  if (dark && dark.addEventListener) dark.addEventListener("change", label);
  label();

  var y = document.querySelectorAll(".year");
  for (var i = 0; i < y.length; i++) y[i].textContent = String(new Date().getFullYear());

  var p = document.querySelector("[data-print]");
  if (p) p.addEventListener("click", function () { window.print(); });
})();
