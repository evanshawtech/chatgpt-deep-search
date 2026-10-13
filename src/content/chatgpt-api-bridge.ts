import type { DeepSearchChatGPTApiRequestMessage, DeepSearchChatGPTApiResponse } from '../shared/types';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const ALLOWED_ENDPOINTS = ['/backend-api/conversations', '/backend-api/conversation/'] as const;

export function installChatGPTApiBridge(win: Window = window): void {
  const runtime = (win as Window & { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.onMessage) return;

  runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isBridgeRequest(message)) return false;
    if (sender.id !== runtime.id) {
      sendResponse(createBridgeError(message.requestId, 'Rejected ChatGPT API bridge request from an unknown sender'));
      return false;
    }

    void executeBridgeRequest(message, win).then(sendResponse);
    return true;
  });
}

export function isBridgeRequest(message: unknown): message is DeepSearchChatGPTApiRequestMessage {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as Partial<DeepSearchChatGPTApiRequestMessage>;
  return (
    candidate.type === 'DEEP_SEARCH_CHATGPT_API_REQUEST' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.path === 'string' &&
    candidate.method === 'GET' &&
    (candidate.stage === 'list' || candidate.stage === 'detail')
  );
}

export async function executeBridgeRequest(
  message: DeepSearchChatGPTApiRequestMessage,
  win: Window = window
): Promise<DeepSearchChatGPTApiResponse> {
  if (win.location.origin !== CHATGPT_ORIGIN) {
    return createBridgeError(message.requestId, 'Rejected ChatGPT API bridge request outside chatgpt.com');
  }

  const url = new URL(message.path, CHATGPT_ORIGIN);
  if (!isAllowedEndpoint(url)) {
    return createBridgeError(message.requestId, `Rejected unsupported ChatGPT API path: ${url.pathname}`);
  }

  try {
    const response = await win.fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: createSafeRequestHeaders(url, win)
    });
    const body = await readJsonBody(response);
    return {
      ok: response.ok,
      requestId: message.requestId,
      status: response.status,
      headers: readSafeResponseHeaders(response.headers),
      body
    };
  } catch {
    return createBridgeError(message.requestId, 'ChatGPT API bridge fetch failed');
  }
}

function createSafeRequestHeaders(url: URL, win: Window): Record<string, string> {
  return {
    Accept: 'application/json',
    'Oai-Language': win.navigator.language || 'en-US',
    'X-Openai-Target-Path': url.pathname,
    'X-Openai-Target-Route': url.pathname
  };
}

function isAllowedEndpoint(url: URL): boolean {
  if (url.origin !== CHATGPT_ORIGIN) return false;
  return ALLOWED_ENDPOINTS.some((endpoint) =>
    endpoint.endsWith('/') ? url.pathname.startsWith(endpoint) : url.pathname === endpoint
  );
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readSafeResponseHeaders(headers: Headers): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  for (const name of ['content-type', 'retry-after']) {
    const value = headers.get(name);
    if (value) safeHeaders[name] = value;
  }
  return safeHeaders;
}

function createBridgeError(requestId: string, error: string): DeepSearchChatGPTApiResponse {
  return {
    ok: false,
    requestId,
    error
  };
}
