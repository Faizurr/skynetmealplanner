export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'att.theme';

export function readThemePref(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  // Keep the browser chrome / iOS status bar in sync with the manual choice.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (pref === 'system') {
      m.setAttribute('content', m.getAttribute('media')?.includes('dark') ? '#111214' : '#f6f6f4');
    } else {
      m.setAttribute('content', dark ? '#111214' : '#f6f6f4');
    }
  });
}

export function saveThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable (private mode) — keep the in-memory choice */
  }
  applyTheme(pref);
}
