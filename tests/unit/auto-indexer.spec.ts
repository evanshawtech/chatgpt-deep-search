import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChatGPTAdapterError,
  ChatGPTConversationAdapter,
  type ChatGPTTransport,
  type ChatGPTTransportRequest,
  type ChatGPTTransportResponse
} from '../../src/chatgpt';
import {
  AUTO_INDEX_BURST_DETAIL_LIMIT,
  AUTO_INDEX_CONVERSATION_LIMIT,
  AUTO_INDEX_REAL_TEST_LIMIT,
  CHATGPT_ADAPTER_GENERATION,
  IndexedDBWorkerLease,
  IndexingScheduler,
  PHASE3_CONVERSATION_HARD_LIMIT
} from '../../src/background/indexer';
import { openDeepSearchDatabase, type DeepSearchDatabase } from '../../src/data';
import type { ConversationSnapshot } from '../../src/shared/types';
import { searchExact } from '../../src/search';

let indexedDBFactory: IDBFactory;
let currentTime: number;

beforeEach(() => {
  indexedDBFactory = new FakeIDBFactory() as unknown as IDBFactory;
  currentTime = Date.UTC(2026, 5, 1);
});

describe('automatic index maintenance', () => {
  it('keeps the production 200 cap while limiting the real repair run to three conversations', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport(createListItems(205));
    const snapshots = createListItems(205).map((item) => createSnapshot(item.id, item.title, item.updatedAt));

    try {
      await database.upsertConversationSnapshots(snapshots);
      await database.enqueueConversation('conversation-000', 'old-pending');

      const result = await createScheduler(database, transport, 'auto-retention').runAutoIndexCycle({ maxDetailsThisRun: 0 });
      const conversations = await database.getConversationRecords();
      const messages = await database.getMessageRecords();
      const queueItems = await database.getQueueItemRecords();

      expect(AUTO_INDEX_CONVERSATION_LIMIT).toBe(200);
      expect(AUTO_INDEX_REAL_TEST_LIMIT).toBe(3);
      expect(PHASE3_CONVERSATION_HARD_LIMIT).toBe(3);
      expect(result.listedCount).toBe(3);
      expect(result.retainedCount).toBe(200);
      expect(conversations).toHaveLength(200);
      expect(messages).toHaveLength(200);
      expect(conversations.some((conversation) => conversation.id === 'conversation-000')).toBe(false);
      expect(messages.some((message) => message.conversationId === 'conversation-000')).toBe(false);
      expect(queueItems.some((item) => item.conversationId === 'conversation-000')).toBe(false);
      expect(conversations.find((conversation) => conversation.id === 'conversation-204')?.retentionRank).toBe(1);
    } finally {
      database.close();
    }
  });

  it('indexes the first three real-run conversations serially', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport(createListItems(7));
    const scheduler = createScheduler(database, transport, 'auto-new');

    try {
      const result = await scheduler.runAutoIndexCycle();
      const conversations = await database.getConversationRecords();
      const queueItems = await database.getQueueItemRecords();

      expect(AUTO_INDEX_BURST_DETAIL_LIMIT).toBe(5);
      expect(result).toMatchObject({
        acquiredLease: true,
        listedCount: 3,
        enqueuedCount: 3,
        processedCount: 3,
        retainedCount: 3
      });
      expect(transport.detailIds).toEqual([
        'conversation-006',
        'conversation-005',
        'conversation-004'
      ]);
      expect(transport.maxActiveDetailRequests).toBe(1);
      expect(conversations).toHaveLength(3);
      expect(queueItems.filter((item) => item.status === 'completed')).toHaveLength(3);
      expect(queueItems.filter((item) => item.status === 'pending')).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('updates appended messages and title changes without duplicating existing messages', async () => {
    const database = await openTestDatabase();
    const initialUpdatedAt = Date.UTC(2026, 5, 2);
    const updatedAt = Date.UTC(2026, 5, 3);
    const listItem = {
      id: 'conversation-title',
      title: 'Updated title for exact search',
      createdAt: initialUpdatedAt,
      updatedAt
    };
    const transport = new AutoIndexTransport([
      {
        ...listItem,
        messages: ['first full message', 'second appended message']
      }
    ]);

    try {
      await database.upsertConversationSnapshots([
        {
          id: listItem.id,
          title: 'Old title',
          createdAt: initialUpdatedAt,
          updatedAt: initialUpdatedAt,
          messages: [
            {
              id: `${listItem.id}-message-0`,
              role: 'user',
              order: 0,
              text: 'first full message'
            }
          ]
        }
      ]);

      const scheduler = createScheduler(database, transport, 'auto-update');
      await scheduler.runAutoIndexCycle();
      await scheduler.runAutoIndexCycle();

      const conversations = await database.getConversationRecords();
      const messages = await database.getMessageRecords();
      const searchResults = searchExact({
        query: { text: 'title:"Updated title"', field: 'title' },
        conversations,
        messages
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        id: listItem.id,
        title: listItem.title,
        messageCount: 2
      });
      expect(messages.filter((message) => message.conversationId === listItem.id)).toHaveLength(2);
      expect(searchResults.map((result) => result.conversationId)).toEqual([listItem.id]);
    } finally {
      database.close();
    }
  });

  it('deduplicates repeated current-chat refresh events into one queue item', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport([]);
    const scheduler = createScheduler(database, transport, 'auto-current');

    try {
      await scheduler.runAutoIndexCycle({
        scanList: false,
        currentConversationId: 'conversation-current',
        reason: 'current-conversation-seen',
        maxDetailsThisRun: 0
      });
      await scheduler.runAutoIndexCycle({
        scanList: false,
        currentConversationId: 'conversation-current',
        reason: 'current-conversation-changed',
        maxDetailsThisRun: 0
      });

      const queueItems = await database.getQueueItemRecords();
      expect(queueItems).toHaveLength(1);
      expect(queueItems[0]).toMatchObject({
        id: 'conversation-current',
        status: 'pending'
      });
    } finally {
      database.close();
    }
  });

  it('recovers stale running queue items after worker suspension and resumes processing', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport([createListItem(1)]);

    try {
      await database.enqueueConversation('conversation-001', 'auto-new', { generation: CHATGPT_ADAPTER_GENERATION });
      await database.updateQueueItem('conversation-001', { status: 'running', attempts: 1 });
      currentTime += 120_000;

      const scheduler = createScheduler(database, transport, 'auto-restart');
      await scheduler.runAutoIndexCycle({ scanList: false });

      const queueItems = await database.getQueueItemRecords();
      const diagnostics = await scheduler.getIndexerDiagnostics();

      expect(queueItems[0]).toMatchObject({
        id: 'conversation-001',
        status: 'completed'
      });
      expect(diagnostics.offlineRecoveryCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it('discards dirty queue items from older generations before scheduling new work', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport([createListItem(1)]);

    try {
      await database.enqueueConversation('old-pending', 'old');
      await database.enqueueConversation('old-failed', 'old');
      await database.updateQueueItem('old-failed', { status: 'failed', attempts: 1, lastError: 'HTTP_ERROR' });

      const scheduler = createScheduler(database, transport, 'auto-generation-cleanup');
      await scheduler.runAutoIndexCycle();

      const queueItems = await database.getQueueItemRecords();
      expect(queueItems.some((item) => item.id === 'old-pending')).toBe(false);
      expect(queueItems.some((item) => item.id === 'old-failed')).toBe(false);
      expect(queueItems.every((item) => item.generation === CHATGPT_ADAPTER_GENERATION)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('backs off recoverable network and HTTP errors without blocking the worker', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport([createListItem(1)], {
      failures: {
        'conversation-001': [
          new ChatGPTAdapterError({
            code: 'NETWORK_ERROR',
            recoverable: true,
            message: 'offline'
          })
        ]
      }
    });

    try {
      const scheduler = createScheduler(database, transport, 'auto-backoff');
      const result = await scheduler.runAutoIndexCycle();
      const [pending] = await database.getQueueItemRecords();
      const firstAvailableAt = pending?.availableAt ?? 0;

      expect(result.processedCount).toBe(0);
      expect(pending).toMatchObject({
        id: 'conversation-001',
        status: 'pending',
        attempts: 1,
        lastError: 'NETWORK_ERROR'
      });
      expect(firstAvailableAt).toBeGreaterThan(currentTime);

      currentTime = firstAvailableAt + 1;
      await scheduler.runAutoIndexCycle({ scanList: false });

      const [completed] = await database.getQueueItemRecords();
      expect(completed).toMatchObject({
        id: 'conversation-001',
        status: 'completed',
        attempts: 2,
        lastError: null
      });
    } finally {
      database.close();
    }
  });

  it('marks conversation_inaccessible as permanently failed without retrying', async () => {
    const database = await openTestDatabase();
    const transport = new AutoIndexTransport([createListItem(1)], {
      failures: {
        'conversation-001': [
          new ChatGPTAdapterError({
            code: 'CONVERSATION_INACCESSIBLE',
            status: 404,
            recoverable: false,
            message: 'ChatGPT request failed with HTTP 404',
            diagnostic: {
              endpoint: '/backend-api/conversation/conversation-001',
              method: 'GET',
              httpStatus: 404,
              backendErrorCode: 'conversation_inaccessible',
              canRetry: false,
              stage: 'detail',
              occurredAt: currentTime,
              retryCount: 0,
              nextRetryAt: null
            }
          })
        ]
      }
    });

    try {
      const scheduler = createScheduler(database, transport, 'auto-inaccessible');
      const result = await scheduler.runAutoIndexCycle();
      const [failed] = await database.getQueueItemRecords();

      expect(result.processedCount).toBe(0);
      expect(failed).toMatchObject({
        id: 'conversation-001',
        status: 'failed',
        attempts: 1,
        lastError: 'CONVERSATION_INACCESSIBLE',
        lastErrorDiagnostic: expect.objectContaining({
          httpStatus: 404,
          backendErrorCode: 'conversation_inaccessible',
          canRetry: false,
          retryCount: 1,
          nextRetryAt: null
        })
      });
    } finally {
      database.close();
    }
  });


  it('prevents two automatic schedulers from processing the same queue under one lease', async () => {
    const database = await openTestDatabase();
    const firstScheduler = createScheduler(database, new AutoIndexTransport([createListItem(1)]), 'auto-lease-a');
    const secondScheduler = createScheduler(database, new AutoIndexTransport([createListItem(1)]), 'auto-lease-b');

    try {
      const firstResult = await firstScheduler.runAutoIndexCycle({ maxDetailsThisRun: 0 });
      const secondResult = await secondScheduler.runAutoIndexCycle({ maxDetailsThisRun: 0 });

      expect(firstResult.acquiredLease).toBe(true);
      expect(secondResult.acquiredLease).toBe(false);

      await firstScheduler.releaseLease();
      currentTime += 20_000;
      expect((await secondScheduler.runAutoIndexCycle({ maxDetailsThisRun: 0 })).acquiredLease).toBe(true);
    } finally {
      database.close();
    }
  });

  it('reports automatic diagnostics without leaking conversation body text', async () => {
    const database = await openTestDatabase();
    const secretBody = 'SECRET_BODY_精确连续子串不能丢失';
    const transport = new AutoIndexTransport([
      {
        ...createListItem(1),
        messages: [secretBody]
      }
    ]);

    try {
      const scheduler = createScheduler(database, transport, 'auto-diagnostics');
      await scheduler.runAutoIndexCycle();
      const diagnostics = await scheduler.getIndexerDiagnostics();
      const serialized = JSON.stringify(diagnostics);

      expect(diagnostics).toMatchObject({
        hardLimit: 3,
        autoLimit: 200,
        burstLimit: 5
      });
      expect(serialized).not.toContain(secretBody);
      expect(serialized).not.toContain('SECRET_BODY');
    } finally {
      database.close();
    }
  });
});

function createScheduler(database: DeepSearchDatabase, transport: AutoIndexTransport, ownerId: string): IndexingScheduler {
  return new IndexingScheduler({
    adapter: new ChatGPTConversationAdapter({ transport }),
    database,
    lease: new IndexedDBWorkerLease(database, {
      ownerId,
      now,
      ttlMs: 10_000
    }),
    ownerId,
    now,
    delay: async () => undefined,
    random: () => 0
  });
}

async function openTestDatabase(): Promise<DeepSearchDatabase> {
  return openDeepSearchDatabase({ indexedDB: indexedDBFactory, now });
}

function now(): number {
  currentTime += 1;
  return currentTime;
}

interface AutoListItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages?: readonly string[];
}

interface AutoTransportOptions {
  readonly failures?: Record<string, ChatGPTAdapterError[]>;
}

class AutoIndexTransport implements ChatGPTTransport {
  public readonly detailIds: string[] = [];
  public maxActiveDetailRequests = 0;
  private activeDetailRequests = 0;
  private readonly items: AutoListItem[];
  private readonly failures: Record<string, ChatGPTAdapterError[]>;

  public constructor(items: readonly AutoListItem[], options: AutoTransportOptions = {}) {
    this.items = items.slice().sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    this.failures = options.failures ?? {};
  }

  public async request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse> {
    const url = new URL(request.url);
    if (url.pathname === '/backend-api/conversations') {
      const limit = Number(url.searchParams.get('limit') ?? this.items.length);
      const offset = Number(url.searchParams.get('offset') ?? url.searchParams.get('cursor') ?? 0);
      const items = this.items.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return jsonResponse(200, {
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          create_time: item.createdAt,
          update_time: item.updatedAt
        })),
        next_cursor: nextOffset < this.items.length ? String(nextOffset) : null
      });
    }

    const id = decodeURIComponent(url.pathname.split('/backend-api/conversation/')[1] ?? '');
    this.detailIds.push(id);
    this.activeDetailRequests += 1;
    this.maxActiveDetailRequests = Math.max(this.maxActiveDetailRequests, this.activeDetailRequests);
    await Promise.resolve();
    this.activeDetailRequests -= 1;

    const failure = this.failures[id]?.shift();
    if (failure) throw failure;

    const item = this.items.find((candidate) => candidate.id === id) ?? createListItem(Number(id.replace(/\D/g, '') || '1'));
    return jsonResponse(200, createDetailPayload(item));
  }
}

function createListItems(count: number): AutoListItem[] {
  return Array.from({ length: count }, (_, index) => createListItem(index));
}

function createListItem(index: number): AutoListItem {
  const suffix = String(index).padStart(3, '0');
  const updatedAt = Date.UTC(2026, 5, 1) + index * 1_000;
  return {
    id: `conversation-${suffix}`,
    title: `Conversation ${suffix}`,
    createdAt: updatedAt - 500,
    updatedAt,
    messages: [`body for ${suffix}`]
  };
}

function createSnapshot(id: string, title: string, updatedAt: number): ConversationSnapshot {
  return {
    id,
    title,
    createdAt: updatedAt - 500,
    updatedAt,
    messages: [
      {
        id: `${id}-message-0`,
        role: 'user',
        order: 0,
        text: `stored body for ${id}`
      }
    ]
  };
}

function createDetailPayload(item: AutoListItem): unknown {
  return {
    id: item.id,
    title: item.title,
    create_time: item.createdAt,
    update_time: item.updatedAt,
    messages: (item.messages ?? [`detail body for ${item.id}`]).map((text, index) => ({
      id: `${item.id}-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: text,
      create_time: item.updatedAt + index
    }))
  };
}

function jsonResponse(status: number, body: unknown): ChatGPTTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {},
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
