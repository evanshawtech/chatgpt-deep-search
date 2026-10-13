import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConversationUrl, navigateToSearchResult } from '../../src/content/navigation';
import { createDeepSearchPanel } from '../../src/content/panel';
import type { PanelSearchOptions, SearchPanelClient } from '../../src/content/panel-client';
import { createInitialPanelModel, derivePanelViewState } from '../../src/content/panel-state';
import type { SearchPanelStateSnapshot, SearchResult } from '../../src/shared/types';

afterEach(() => {
  document.getElementById('chatgpt-deep-search-panel-host')?.remove();
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

describe('search panel view state', () => {
  it('maps loading, empty, error, progress, and results to deterministic display state', () => {
    const base = createInitialPanelModel();

    expect(derivePanelViewState({ ...base, mode: 'loading', queryText: '精确搜索' })).toMatchObject({
      mode: 'loading',
      emptyMessage: '正在搜索本地索引...',
      showResults: false
    });

    expect(derivePanelViewState({ ...base, mode: 'empty', queryText: '不存在' })).toMatchObject({
      mode: 'empty',
      emptyMessage: '没有找到匹配结果。'
    });

    expect(derivePanelViewState({ ...base, mode: 'error', error: 'IndexedDB unavailable' })).toMatchObject({
      mode: 'error',
      errorMessage: 'IndexedDB unavailable'
    });

    expect(
      derivePanelViewState({
        ...base,
        mode: 'initial',
        state: createState({ status: 'indexing', processedCount: 2, totalCount: 5 })
      })
    ).toMatchObject({
      mode: 'progress',
      progressLabel: '正在索引 2 / 5 个对话',
      showProgress: true
    });

    expect(
      derivePanelViewState({
        ...base,
        mode: 'results',
        results: [createResult()],
        total: 6,
        state: createState()
      })
    ).toMatchObject({
      mode: 'results',
      footerCount: '显示前 1 / 6 条',
        showResults: true
      });
  });

  it('shows inaccessible conversation failures as errors instead of indexing progress', () => {
    const view = derivePanelViewState({
      ...createInitialPanelModel(),
      state: {
        ...createState({ status: 'error' }),
        conversationCount: 0,
        messageCount: 0,
        queueCounts: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 1
        },
        lastError: {
          endpoint: '/backend-api/conversation/conversation-1',
          method: 'GET',
          httpStatus: 404,
          backendErrorCode: 'conversation_inaccessible',
          canRetry: false,
          stage: 'detail',
          occurredAt: Date.UTC(2026, 5, 16),
          retryCount: 1,
          nextRetryAt: null
        }
      }
    });

    expect(view).toMatchObject({
      mode: 'error',
      showProgress: false,
      errorMessage: '无法访问该对话，当前 ChatGPT 会话认证无效或该对话已不可用。'
    });
  });
});

describe('search panel client integration', () => {
  it('preserves exact query text and selected filters in search requests', async () => {
    const searchCalls: PanelSearchOptions[] = [];
    const client: SearchPanelClient = {
      getState: async () => createState(),
      search: async (options) => {
        searchCalls.push(options);
        return {
          results: [createResult()],
          total: 1,
          state: createState()
        };
      }
    };

    const panel = createDeepSearchPanel(document, { client });
    panel.open();
    await Promise.resolve();

    const shadow = mustGetPanelShadow();
    const input = mustQuery<HTMLInputElement>(shadow, '[data-search-input]');
    const field = mustQuery<HTMLSelectElement>(shadow, '[data-field-filter]');
    const sort = mustQuery<HTMLSelectElement>(shadow, '[data-sort-filter]');
    field.value = 'assistant';
    sort.value = 'time';
    input.value = '  title:"深度搜索" | assistant:连续子串  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await waitFor(() => searchCalls.length === 1);

    expect(searchCalls[0]).toEqual({
      text: '  title:"深度搜索" | assistant:连续子串  ',
      field: 'assistant',
      sort: 'time',
      limit: 30
    });
    expect(mustQuery(shadow, '[data-panel]').getAttribute('data-panel-state')).toBe('results');
  });
});

describe('search result navigation', () => {
  it('builds the canonical ChatGPT conversation URL', () => {
    expect(buildConversationUrl('abc 123')).toBe('https://chatgpt.com/c/abc%20123');
  });

  it('marks the message when it can be found after navigation', async () => {
    const message = document.createElement('article');
    message.dataset.messageId = 'message-hit';
    document.body.append(message);

    const result = await navigateToSearchResult(
      {
        conversationId: 'conversation-hit',
        messageId: 'message-hit'
      },
      {
        window,
        retryCount: 0
      }
    );

    expect(result.located).toBe(true);
    expect(window.location.pathname).toBe('/c/conversation-hit');
    expect(message.getAttribute('data-chatgpt-deep-search-target')).toBe('true');
  });

  it('reports the explicit fallback when a message cannot be located', async () => {
    const result = await navigateToSearchResult(
      {
        conversationId: 'conversation-missing',
        messageId: 'message-missing'
      },
      {
        window,
        retryCount: 0
      }
    );

    expect(result).toMatchObject({
      located: false,
      fallbackReason: 'message-not-found'
    });
    expect(window.location.pathname).toBe('/c/conversation-missing');
  });
});

function createState(
  options: {
    readonly status?: SearchPanelStateSnapshot['status'];
    readonly processedCount?: number;
    readonly totalCount?: number;
  } = {}
): SearchPanelStateSnapshot {
  return {
    status: options.status ?? 'ready',
    conversationCount: 12,
    messageCount: 48,
    retainedConversationCount: 12,
    queueCounts: {
      pending: options.status === 'indexing' ? 1 : 0,
      running: 0,
      completed: 0,
      failed: 0
    },
    checkpoint:
      options.status === 'indexing'
        ? {
            id: 'phase-test',
            kind: 'test',
            status: 'running',
            cursor: 'conversation-3',
            processedCount: options.processedCount ?? 0,
            retainedCount: options.totalCount ?? 0,
            updatedAt: Date.UTC(2026, 5, 16),
            lastError: null
          }
        : null,
    progress:
      options.status === 'indexing'
        ? {
            processedCount: options.processedCount ?? 0,
            retainedCount: options.totalCount ?? 0,
            totalCount: options.totalCount ?? 0
          }
        : null,
    lastErrorAt: null,
    lastError: null,
    lastSuccessAt: null
  };
}

function createResult(): SearchResult {
  return {
    conversationId: 'conversation-hit',
    messageId: 'message-hit',
    title: '很长的 ChatGPT 深度搜索标题',
    role: 'assistant',
    date: Date.UTC(2026, 5, 16),
    score: 10,
    hitCount: 1,
    snippet: {
      text: '这里包含深度搜索命中片段',
      start: 0,
      end: 12
    },
    highlightSegments: [
      {
        text: '这里包含',
        highlighted: false
      },
      {
        text: '深度搜索',
        highlighted: true
      },
      {
        text: '命中片段',
        highlighted: false
      }
    ]
  };
}

function mustGetPanelShadow(): ShadowRoot {
  const host = document.getElementById('chatgpt-deep-search-panel-host');
  const shadow = host?.shadowRoot;
  if (!shadow) throw new Error('panel shadow root missing');
  return shadow;
}

function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing test element: ${selector}`);
  return element;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for predicate');
}
