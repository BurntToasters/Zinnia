interface InjectedExtractSession {
  archive: string;
  destination: string;
}

declare global {
  interface Window {
    __ZINNIA_EXTRACT__?: InjectedExtractSession;
  }
}

export function readInjectedExtractSession(): InjectedExtractSession | null {
  const injected = window.__ZINNIA_EXTRACT__;
  if (
    !injected ||
    typeof injected.archive !== "string" ||
    !injected.archive ||
    typeof injected.destination !== "string" ||
    !injected.destination
  ) {
    return null;
  }
  return injected;
}
