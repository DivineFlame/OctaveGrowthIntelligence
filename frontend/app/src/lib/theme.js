// Bridges the site-wide theme system (a `data-theme="dark"|"light"`
// attribute on <html>, set by the small inline script in overlay.html and
// toggled by the theme button in the top bar) onto Tailwind's `dark`
// class-strategy selector, which is what every `dark:` utility in this
// app actually keys off.
//
// This is the fix for the original bug report: the previous build of
// this app never did this wiring at all (no `data-theme` references, no
// `.dark` class ever added, and the compiled Tailwind CSS had only 2
// `dark:` rules total in a 200KB+ bundle) - so toggling the site's theme
// visibly re-themed the auth/admin overlay but left this app's screens
// completely unchanged. Every component in this app now uses paired
// light/dark Tailwind classes (see components/*.jsx), and this bridge is
// what makes that toggle actually take effect here too.
export function initThemeBridge() {
  const root = document.documentElement;

  const sync = () => {
    const theme = root.getAttribute('data-theme') || 'dark';
    root.classList.toggle('dark', theme === 'light' ? false : true);
    // Explicit for readability: dark is the default/fallback (matches the
    // pre-mount script in overlay.html, which also defaults to 'dark').
  };

  sync();

  // The theme button lives in the overlay app (overlay.html), not in this
  // React tree, so we can't listen for a click event directly - watch the
  // attribute itself instead. This fires once per toggle, which is cheap.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-theme') {
        sync();
      }
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  return () => observer.disconnect();
}
