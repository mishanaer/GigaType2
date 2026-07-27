(function (m, e, t, r, i, k, a) {
  m[i] =
    m[i] ||
    function () {
      (m[i].a = m[i].a || []).push(arguments);
    };
  m[i].l = 1 * new Date();

  for (var j = 0; j < document.scripts.length; j += 1) {
    if (document.scripts[j].src === r) {
      return;
    }
  }

  k = e.createElement(t);
  a = e.getElementsByTagName(t)[0];
  k.async = 1;
  k.src = r;
  a.parentNode.insertBefore(k, a);
})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");

ym(110570567, "init", {
  clickmap: true,
  trackLinks: true,
  accurateTrackBounce: true,
});

(function () {
  var downloadHistoryKey = "gigatype_app_downloaded";
  var hasDownloadedBefore = false;

  try {
    hasDownloadedBefore =
      window.localStorage.getItem(downloadHistoryKey) === "true";
  } catch {
    hasDownloadedBefore = false;
  }

  function wasDownloadedBefore() {
    if (hasDownloadedBefore) {
      return true;
    }

    try {
      hasDownloadedBefore =
        window.localStorage.getItem(downloadHistoryKey) === "true";
    } catch {
      return false;
    }

    return hasDownloadedBefore;
  }

  function rememberDownload() {
    hasDownloadedBefore = true;

    try {
      window.localStorage.setItem(downloadHistoryKey, "true");
    } catch {
      // Keep the in-memory flag when storage is unavailable.
    }
  }

  function getDownloadPlatform(link) {
    var signature = (
      link.href +
      " " +
      (link.getAttribute("download") || "")
    ).toLowerCase();

    if (/\.dmg(?:$|[?#])|macos|mac\b/.test(signature)) {
      return "macos";
    }

    if (/\.exe(?:$|[?#])|windows|win\b/.test(signature)) {
      return "windows";
    }

    return null;
  }

  document.addEventListener(
    "click",
    function (event) {
      if (!(event.target instanceof Element)) {
        return;
      }

      var downloadLink = event.target.closest("a[download]");
      if (!downloadLink) {
        return;
      }

      var platform = getDownloadPlatform(downloadLink);
      if (!platform) {
        return;
      }

      event.preventDefault();

      var isNavigationStarted = false;
      var continueDownload = function () {
        if (isNavigationStarted) {
          return;
        }

        isNavigationStarted = true;
        window.location.assign(downloadLink.href);
      };
      var platformGoal =
        platform === "macos"
          ? "click_button_download_macos"
          : "click_button_download_windows";

      ym(110570567, "reachGoal", "click_button_download");

      if (wasDownloadedBefore()) {
        ym(110570567, "reachGoal", platformGoal, {}, continueDownload);
        window.setTimeout(continueDownload, 800);
        return;
      }

      rememberDownload();
      ym(110570567, "reachGoal", platformGoal);
      ym(
        110570567,
        "reachGoal",
        "click_button_download_uniq",
        {},
        continueDownload,
      );
      window.setTimeout(continueDownload, 800);
    },
    true,
  );
})();
