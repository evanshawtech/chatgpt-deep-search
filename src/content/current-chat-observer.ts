import type {
  DeepSearchContentReadyMessage,
  DeepSearchCurrentConversationChangedMessage,
  DeepSearchCurrentConversationSeenMessage
} from '../shared/types';

const ROUTE_EVENT = 'chatgpt-deep-search-locationchange';
const HISTORY_PATCH_KEY = '__chatgptDeepSearchHistoryPatch';
const CHANGE_DEBOUNCE_MS = 1_000;

type CurrentChatMessage =
  | DeepSearchContentReadyMessage
  | DeepSearchCurrentConversationSeenMessage
  | DeepSearchCurrentConversationChangedMessage;

export interface CurrentChatObserver {
  readonly stop: () => void;
}

export interface CurrentChatObserverOptions {
  readonly document?: Document;
  readonly sendMessage?: (message: CurrentChatMessage) => void;
  readonly debounceMs?: number;
}

declare global {
  interface Window {
    [HISTORY_PATCH_KEY]?: true;
  }
}

export function installCurrentChatObserver(options: CurrentChatObserverOptions = {}): CurrentChatObserver {
  const doc = options.document ?? document;
  const win = doc.defaultView ?? window;
  const sendMessage = options.sendMessage ?? createRuntimeMessageSender(win);
  const debounceMs = options.debounceMs ?? CHANGE_DEBOUNCE_MS;
  let lastConversationId: string | null = null;
  let changeTimer: number | null = null;

  patchHistory(win);

  const reportContentReady = (): void => {
    sendMessage({
      type: 'DEEP_SEARCH_CONTENT_READY',
      reason: 'content-ready'
    });
  };

  const reportRoute = (): void => {
    const conversationId = extractConversationId(win.location.pathname);
    if (!conversationId || conversationId === lastConversationId) return;

    lastConversationId = conversationId;
    sendMessage({
      type: 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN',
      conversationId,
      url: win.location.href
    });
  };

  const reportChanged = (): void => {
    const conversationId = extractConversationId(win.location.pathname);
    if (!conversationId) return;

    sendMessage({
      type: 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED',
      conversationId,
      url: win.location.href,
      title: doc.title
    });
  };

  const scheduleChanged = (): void => {
    if (!extractConversationId(win.location.pathname)) return;
    if (changeTimer !== null) {
      win.clearTimeout(changeTimer);
    }
    changeTimer = win.setTimeout(() => {
      changeTimer = null;
      reportChanged();
    }, debounceMs);
  };

  const routeListener = (): void => {
    reportRoute();
  };

  win.addEventListener(ROUTE_EVENT, routeListener);
  win.addEventListener('popstate', routeListener);

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isExtensionOnlyMutation)) return;
    scheduleChanged();
  });
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-message-id', 'data-testid', 'aria-label', 'title']
  });

  reportContentReady();
  reportRoute();

  return {
    stop: () => {
      observer.disconnect();
      win.removeEventListener(ROUTE_EVENT, routeListener);
      win.removeEventListener('popstate', routeListener);
      if (changeTimer !== null) {
        win.clearTimeout(changeTimer);
        changeTimer = null;
      }
    }
  };
}

export function extractConversationId(pathname: string): string | null {
  const match = /^\/c\/([^/?#]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function patchHistory(win: Window): void {
  if (win[HISTORY_PATCH_KEY]) return;
  win[HISTORY_PATCH_KEY] = true;

  const dispatchRouteEvent = (): void => {
    win.dispatchEvent(new Event(ROUTE_EVENT));
  };
  const originalPushState = win.history.pushState.bind(win.history);
  const originalReplaceState = win.history.replaceState.bind(win.history);

  win.history.pushState = (...args) => {
    const result = originalPushState(...args);
    dispatchRouteEvent();
    return result;
  };

  win.history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    dispatchRouteEvent();
    return result;
  };
}

function createRuntimeMessageSender(win: Window): (message: CurrentChatMessage) => void {
  return (message) => {
    const maybeChrome = (win as Window & { chrome?: typeof chrome }).chrome;
    if (!maybeChrome?.runtime?.sendMessage) return;

    maybeChrome.runtime.sendMessage(message, () => {
      void maybeChrome.runtime.lastError;
    });
  };
}

function isExtensionOnlyMutation(mutation: MutationRecord): boolean {
  const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
  if (nodes.length === 0 && mutation.target instanceof HTMLElement) {
    return mutation.target.id === 'chatgpt-deep-search-panel-host' || mutation.target.hasAttribute('data-chatgpt-deep-search-row');
  }

  return nodes.every((node) => {
    if (!(node instanceof HTMLElement)) return false;
    return (
      node.id === 'chatgpt-deep-search-panel-host' ||
      node.hasAttribute('data-chatgpt-deep-search-row') ||
      Boolean(node.querySelector?.('#chatgpt-deep-search-panel-host, [data-chatgpt-deep-search-row="true"]'))
    );
  });
}
