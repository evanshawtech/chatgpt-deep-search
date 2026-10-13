export interface StartupReadinessOptions {
  readonly document?: Document;
  readonly quietDelayMs?: number;
}

export function afterStartupQuietWindow(options: StartupReadinessOptions = {}): Promise<void> {
  const doc = options.document ?? document;
  const quietDelayMs = options.quietDelayMs ?? 1_500;

  return new Promise((resolve) => {
    const waitForQuietWindow = (): void => {
      doc.defaultView?.setTimeout(resolve, quietDelayMs);
    };

    if (doc.readyState === 'complete') {
      waitForQuietWindow();
      return;
    }

    doc.defaultView?.addEventListener('load', waitForQuietWindow, { once: true });
  });
}
