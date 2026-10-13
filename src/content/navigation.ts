import type { SearchResult } from '../shared/types';

const TARGET_ATTRIBUTE = 'data-chatgpt-deep-search-target';

export interface SearchResultNavigationResult {
  readonly openedUrl: string;
  readonly located: boolean;
  readonly fallbackReason: 'missing-message-id' | 'message-not-found' | null;
}

export interface NavigateToSearchResultOptions {
  readonly window?: Window;
  readonly retryCount?: number;
  readonly retryDelayMs?: number;
}

export function buildConversationUrl(conversationId: string, origin = 'https://chatgpt.com'): string {
  const normalizedOrigin = origin.replace(/\/$/, '');
  return `${normalizedOrigin}/c/${encodeURIComponent(conversationId)}`;
}

export async function navigateToSearchResult(
  result: Pick<SearchResult, 'conversationId' | 'messageId'>,
  options: NavigateToSearchResultOptions = {}
): Promise<SearchResultNavigationResult> {
  const win = options.window ?? window;
  const origin = resolveNavigationOrigin(win);
  const openedUrl = buildConversationUrl(result.conversationId, origin);
  const currentUrl = `${win.location.origin}${win.location.pathname}`;

  if (currentUrl !== openedUrl) {
    win.history.pushState({}, '', openedUrl);
    const event = typeof PopStateEvent === 'function' ? new PopStateEvent('popstate') : new Event('popstate');
    win.dispatchEvent(event);
  }

  if (!result.messageId) {
    return {
      openedUrl,
      located: false,
      fallbackReason: 'missing-message-id'
    };
  }

  const element = await waitForMessageElement(win.document, result.messageId, {
    retryCount: options.retryCount ?? 16,
    retryDelayMs: options.retryDelayMs ?? 100
  });
  if (!element) {
    return {
      openedUrl,
      located: false,
      fallbackReason: 'message-not-found'
    };
  }

  markLocatedMessage(element);
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  }
  return {
    openedUrl,
    located: true,
    fallbackReason: null
  };
}

function resolveNavigationOrigin(win: Window): string {
  if (win.location.hostname === 'chatgpt.com') return 'https://chatgpt.com';
  return win.location.origin;
}

async function waitForMessageElement(
  doc: Document,
  messageId: string,
  options: { readonly retryCount: number; readonly retryDelayMs: number }
): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    const element = findMessageElement(doc, messageId);
    if (element) return element;
    if (attempt < options.retryCount) {
      await new Promise((resolve) => doc.defaultView?.setTimeout(resolve, options.retryDelayMs));
    }
  }
  return null;
}

function findMessageElement(doc: Document, messageId: string): HTMLElement | null {
  const escaped = escapeCssValue(messageId);
  return doc.querySelector<HTMLElement>(
    `[data-message-id="${escaped}"], [data-testid="conversation-turn-${escaped}"], #${escaped}`
  );
}

function markLocatedMessage(element: HTMLElement): void {
  element.setAttribute(TARGET_ATTRIBUTE, 'true');
  element.classList.add('chatgpt-deep-search-target-message');
  element.ownerDocument.defaultView?.setTimeout(() => {
    element.removeAttribute(TARGET_ATTRIBUTE);
    element.classList.remove('chatgpt-deep-search-target-message');
  }, 2_800);
}

function escapeCssValue(value: string): string {
  const css = globalThis.CSS as { escape?: (value: string) => string } | undefined;
  if (css?.escape) return css.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
