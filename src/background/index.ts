import { AUTO_INDEX_BURST_DETAIL_LIMIT, IndexedDBWorkerLease, IndexingScheduler } from './indexer';
import { createAutoIndexTriggerController, type AutoIndexTriggerRequest } from './auto-index-trigger';
import { ChatGPTPageTransport } from './chatgpt-page-transport';
import { ChatGPTConversationAdapter } from '../chatgpt';
import { getDataDiagnostics } from '../data';
import { openDeepSearchDatabase } from '../data';
import { searchExact } from '../search';
import type {
  DeepSearchGetDataDiagnosticsResponse,
  DeepSearchGetIndexerDiagnosticsResponse,
  DeepSearchPanelStateResponse,
  DeepSearchQueryMessage,
  DeepSearchQueryResponse,
  DeepSearchRebuildIndexResponse,
  DeepSearchRunAutoIndexCheckResponse,
  DeepSearchStartIndexingTestRunResponse,
  SearchPanelStateSnapshot
} from '../shared/types';

const INDEXER_OWNER_ID = createOwnerId();
const AUTO_INDEX_ALARM_NAME = 'chatgpt-deep-search-auto-index';
const AUTO_INDEX_WAKE_DELAY_MS = 60_000;
let schedulerPromise: Promise<IndexingScheduler> | null = null;
const autoIndexTrigger = createAutoIndexTriggerController(runAutoIndex);

chrome.runtime.onInstalled.addListener(() => {
  console.info('[ChatGPT Deep Search] development scaffold installed');
  void triggerAutoIndex({ reason: 'installed', scanList: true });
});

chrome.runtime.onStartup.addListener(() => {
  void triggerAutoIndex({ reason: 'startup', scanList: true });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_INDEX_ALARM_NAME) return;
  void triggerAutoIndex({ reason: 'alarm', scanList: true });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isMessageType(message, 'DEEP_SEARCH_PING')) {
    sendResponse({ ok: true, source: 'background' });
    return;
  }

  if (isMessageType(message, 'DEEP_SEARCH_GET_DATA_DIAGNOSTICS')) {
    void getDataDiagnostics()
      .then((diagnostics) => {
        sendResponse({
          ok: true,
          diagnostics
        } satisfies DeepSearchGetDataDiagnosticsResponse);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchGetDataDiagnosticsResponse);
      });
    return true;
  }

  if (isMessageType(message, 'DEEP_SEARCH_PANEL_STATE')) {
    void getPanelState()
      .then((state) => {
        sendResponse({
          ok: true,
          state
        } satisfies DeepSearchPanelStateResponse);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchPanelStateResponse);
      });
    return true;
  }

  if (isDeepSearchQueryMessage(message)) {
    void runSearchQuery(message)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchQueryResponse);
      });
    return true;
  }

  if (isMessageType(message, 'DEEP_SEARCH_START_INDEXING_TEST_RUN')) {
    void getScheduler()
      .then((scheduler) => scheduler.startTestRun())
      .then((result) => {
        sendResponse({
          ok: true,
          ...result
        } satisfies DeepSearchStartIndexingTestRunResponse);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchStartIndexingTestRunResponse);
      });
    return true;
  }

  if (isMessageType(message, 'DEEP_SEARCH_CONTENT_READY')) {
    void triggerAutoIndex({ reason: 'content-ready', scanList: true });
    sendResponse({ ok: true });
    return;
  }

  if (isCurrentConversationMessage(message, 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN')) {
    void triggerAutoIndex({
      reason: 'current-conversation-seen',
      scanList: false,
      currentConversationId: message.conversationId
    });
    sendResponse({ ok: true });
    return;
  }

  if (isCurrentConversationMessage(message, 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED')) {
    void triggerAutoIndex({
      reason: 'current-conversation-changed',
      scanList: false,
      currentConversationId: message.conversationId
    });
    sendResponse({ ok: true });
    return;
  }

  if (isMessageType(message, 'DEEP_SEARCH_RUN_AUTO_INDEX_CHECK')) {
    void triggerAutoIndex({ reason: 'manual-check', scanList: true })
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchRunAutoIndexCheckResponse);
      });
    return true;
  }

  if (isMessageType(message, 'DEEP_SEARCH_REBUILD_INDEX')) {
    void getScheduler()
      .then((scheduler) => scheduler.rebuildIndex())
      .then((result) => triggerAutoIndex({ reason: 'rebuild-index', scanList: true }).then(() => result))
      .then((result) => {
        sendResponse({
          ok: true,
          ...result
        } satisfies DeepSearchRebuildIndexResponse);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchRebuildIndexResponse);
      });
    return true;
  }

  if (isMessageType(message, 'DEEP_SEARCH_GET_INDEXER_DIAGNOSTICS')) {
    void getScheduler()
      .then((scheduler) => scheduler.getIndexerDiagnostics())
      .then((diagnostics) => {
        sendResponse({
          ok: true,
          diagnostics
        } satisfies DeepSearchGetIndexerDiagnosticsResponse);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies DeepSearchGetIndexerDiagnosticsResponse);
      });
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;

  chrome.tabs.sendMessage(tab.id, { type: 'DEEP_SEARCH_OPEN_PANEL' }, () => {
    void chrome.runtime.lastError;
  });
});

function isMessageType(message: unknown, type: string): boolean {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === type;
}

function isDeepSearchQueryMessage(message: unknown): message is DeepSearchQueryMessage {
  if (!isMessageType(message, 'DEEP_SEARCH_QUERY')) return false;
  const maybeMessage = message as { query?: unknown };
  const query = maybeMessage.query;
  return typeof query === 'object' && query !== null && typeof (query as { text?: unknown }).text === 'string';
}

function isCurrentConversationMessage(
  message: unknown,
  type: 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' | 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED'
): message is { type: typeof type; conversationId: string } {
  if (!isMessageType(message, type)) return false;
  return typeof (message as { conversationId?: unknown }).conversationId === 'string';
}

async function triggerAutoIndex(options: {
  readonly reason: string;
  readonly scanList: boolean;
  readonly currentConversationId?: string;
}): Promise<DeepSearchRunAutoIndexCheckResponse> {
  return autoIndexTrigger.trigger(options);
}

async function runAutoIndex(options: AutoIndexTriggerRequest): Promise<DeepSearchRunAutoIndexCheckResponse> {
  const scheduler = await getScheduler();
  const result = await scheduler.runAutoIndexCycle({
    reason: options.reason,
    scanList: options.scanList,
    maxDetailsThisRun: AUTO_INDEX_BURST_DETAIL_LIMIT,
    ...(options.currentConversationId ? { currentConversationId: options.currentConversationId } : {})
  });
  await scheduleAutoIndexWake(scheduler);

  return {
    ok: true,
    ...result
  };
}

async function scheduleAutoIndexWake(scheduler: IndexingScheduler): Promise<void> {
  const nextWakeAt = Date.now() + AUTO_INDEX_WAKE_DELAY_MS;
  chrome.alarms.create(AUTO_INDEX_ALARM_NAME, {
    when: nextWakeAt
  });
  scheduler.setNextWakeAt(nextWakeAt);
}

async function getPanelState(): Promise<SearchPanelStateSnapshot> {
  const database = await openDeepSearchDatabase();
  try {
    return await readPanelState(database);
  } finally {
    database.close();
  }
}

async function runSearchQuery(message: DeepSearchQueryMessage): Promise<DeepSearchQueryResponse> {
  const database = await openDeepSearchDatabase();
  try {
    const [conversations, messages, state] = await Promise.all([
      database.getConversationRecords(),
      database.getMessageRecords(),
      readPanelState(database)
    ]);
    const results = searchExact({
      query: message.query,
      conversations,
      messages
    });
    const limit = Math.max(0, Math.min(message.limit ?? 30, 100));

    return {
      ok: true,
      results: results.slice(0, limit),
      total: results.length,
      state
    };
  } finally {
    database.close();
  }
}

async function readPanelState(database: Awaited<ReturnType<typeof openDeepSearchDatabase>>): Promise<SearchPanelStateSnapshot> {
  const [diagnostics, checkpoints] = await Promise.all([database.getDataDiagnostics(), database.getCheckpointRecords()]);
  const checkpoint = checkpoints.slice().sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  const hasActiveQueue = diagnostics.queueCounts.pending > 0 || diagnostics.queueCounts.running > 0;
  const failedWithEmptyDatabase =
    diagnostics.queueCounts.failed > 0 && diagnostics.conversationCount === 0 && diagnostics.messageCount === 0;
  const hasSuccessfulList = diagnostics.lastSuccessfulListAt !== null;
  const targetCount = checkpoint?.retainedCount ?? diagnostics.retainedConversationCount ?? diagnostics.conversationCount;
  const completedCount = diagnostics.queueCounts.completed;
  const status =
    checkpoint?.status === 'failed' || failedWithEmptyDatabase
      ? 'error'
      : !hasSuccessfulList && targetCount === 0
        ? 'initializing'
        : targetCount > 0 && completedCount < targetCount && hasActiveQueue
          ? 'indexing'
          : diagnostics.messageCount > 0
            ? 'completed'
            : hasSuccessfulList
              ? 'empty'
              : 'initializing';
  const progress =
    status === 'indexing'
      ? {
          processedCount: checkpoint?.processedCount ?? diagnostics.queueCounts.completed,
          retainedCount: checkpoint?.retainedCount ?? diagnostics.retainedConversationCount,
          totalCount: targetCount
        }
      : null;
  const lastSuccessAt = Math.max(
    diagnostics.lastSuccessfulDetailAt ?? 0,
    diagnostics.lastSuccessfulListAt ?? 0,
    diagnostics.lastCompletedAt ?? 0
  );

  return {
    status,
    conversationCount: diagnostics.conversationCount,
    messageCount: diagnostics.messageCount,
    retainedConversationCount: diagnostics.retainedConversationCount,
    queueCounts: diagnostics.queueCounts,
    checkpoint,
    progress,
    lastErrorAt: diagnostics.lastErrorAt,
    lastError: checkpoint?.lastErrorDiagnostic ?? diagnostics.lastError,
    lastSuccessAt: lastSuccessAt > 0 ? lastSuccessAt : null
  };
}

function getScheduler(): Promise<IndexingScheduler> {
  schedulerPromise ??= createScheduler();
  return schedulerPromise;
}

async function createScheduler(): Promise<IndexingScheduler> {
  const database = await openDeepSearchDatabase();
  return new IndexingScheduler({
    adapter: new ChatGPTConversationAdapter({ transport: new ChatGPTPageTransport() }),
    database,
    lease: new IndexedDBWorkerLease(database, {
      ownerId: INDEXER_OWNER_ID
    }),
    ownerId: INDEXER_OWNER_ID
  });
}

function createOwnerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `sw-${crypto.randomUUID()}`;
  }
  return `sw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
