import { settings } from './state.js';

export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'auto' ? '' : settings.theme;
  if (!root.dataset.theme) delete root.dataset.theme;
  root.style.setProperty('--read-size', settings.fontSize + 'px');
  root.style.setProperty('--read-lh', settings.lineHeight);
  root.style.setProperty('--read-font', settings.readerFont === 'sans' ? 'var(--font-ui)' : 'var(--font-read)');
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = dark ? '#24211E' : '#F6F1E9'; m.removeAttribute('media'); });
}
