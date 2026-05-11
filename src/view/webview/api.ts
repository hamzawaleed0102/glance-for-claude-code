import type { HostToWebview, WebviewToHost } from '../../shared/messages';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
};

const vsc = acquireVsCodeApi();

export function postToHost(msg: WebviewToHost): void {
  vsc.postMessage(msg);
}

export function listenFromHost(fn: (msg: HostToWebview) => void): () => void {
  const handler = (e: MessageEvent) => fn(e.data as HostToWebview);
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}
