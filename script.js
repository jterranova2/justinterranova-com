(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  document.getElementById("y") && (document.getElementById("y").textContent = String(new Date().getFullYear()));

  /* —— Mobile nav —— */
  var toggle = document.querySelector(".nav-toggle");
  var links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* —— Page cursor spotlight —— */
  if (finePointer && !coarsePointer && !reduceMotion) {
    document.body.classList.add("has-pointer");
    var root = document.documentElement;
    var raf = null;
    var mx = 0;
    var my = 0;
    window.addEventListener(
      "pointermove",
      function (e) {
        mx = e.clientX;
        my = e.clientY;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          root.style.setProperty("--mx", mx + "px");
          root.style.setProperty("--my", my + "px");
          raf = null;
        });
      },
      { passive: true }
    );
  }

  /* —— Card spotlight —— */
  if (finePointer && !coarsePointer && !reduceMotion) {
    document.querySelectorAll("[data-spotlight]").forEach(function (card) {
      card.addEventListener(
        "pointermove",
        function (e) {
          var rect = card.getBoundingClientRect();
          var x = ((e.clientX - rect.left) / rect.width) * 100;
          var y = ((e.clientY - rect.top) / rect.height) * 100;
          card.style.setProperty("--spot-x", x + "%");
          card.style.setProperty("--spot-y", y + "%");
        },
        { passive: true }
      );
    });
  }

  /* —— Scroll reveals —— */
  var reveals = document.querySelectorAll(".reveal");
  if (reduceMotion) {
    reveals.forEach(function (el) {
      el.classList.add("in");
    });
  } else if ("IntersectionObserver" in window) {
    var revObs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            revObs.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    reveals.forEach(function (el) {
      revObs.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("in");
    });
  }

  /* —— KPI count-up —— */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count") || "0");
    var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    var duration = 1200;
    var start = performance.now();

    function frame(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = target * eased;
      var text =
        prefix +
        (decimals > 0 ? value.toFixed(decimals) : String(Math.round(value))) +
        suffix;
      el.textContent = text;
      if (t < 1) requestAnimationFrame(frame);
    }

    if (reduceMotion) {
      el.textContent =
        prefix +
        (decimals > 0 ? target.toFixed(decimals) : String(Math.round(target))) +
        suffix;
      return;
    }
    requestAnimationFrame(frame);
  }

  var kpiSection = document.querySelector(".kpi-strip");
  if (kpiSection) {
    var counted = false;
    function runCounts() {
      if (counted) return;
      counted = true;
      kpiSection.querySelectorAll("[data-count]").forEach(animateCount);
    }
    if (reduceMotion) {
      runCounts();
    } else if ("IntersectionObserver" in window) {
      var kpiObs = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              runCounts();
              kpiObs.disconnect();
            }
          });
        },
        { threshold: 0.35 }
      );
      kpiObs.observe(kpiSection);
    } else {
      runCounts();
    }
  }

  /* —— Active section highlighting —— */
  var sectionLinks = Array.prototype.slice.call(
    document.querySelectorAll('.nav-links a[data-section]')
  );
  if (sectionLinks.length && "IntersectionObserver" in window) {
    var sections = sectionLinks
      .map(function (a) {
        return document.getElementById(a.getAttribute("data-section"));
      })
      .filter(Boolean);

    var activeId = null;
    var secObs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) activeId = entry.target.id;
        });
        sectionLinks.forEach(function (a) {
          var id = a.getAttribute("data-section");
          a.classList.toggle("active", id === activeId);
        });
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: 0 }
    );
    sections.forEach(function (s) {
      secObs.observe(s);
    });
  }
})();
