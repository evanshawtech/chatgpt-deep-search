import { describe, expect, it } from 'vitest';
import {
  ChatGPTAdapterError,
  ChatGPTConversationAdapter,
  type ChatGPTTransport,
  type ChatGPTTransportRequest,
  type ChatGPTTransportResponse
} from '../../src/chatgpt';
import listFixture from '../fixtures/chatgpt/conversation-list.json';
import alphaFixture from '../fixtures/chatgpt/conversation-alpha.json';
import betaFixture from '../fixtures/chatgpt/conversation-beta.json';
import malformedFixture from '../fixtures/chatgpt/malformed-detail.json';

describe('ChatGPTConversationAdapter', () => {
  it('normalizes conversation list fixtures without coupling callers to raw response shape', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        list: listFixture
      })
    });

    const page = await adapter.listConversations({ limit: 3 });

    expect(page.items).toHaveLength(5);
    expect(page.items[0]).toMatchObject({
      id: 'conversation-alpha',
      title: 'Alpha 深度搜索',
      createdAt: 1_710_000_000_000,
      updatedAt: 1_710_000_300_000
    });
    expect(page.nextCursor).toBe('cursor-after-five');
  });

  it('normalizes mapping-style conversation detail into full snapshots', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        details: {
          'conversation-alpha': alphaFixture
        }
      })
    });

    const snapshot = await adapter.getConversationDetail('conversation-alpha');

    expect(snapshot).toMatchObject({
      id: 'conversation-alpha',
      title: 'Alpha 深度搜索',
      createdAt: 1_710_000_000_000,
      updatedAt: 1_710_000_300_000
    });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      id: 'message-user-alpha',
      role: 'user',
      order: 0
    });
    expect(snapshot.messages[0]?.text).toContain('精确连续子串不能丢失');
    expect(snapshot.messages[0]?.text).toContain('code identifiers');
    expect(snapshot.messages[1]?.text).toContain('const phase = "three";');
    expect(snapshot.messages[1]?.text).toContain('最后一行不能截断');
  });

  it('normalizes alternate message-array detail fixtures with nested text parts', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        details: {
          'conversation-beta': betaFixture
        }
      })
    });

    const snapshot = await adapter.getConversationDetail('conversation-beta');

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      id: 'message-user-beta',
      role: 'user',
      text: 'Beta 用户消息正文。'
    });
    expect(snapshot.messages[1]?.text).toContain('Beta 助手嵌套 text 字段。');
    expect(snapshot.messages[1]?.text).toContain('第二段也要保留。');
  });

  it('rejects malformed detail payloads with structured sanitized errors', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        details: {
          'malformed-conversation': malformedFixture
        }
      })
    });

    await expect(adapter.getConversationDetail('malformed-conversation')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      recoverable: false
    });

    try {
      await adapter.getConversationDetail('malformed-conversation');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatGPTAdapterError);
      expect(String(error)).not.toContain('broken-message');
    }
  });

  it('rejects malformed list payloads instead of treating them as an empty account', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        list: { total: 3, offset: 0, limit: 3 }
      })
    });

    await expect(adapter.listConversations({ limit: 3 })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      recoverable: false
    });
  });

  it('maps HTTP failures to structured retryable adapter errors', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        detailResponses: {
          'conversation-alpha': {
            status: 429,
            headers: { 'retry-after': '2' },
            body: { error: 'Too many requests with sensitive backend detail' }
          }
        }
      })
    });

    await expect(adapter.getConversationDetail('conversation-alpha')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 2_000,
      recoverable: true,
      message: 'ChatGPT request failed with HTTP 429'
    });
  });

  it('marks 403 and 5xx responses recoverable without leaking backend bodies', async () => {
    const forbiddenAdapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        detailResponses: {
          'conversation-alpha': {
            status: 403,
            body: { error: 'Forbidden sensitive payload' }
          }
        }
      })
    });
    const serverAdapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        detailResponses: {
          'conversation-alpha': {
            status: 503,
            body: { error: 'Server sensitive payload' }
          }
        }
      })
    });

    await expect(forbiddenAdapter.getConversationDetail('conversation-alpha')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      recoverable: false,
      message: 'ChatGPT request failed with HTTP 403'
    });
    await expect(serverAdapter.getConversationDetail('conversation-alpha')).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 503,
      recoverable: true,
      message: 'ChatGPT request failed with HTTP 503'
    });
  });

  it('marks conversation_inaccessible with can_retry false as a permanent failure', async () => {
    const adapter = new ChatGPTConversationAdapter({
      transport: new FixtureTransport({
        detailResponses: {
          'conversation-alpha': {
            status: 404,
            body: {
              detail: {
                code: 'conversation_inaccessible',
                can_retry: false,
                message: 'Login required'
              }
            }
          }
        }
      })
    });

    await expect(adapter.getConversationDetail('conversation-alpha')).rejects.toMatchObject({
      code: 'CONVERSATION_INACCESSIBLE',
      status: 404,
      recoverable: false,
      diagnostic: expect.objectContaining({
        endpoint: '/backend-api/conversation/conversation-alpha',
        httpStatus: 404,
        backendErrorCode: 'conversation_inaccessible',
        canRetry: false,
        stage: 'detail'
      })
    });
  });
});

interface FixtureTransportOptions {
  readonly list?: unknown;
  readonly details?: Record<string, unknown>;
  readonly detailResponses?: Record<string, FixtureResponse>;
}

interface FixtureResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

class FixtureTransport implements ChatGPTTransport {
  private readonly options: FixtureTransportOptions;

  public constructor(options: FixtureTransportOptions) {
    this.options = options;
  }

  public async request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse> {
    if (request.url.includes('/backend-api/conversations')) {
      return jsonResponse(200, this.options.list ?? { items: [] });
    }

    const id = decodeURIComponent(request.url.split('/backend-api/conversation/')[1]?.split('?')[0] ?? '');
    const response = this.options.detailResponses?.[id];
    if (response) {
      return jsonResponse(response.status, response.body ?? {}, response.headers);
    }

    return jsonResponse(200, this.options.details?.[id] ?? {});
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): ChatGPTTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
