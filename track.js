// /track.js  (client-side helper)
// Fail-open: never break the page if tracking fails.
(function () {
  function psTrack(event, { nano_slug = null, is_anon = null } = {}) {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ event, nano_slug, is_anon })
      }).catch(() => {});
    } catch (_) {}
  }

  window.psTrack = psTrack;
})();
