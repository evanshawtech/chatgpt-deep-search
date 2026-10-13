import { describe, expect, it, vi } from 'vitest';
import { executeBridgeRequest, isBridgeRequest } from '../../src/content/chatgpt-api-bridge';
import type { DeepSearchChatGPTApiRequestMessage } from '../../src/shared/types';

describe('ChatGPT API bridge', () => {
  it('accepts only the explicit bridge message contract', () => {
    expect(
      isBridgeRequest({
        type: 'DEEP_SEARCH_CHATGPT_API_REQUEST',
        requestId: 'request-1',
        path: '/backend-api/conversations?offset=0&limit=3',
        method: 'GET',
        stage: 'list'
      })
    ).toBe(true);

    expect(isBridgeRequest({ type: 'DEEP_SEARCH_UNKNOWN', path: '/backend-api/conversations' })).toBe(false);
    expect(
      isBridgeRequest({
        type: 'DEEP_SEARCH_CHATGPT_API_REQUEST',
        requestId: 'request-1',
        path: 'https://example.com/',
        method: 'POST',
        stage: 'list'
      })
    ).toBe(false);
  });

  it('runs an allowed same-origin fetch and returns only safe response metadata', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ id: 'conversation-1', title: 'One' }], total: 1, offset: 0, limit: 3 }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'should-not-return',
          'retry-after': '2'
        }
      })
    );
    const win = createBridgeWindow('https://chatgpt.com', fetch);

    const response = await executeBridgeRequest(createRequest('/backend-api/conversations?offset=0&limit=3'), win);

    expect(response).toMatchObject({
      ok: true,
      requestId: 'request-1',
      status: 200,
      headers: {
        'content-type': 'application/json',
        'retry-after': '2'
      }
    });
    expect(response.headers).not.toHaveProperty('set-cookie');
    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/conversations?offset=0&limit=3',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        method: 'GET'
      })
    );
  });

  it('rejects requests outside the ChatGPT origin or endpoint allowlist', async () => {
    const response = await executeBridgeRequest(createRequest('/backend-api/conversations?offset=0&limit=3'), createBridgeWindow('https://evil.example', vi.fn()));
    expect(response).toMatchObject({
      ok: false,
      error: 'Rejected ChatGPT API bridge request outside chatgpt.com'
    });

    const unsupported = await executeBridgeRequest(
      createRequest('/api/auth/session'),
      createBridgeWindow('https://chatgpt.com', vi.fn())
    );
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error).toContain('unsupported ChatGPT API path');
  });
});

function createRequest(path: string): DeepSearchChatGPTApiRequestMessage {
  return {
    type: 'DEEP_SEARCH_CHATGPT_API_REQUEST',
    requestId: 'request-1',
    path,
    method: 'GET',
    stage: path.includes('/conversation/') ? 'detail' : 'list'
  };
}

function createBridgeWindow(origin: string, fetch: typeof globalThis.fetch): Window {
  return {
    location: { origin },
    navigator: { language: 'zh-CN' },
    fetch
  } as unknown as Window;
}
