// Applies a theme to <html>: data-theme + data-mode. Mode "system" follows
// macOS appearance and updates live. Shared by the HUD and the Setup window.
(function () {
  const THEMES = ['jarvis', 'terminal', 'neon', 'stark', 'minimal'];
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  let wanted = { theme: 'jarvis', mode: 'dark' };
  const listeners = [];

  function resolve() {
    const theme = THEMES.includes(wanted.theme) ? wanted.theme : 'jarvis';
    const mode = wanted.mode === 'light' || (wanted.mode === 'system' && !dark.matches) ? 'light' : 'dark';
    return { theme, mode };
  }

  function apply(theme, mode) {
    if (theme) wanted.theme = theme;
    if (mode) wanted.mode = mode;
    const r = resolve();
    document.documentElement.dataset.theme = r.theme;
    document.documentElement.dataset.mode = r.mode;
    listeners.forEach((f) => f(r));
    return r;
  }

  dark.addEventListener('change', () => { if (wanted.mode === 'system') apply(); });
  window.jarvisTheme = { THEMES, apply, current: resolve, wanted: () => ({ ...wanted }), onChange: (f) => listeners.push(f) };
  apply();
})();
