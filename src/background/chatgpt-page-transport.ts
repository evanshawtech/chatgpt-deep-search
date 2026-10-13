import {
  ChatGPTAdapterError,
  type ChatGPTTransport,
  type ChatGPTTransportRequest,
  type ChatGPTTransportResponse
} from '../chatgpt';
import type { DeepSearchChatGPTApiRequestMessage, DeepSearchChatGPTApiResponse } from '../shared/types';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const BRIDGE_TIMEOUT_MS = 12_000;

export class ChatGPTPageTransport implements ChatGPTTransport {
  public async request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse> {
    const path = normalizeAllowedPath(request.url);
    const response = await sendToChatGPTTab({
      type: 'DEEP_SEARCH_CHATGPT_API_REQUEST',
      requestId: createRequestId(),
      path,
      method: request.method,
      stage: request.stage === 'detail' ? 'detail' : 'list'
    });

    if (!response.ok && response.status === undefined) {
      throw new ChatGPTAdapterError({
        code: 'NETWORK_ERROR',
        recoverable: true,
        message: response.error ?? 'ChatGPT page bridge failed before receiving a response',
        diagnostic: {
          endpoint: path,
          method: request.method,
          httpStatus: null,
          backendErrorCode: 'page_bridge_failed',
          canRetry: true,
          stage: 'bridge',
          occurredAt: Date.now(),
          retryCount: 0,
          nextRetryAt: null
        }
      });
    }

    return {
      ok: response.ok,
      status: response.status ?? 0,
      headers: response.headers ?? {},
      json: async () => response.body
    };
  }
}

function normalizeAllowedPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.origin !== CHATGPT_ORIGIN) {
    throw new Error('Refusing to bridge a non-ChatGPT request');
  }

  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/backend-api/conversations') return path;
  if (url.pathname.startsWith('/backend-api/conversation/')) return path;
  throw new Error(`Refusing to bridge unsupported ChatGPT endpoint: ${url.pathname}`);
}

async function sendToChatGPTTab(message: DeepSearchChatGPTApiRequestMessage): Promise<DeepSearchChatGPTApiResponse> {
  const tabs = await chrome.tabs.query({ url: `${CHATGPT_ORIGIN}/*` });
  const candidates = tabs.filter((tab) => tab.id !== undefined);
  if (candidates.length === 0) {
    return {
      ok: false,
      requestId: message.requestId,
      error: 'No ChatGPT tab is available for same-origin API requests'
    };
  }

  let lastError: string | null = null;
  for (const tab of candidates) {
    const tabId = tab.id;
    if (tabId === undefined) continue;
    const response = await sendMessageWithTimeout(tabId, message);
    if (response.ok || response.status !== undefined) return response;
    lastError = response.error ?? lastError;
  }

  return {
    ok: false,
    requestId: message.requestId,
    error: lastError ?? 'No ChatGPT content script accepted the API bridge request'
  };
}

function sendMessageWithTimeout(
  tabId: number,
  message: DeepSearchChatGPTApiRequestMessage
): Promise<DeepSearchChatGPTApiResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        requestId: message.requestId,
        error: 'ChatGPT page bridge timed out'
      });
    }, BRIDGE_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, message, (response: DeepSearchChatGPTApiResponse | undefined) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError || !response) {
        resolve({
          ok: false,
          requestId: message.requestId,
          error: lastError?.message ?? 'ChatGPT page bridge returned no response'
        });
        return;
      }
      resolve(response);
    });
  });
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
