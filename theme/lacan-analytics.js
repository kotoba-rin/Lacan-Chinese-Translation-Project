(function () {
  "use strict";
  // The hosted reader shares WordPress analytics; offline and other hosts stay independent.
  if (location.hostname !== "kotoba-rin.com" || location.protocol !== "https:") return;
  if (window.KotobaReaderAnalyticsLoading || window.KotobaAnalyticsVersion) return;
  window.KotobaReaderAnalyticsLoading = true;
  var script = document.createElement("script");
  script.async = true;
  script.src = "/wp-admin/admin-ajax.php?action=kotoba_matomo_tracker";
  document.head.appendChild(script);
})();
