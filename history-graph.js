// Tiny win/loss sparkline shared by the single-player and multiplayer side
// panels. Each entry is the net bankroll change for one settled round; bars
// grow up from a center baseline for wins and down for losses.

function renderResultHistory(containerId, history, maxEntries) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const recent = history.slice(-(maxEntries || 20));
  const maxAbs = Math.max(1, ...recent.map(h => Math.abs(h.net)));

  const bars = recent.map(h => {
    const cls = h.net > 0 ? 'win' : h.net < 0 ? 'lose' : 'push';
    const sign = h.net > 0 ? '+' : '';
    if (h.net === 0) {
      return `<div class="history-bar-wrap" title="Push"><div class="history-bar push"></div></div>`;
    }
    const heightPx = Math.max(3, Math.round((Math.abs(h.net) / maxAbs) * 20));
    return `<div class="history-bar-wrap" title="${sign}$${h.net}"><div class="history-bar ${cls}" style="height:${heightPx}px"></div></div>`;
  }).join('');

  container.innerHTML = `<div class="history-graph-inner"><div class="history-baseline"></div>${bars}</div>`;
  container.scrollLeft = container.scrollWidth;
}
