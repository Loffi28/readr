let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
window.addEventListener('appinstalled', () => { deferred = null; });

export function installState() {
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { installed, canPrompt: !!deferred };
}

export async function promptInstall() {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => {});
  deferred = null;
}
