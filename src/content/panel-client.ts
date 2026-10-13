import type {
  DeepSearchPanelStateResponse,
  DeepSearchQueryResponse,
  SearchField,
  SearchPanelStateSnapshot,
  SearchQuery,
  SearchResult,
  SearchSort
} from '../shared/types';

export interface PanelSearchOptions {
  readonly text: string;
  readonly field: SearchField;
  readonly sort: SearchSort;
  readonly limit?: number;
}

export interface PanelSearchResponse {
  readonly results: SearchResult[];
  readonly total: number;
  readonly state: SearchPanelStateSnapshot;
}

export interface SearchPanelClient {
  readonly getState: () => Promise<SearchPanelStateSnapshot>;
  readonly search: (options: PanelSearchOptions) => Promise<PanelSearchResponse>;
}

const EMPTY_PANEL_STATE: SearchPanelStateSnapshot = {
  status: 'empty',
  conversationCount: 0,
  messageCount: 0,
  retainedConversationCount: 0,
  queueCounts: {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0
  },
  checkpoint: null,
  progress: null,
  lastErrorAt: null,
  lastError: null,
  lastSuccessAt: null
};

export function createRuntimeSearchPanelClient(win: Window = window): SearchPanelClient {
  return {
    getState: async () => {
      const response = await sendRuntimeMessage<DeepSearchPanelStateResponse>(win, {
        type: 'DEEP_SEARCH_PANEL_STATE'
      });
      if (!response.ok || !response.state) {
        throw new Error(response.error ?? 'Unable to read search panel state');
      }
      return response.state;
    },
    search: async (options) => {
      const query: SearchQuery = {
        text: options.text,
        field: options.field,
        sort: options.sort
      };
      const response = await sendRuntimeMessage<DeepSearchQueryResponse>(win, {
        type: 'DEEP_SEARCH_QUERY',
        query,
        limit: options.limit ?? 30
      });
      if (!response.ok || !response.results || !response.state) {
        throw new Error(response.error ?? 'Search failed');
      }
      return {
        results: response.results,
        total: response.total ?? response.results.length,
        state: response.state
      };
    }
  };
}

export function createFallbackSearchPanelClient(): SearchPanelClient {
  return {
    getState: async () => EMPTY_PANEL_STATE,
    search: async () => ({
      results: [],
      total: 0,
      state: EMPTY_PANEL_STATE
    })
  };
}

function sendRuntimeMessage<TResponse>(win: Window, message: unknown): Promise<TResponse> {
  const runtime = getRuntime(win);
  if (!runtime?.sendMessage) {
    return Promise.resolve(createFallbackResponse(message) as TResponse);
  }

  return new Promise((resolve, reject) => {
    runtime.sendMessage(message, (response: TResponse) => {
      const lastError = runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getRuntime(win: Window): typeof chrome.runtime | null {
  const maybeChrome = (win as Window & { chrome?: typeof chrome }).chrome;
  return maybeChrome?.runtime ?? null;
}

function createFallbackResponse(message: unknown): DeepSearchPanelStateResponse | DeepSearchQueryResponse {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'DEEP_SEARCH_QUERY') {
    return {
      ok: true,
      results: [],
      total: 0,
      state: EMPTY_PANEL_STATE
    };
  }

  return {
    ok: true,
    state: EMPTY_PANEL_STATE
  };
}
