// Apply the saved theme before first paint (passed in the URL by main).
(function () {
  const q = new URLSearchParams(location.search);
  window.jarvisTheme.apply(q.get('theme') || undefined, q.get('mode') || undefined);
})();
