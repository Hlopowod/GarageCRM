import { invokeWebCommand } from './webBackend';

export function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export async function invoke(command, args = undefined) {
  if (isTauriRuntime()) {
    const tauri = await import('@tauri-apps/api/core');
    return args === undefined ? tauri.invoke(command) : tauri.invoke(command, args);
  }
  return invokeWebCommand(command, args);
}

export async function listen(event, handler) {
  if (isTauriRuntime()) {
    const tauri = await import('@tauri-apps/api/event');
    return tauri.listen(event, handler);
  }
  return () => {};
}

export async function openUrl(url) {
  if (isTauriRuntime()) {
    const opener = await import('@tauri-apps/plugin-opener');
    return opener.openUrl(url);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return undefined;
}
