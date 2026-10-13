import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEEP_SEARCH_DB_NAME,
  DEEP_SEARCH_DB_VERSION,
  createMessageKey,
  openDeepSearchDatabase,
  type DeepSearchDatabase
} from '../../src/data';
import type { ConversationRecord, ConversationSnapshot, MessageRecord, QueueItemRecord } from '../../src/shared/types';

let indexedDBFactory: IDBFactory;
let currentTime: number;

beforeEach(() => {
  indexedDBFactory = new FakeIDBFactory() as unknown as IDBFactory;
  currentTime = 1_700_000_000_000;
});

describe('DeepSearchDatabase schema and migrations', () => {
  it('creates the v2 schema with stores, indexes, and metadata on fresh open', async () => {
    const database = await openTestDatabase();
    try {
      expect(database.native.version).toBe(DEEP_SEARCH_DB_VERSION);
      expect(objectStoreNames(database.native)).toEqual(
        expect.arrayContaining(['conversations', 'messages', 'queueItems', 'checkpoints', 'diagnostics', 'metadata'])
      );

      expect(indexNames(database.native, 'conversations')).toEqual(expect.arrayContaining(['updatedAt', 'retentionRank']));
      expect(indexNames(database.native, 'messages')).toEqual(
        expect.arrayContaining(['conversationId', 'conversationId_order'])
      );
      expect(indexNames(database.native, 'queueItems')).toEqual(
        expect.arrayContaining(['conversationId', 'status', 'availableAt', 'status_availableAt'])
      );

      const diagnostics = await database.getDataDiagnostics();
      expect(diagnostics).toMatchObject({
        dbName: DEEP_SEARCH_DB_NAME,
        dbVersion: DEEP_SEARCH_DB_VERSION,
        schemaVersion: DEEP_SEARCH_DB_VERSION,
        conversationCount: 0,
        messageCount: 0,
        retainedConversationCount: 0,
        queueCounts: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0
        },
        checkpointCount: 0
      });
      expect(diagnostics.lastMigrationAt).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it('migrates a legacy v1 database without losing conversations or messages', async () => {
    await createLegacyV1Database();

    const database = await openTestDatabase();
    try {
      expect(database.native.version).toBe(2);
      expect(objectStoreNames(database.native)).toEqual(
        expect.arrayContaining(['conversations', 'messages', 'queueItems', 'checkpoints', 'diagnostics', 'metadata'])
      );

      const conversations = await database.getConversationRecords();
      const messages = await database.getMessageRecords();

      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        id: 'legacy-conversation',
        title: '旧版会话'
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        key: createMessageKey('legacy-conversation', 'legacy-message'),
        conversationId: 'legacy-conversation',
        text: '旧版 IndexedDB 中已经存在的完整消息'
      });

      const diagnostics = await database.getDataDiagnostics();
      expect(diagnostics.conversationCount).toBe(1);
      expect(diagnostics.messageCount).toBe(1);
      expect(diagnostics.lastMigrationAt).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});

describe('DeepSearchDatabase records', () => {
  it('upserts conversation snapshots idempotently and deduplicates messages without truncating text', async () => {
    const database = await openTestDatabase();
    const fullText = [
      '连续中文子串必须原样保留，不能截断。',
      'English and numbers 12345 stay searchable.',
      '```ts',
      'const exact = "深度搜索";',
      '```'
    ].join('\n');

    const snapshot: ConversationSnapshot = {
      id: 'conversation-1',
      title: '固定测试会话',
      createdAt: 10,
      updatedAt: 20,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          order: 0,
          text: fullText,
          createdAt: 11
        },
        {
          id: 'message-1',
          role: 'user',
          order: 0,
          text: fullText,
          createdAt: 11
        },
        {
          id: 'message-2',
          role: 'assistant',
          order: 1,
          text: '助手回复全文也要保留。'
        }
      ]
    };

    try {
      await database.upsertConversationSnapshots([snapshot, snapshot]);

      const conversations = await database.getConversationRecords();
      const messages = await database.getMessageRecords();

      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        id: 'conversation-1',
        title: '固定测试会话',
        messageCount: 2,
        retentionRank: null
      });
      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.key).sort()).toEqual([
        createMessageKey('conversation-1', 'message-1'),
        createMessageKey('conversation-1', 'message-2')
      ]);
      expect(messages.find((message) => message.id === 'message-1')?.text).toBe(fullText);
    } finally {
      database.close();
    }
  });

  it('retains only the latest 200 conversations and removes evicted messages and queue items', async () => {
    const database = await openTestDatabase();
    const snapshots = Array.from({ length: 205 }, (_, index) => createSnapshot(index));

    try {
      await database.upsertConversationSnapshots(snapshots);
      await database.enqueueConversation('conversation-000', 'initial');
      await database.enqueueConversation('conversation-204', 'initial');

      const result = await database.applyRetentionLimit(200);
      const conversations = await database.getConversationRecords();
      const messages = await database.getMessageRecords();
      const queueItems = await database.getQueueItemRecords();

      expect(result).toEqual({
        retainedCount: 200,
        deletedCount: 5
      });
      expect(conversations).toHaveLength(200);
      expect(messages).toHaveLength(200);
      expect(conversations.some((conversation) => conversation.id === 'conversation-000')).toBe(false);
      expect(messages.some((message) => message.conversationId === 'conversation-000')).toBe(false);
      expect(queueItems.map((item) => item.conversationId)).toEqual(['conversation-204']);
      expect(findConversation(conversations, 'conversation-204')?.retentionRank).toBe(1);
      expect(findConversation(conversations, 'conversation-005')?.retentionRank).toBe(200);

      const diagnostics = await database.getDataDiagnostics();
      expect(diagnostics.retainedConversationCount).toBe(200);
      expect(diagnostics.lastRetentionAt).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it('persists queue transitions and resumable checkpoint state', async () => {
    const database = await openTestDatabase();

    try {
      const pending = await database.enqueueConversation('conversation-queue', 'initial', { availableAt: 123 });
      expect(pending).toMatchObject({
        id: 'conversation-queue',
        conversationId: 'conversation-queue',
        reason: 'initial',
        status: 'pending',
        attempts: 0,
        availableAt: 123,
        lastError: null
      });

      const running = await database.updateQueueItem(pending.id, {
        status: 'running',
        attempts: 1
      });
      expect(running.status).toBe('running');
      expect(running.attempts).toBe(1);

      const completed = await database.updateQueueItem(pending.id, {
        status: 'completed'
      });
      expect(completed.status).toBe('completed');

      const failed = await database.updateQueueItem(pending.id, {
        status: 'failed',
        attempts: 2,
        lastError: 'fixed fixture failure'
      });
      expect(failed).toMatchObject({
        status: 'failed',
        attempts: 2,
        lastError: 'fixed fixture failure'
      });

      await database.saveCheckpoint({
        id: 'initial-scan',
        kind: 'initial-index',
        status: 'running',
        cursor: 'cursor-1',
        processedCount: 10,
        retainedCount: 0,
        lastError: null
      });
      await database.saveCheckpoint({
        id: 'initial-scan',
        kind: 'initial-index',
        status: 'completed',
        cursor: null,
        processedCount: 200,
        retainedCount: 200,
        lastError: null
      });

      const queueItems = await database.getQueueItemRecords();
      const checkpoints = await database.getCheckpointRecords();

      expect(queueItems).toHaveLength(1);
      expect(queueItems[0]).toMatchObject({
        id: 'conversation-queue',
        status: 'failed',
        attempts: 2,
        lastError: 'fixed fixture failure'
      });
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        id: 'initial-scan',
        status: 'completed',
        cursor: null,
        processedCount: 200,
        retainedCount: 200
      });
    } finally {
      database.close();
    }
  });

  it('reports diagnostic counts without leaking conversation text', async () => {
    const database = await openTestDatabase();
    const secretText = '这段完整聊天正文不应该出现在诊断状态里';

    try {
      await database.upsertConversationSnapshots([
        {
          id: 'diagnostic-conversation',
          title: '诊断会话',
          updatedAt: 42,
          messages: [
            {
              id: 'diagnostic-message',
              role: 'assistant',
              order: 0,
              text: secretText
            }
          ]
        }
      ]);
      await database.enqueueConversation('diagnostic-conversation', 'initial');
      await database.updateQueueItem('diagnostic-conversation', { status: 'running', attempts: 1 });
      await database.saveCheckpoint({
        id: 'diagnostic-checkpoint',
        kind: 'diagnostic',
        status: 'completed',
        cursor: null,
        processedCount: 1,
        retainedCount: 1,
        lastError: null
      });
      await database.applyRetentionLimit(200);

      const diagnostics = await database.getDataDiagnostics();

      expect(diagnostics).toMatchObject({
        conversationCount: 1,
        messageCount: 1,
        retainedConversationCount: 1,
        checkpointCount: 1,
        queueCounts: {
          pending: 0,
          running: 1,
          completed: 0,
          failed: 0
        }
      });
      expect(JSON.stringify(diagnostics)).not.toContain(secretText);
      expect(JSON.stringify(diagnostics)).not.toContain('诊断会话');
    } finally {
      database.close();
    }
  });
});

async function openTestDatabase(): Promise<DeepSearchDatabase> {
  const now = () => {
    currentTime += 1;
    return currentTime;
  };
  return openDeepSearchDatabase({ indexedDB: indexedDBFactory, now });
}

function createSnapshot(index: number): ConversationSnapshot {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `conversation-${suffix}`,
    title: `固定会话 ${suffix}`,
    createdAt: index,
    updatedAt: index,
    messages: [
      {
        id: `message-${suffix}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        order: 0,
        text: `第 ${suffix} 条固定消息`
      }
    ]
  };
}

function findConversation(conversations: readonly ConversationRecord[], id: string): ConversationRecord | undefined {
  return conversations.find((conversation) => conversation.id === id);
}

async function createLegacyV1Database(): Promise<void> {
  const database = await openLegacyDatabase();
  const transaction = database.transaction(['conversations', 'messages'], 'readwrite');
  transaction.objectStore('conversations').put({
    id: 'legacy-conversation',
    title: '旧版会话',
    createdAt: 1,
    updatedAt: 2,
    indexedAt: 3,
    lastSeenAt: 4,
    messageCount: 1,
    retentionRank: null
  } satisfies ConversationRecord);
  transaction.objectStore('messages').put({
    key: createMessageKey('legacy-conversation', 'legacy-message'),
    conversationId: 'legacy-conversation',
    id: 'legacy-message',
    role: 'assistant',
    order: 0,
    text: '旧版 IndexedDB 中已经存在的完整消息',
    createdAt: 2,
    updatedAt: 2
  } satisfies MessageRecord);
  await transactionDone(transaction);
  database.close();
}

async function openLegacyDatabase(): Promise<IDBDatabase> {
  const request = indexedDBFactory.open(DEEP_SEARCH_DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore('conversations', { keyPath: 'id' });
    database.createObjectStore('messages', { keyPath: 'key' });
  };
  return requestToPromise(request);
}

function objectStoreNames(database: IDBDatabase): string[] {
  return domStringListToArray(database.objectStoreNames).sort();
}

function indexNames(database: IDBDatabase, storeName: string): string[] {
  const transaction = database.transaction(storeName, 'readonly');
  return domStringListToArray(transaction.objectStore(storeName).indexNames).sort();
}

function domStringListToArray(list: DOMStringList): string[] {
  return Array.from({ length: list.length }, (_, index) => list.item(index)).filter((name): name is string => name !== null);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
