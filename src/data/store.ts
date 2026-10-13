import type {
  CheckpointRecord,
  ConversationRecord,
  ConversationSnapshot,
  DataDiagnostics,
  IndexingErrorDiagnostic,
  MessageRecord,
  QueueItemRecord,
  QueueItemStatus,
  QueueStatusCounts,
  WorkerLeaseRecord
} from '../shared/types';

export const DEEP_SEARCH_DB_NAME = 'chatgpt-deep-search';
export const DEEP_SEARCH_DB_VERSION = 2;

const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';
const QUEUE_ITEMS_STORE = 'queueItems';
const CHECKPOINTS_STORE = 'checkpoints';
const DIAGNOSTICS_STORE = 'diagnostics';
const METADATA_STORE = 'metadata';

const STORE_NAMES = [
  CONVERSATIONS_STORE,
  MESSAGES_STORE,
  QUEUE_ITEMS_STORE,
  CHECKPOINTS_STORE,
  DIAGNOSTICS_STORE,
  METADATA_STORE
] as const;

type DeepSearchStoreName = (typeof STORE_NAMES)[number];

interface SchemaMetadataRecord {
  id: 'schema';
  dbName: string;
  dbVersion: number;
  schemaVersion: number;
  previousVersion: number;
  lastMigrationAt: number;
}

interface RetentionMetadataRecord {
  id: 'retention';
  limit: number;
  retainedCount: number;
  deletedCount: number;
  lastRetentionAt: number;
}

interface ErrorMetadataRecord {
  id: 'lastError';
  message: string;
  lastErrorAt: number;
  diagnostic?: IndexingErrorDiagnostic | null;
}

interface IndexStatusMetadataRecord {
  id: 'indexStatus';
  activeGeneration: string | null;
  lastSuccessfulListAt: number | null;
  lastSuccessfulDetailAt: number | null;
  lastCompletedAt: number | null;
  updatedAt: number;
}

type MetadataRecord =
  | SchemaMetadataRecord
  | RetentionMetadataRecord
  | ErrorMetadataRecord
  | IndexStatusMetadataRecord
  | WorkerLeaseRecord;

export interface OpenDeepSearchDatabaseOptions {
  readonly indexedDB?: IDBFactory;
  readonly dbName?: string;
  readonly now?: () => number;
}

export interface RetentionResult {
  readonly retainedCount: number;
  readonly deletedCount: number;
}

export interface ConversationMetadataInput {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface ConversationMetadataUpsertResult {
  readonly conversationId: string;
  readonly isNew: boolean;
  readonly updatedAtChanged: boolean;
  readonly titleChanged: boolean;
}

export interface ResetStaleQueueResult {
  readonly resetCount: number;
}

export interface EnqueueConversationOptions {
  readonly availableAt?: number;
  readonly generation?: string;
}

export interface QueueItemUpdate {
  readonly reason?: string;
  readonly status?: QueueItemStatus;
  readonly attempts?: number;
  readonly availableAt?: number;
  readonly lastError?: string | null;
  readonly generation?: string;
  readonly lastErrorDiagnostic?: IndexingErrorDiagnostic | null;
}

export type CheckpointInput = Omit<CheckpointRecord, 'updatedAt'> & {
  readonly updatedAt?: number;
};

export interface SaveIndexStatusInput {
  readonly activeGeneration?: string | null;
  readonly lastSuccessfulListAt?: number | null;
  readonly lastSuccessfulDetailAt?: number | null;
  readonly lastCompletedAt?: number | null;
}

export interface DiscardQueueGenerationResult {
  readonly discardedCount: number;
}

export interface ResetIndexResult {
  readonly clearedQueueCount: number;
  readonly clearedConversationCount: number;
  readonly clearedMessageCount: number;
}

export async function openDeepSearchDatabase(options: OpenDeepSearchDatabaseOptions = {}): Promise<DeepSearchDatabase> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error('IndexedDB is not available in this environment');
  }

  const dbName = options.dbName ?? DEEP_SEARCH_DB_NAME;
  const now = options.now ?? Date.now;
  const request = factory.open(dbName, DEEP_SEARCH_DB_VERSION);

  request.onupgradeneeded = (event) => {
    const transaction = request.transaction;
    if (!transaction) {
      throw new Error('IndexedDB upgrade transaction is unavailable');
    }

    migrateDeepSearchDatabase(request.result, transaction, event.oldVersion, dbName, now());
  };

  const native = await requestToPromise(request);
  return new DeepSearchDatabase(native, dbName, now);
}

export async function getDataDiagnostics(options: OpenDeepSearchDatabaseOptions = {}): Promise<DataDiagnostics> {
  const database = await openDeepSearchDatabase(options);
  try {
    return await database.getDataDiagnostics();
  } finally {
    database.close();
  }
}

export class DeepSearchDatabase {
  public readonly native: IDBDatabase;
  private readonly dbName: string;
  private readonly now: () => number;

  public constructor(native: IDBDatabase, dbName = DEEP_SEARCH_DB_NAME, now: () => number = Date.now) {
    this.native = native;
    this.dbName = dbName;
    this.now = now;
  }

  public close(): void {
    this.native.close();
  }

  public async upsertConversationSnapshots(snapshots: readonly ConversationSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await this.upsertConversationSnapshot(snapshot);
    }
  }

  public async upsertConversationListMetadata(
    items: readonly ConversationMetadataInput[]
  ): Promise<ConversationMetadataUpsertResult[]> {
    const results: ConversationMetadataUpsertResult[] = [];

    for (const item of items) {
      const existingConversation = await this.getRecord<ConversationRecord>(CONVERSATIONS_STORE, item.id);
      const existingMessages = existingConversation ? await this.getMessagesForConversation(item.id) : [];
      const timestamp = this.now();
      const updatedAt = item.updatedAt ?? existingConversation?.updatedAt ?? item.createdAt ?? 0;
      const createdAt = item.createdAt ?? existingConversation?.createdAt ?? null;
      const title = item.title || existingConversation?.title || 'Untitled';
      const record: ConversationRecord = {
        id: item.id,
        title,
        createdAt,
        updatedAt,
        indexedAt: existingConversation?.indexedAt ?? 0,
        lastSeenAt: timestamp,
        messageCount: existingConversation?.messageCount ?? existingMessages.length,
        retentionRank: existingConversation?.retentionRank ?? null
      };

      await this.putRecord(CONVERSATIONS_STORE, record);
      results.push({
        conversationId: item.id,
        isNew: !existingConversation,
        updatedAtChanged: existingConversation ? existingConversation.updatedAt !== updatedAt : true,
        titleChanged: existingConversation ? existingConversation.title !== title : false
      });
    }

    return results;
  }

  public async applyRetentionLimit(limit = 200): Promise<RetentionResult> {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    const conversations = await this.getAllRecords<ConversationRecord>(CONVERSATIONS_STORE);
    const sortedConversations = conversations.slice().sort(compareConversationsForRetention);
    const retainedConversations = sortedConversations.slice(0, normalizedLimit);
    const deletedConversations = sortedConversations.slice(normalizedLimit);
    const retainedIds = new Set(retainedConversations.map((conversation) => conversation.id));
    const deletedIds = new Set(deletedConversations.map((conversation) => conversation.id));
    const allMessages = await this.getAllRecords<MessageRecord>(MESSAGES_STORE);
    const allQueueItems = await this.getAllRecords<QueueItemRecord>(QUEUE_ITEMS_STORE);
    const timestamp = this.now();

    const transaction = this.native.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE, QUEUE_ITEMS_STORE, METADATA_STORE],
      'readwrite'
    );
    const conversationsStore = transaction.objectStore(CONVERSATIONS_STORE);
    const messagesStore = transaction.objectStore(MESSAGES_STORE);
    const queueStore = transaction.objectStore(QUEUE_ITEMS_STORE);
    const metadataStore = transaction.objectStore(METADATA_STORE);

    retainedConversations.forEach((conversation, index) => {
      conversationsStore.put({
        ...conversation,
        retentionRank: index + 1
      } satisfies ConversationRecord);
    });

    deletedConversations.forEach((conversation) => {
      conversationsStore.delete(conversation.id);
    });

    allMessages.forEach((message) => {
      if (!retainedIds.has(message.conversationId)) {
        messagesStore.delete(message.key);
      }
    });

    allQueueItems.forEach((queueItem) => {
      if (deletedIds.has(queueItem.conversationId)) {
        queueStore.delete(queueItem.id);
      }
    });

    metadataStore.put({
      id: 'retention',
      limit: normalizedLimit,
      retainedCount: retainedConversations.length,
      deletedCount: deletedConversations.length,
      lastRetentionAt: timestamp
    } satisfies RetentionMetadataRecord);

    await transactionDone(transaction);
    return {
      retainedCount: retainedConversations.length,
      deletedCount: deletedConversations.length
    };
  }

  public async enqueueConversation(
    conversationId: string,
    reason: string,
    options: EnqueueConversationOptions = {}
  ): Promise<QueueItemRecord> {
    const existing = await this.getRecord<QueueItemRecord>(QUEUE_ITEMS_STORE, conversationId);
    const timestamp = this.now();
    const queueItem: QueueItemRecord = {
      id: conversationId,
      conversationId,
      reason,
      status: existing?.status === 'running' ? 'running' : 'pending',
      attempts: existing?.attempts ?? 0,
      availableAt: options.availableAt ?? timestamp,
      updatedAt: timestamp,
      lastError: null,
      ...(options.generation ? { generation: options.generation } : {}),
      lastErrorDiagnostic: null
    };

    await this.putRecord(QUEUE_ITEMS_STORE, queueItem);
    return queueItem;
  }

  public async getDueQueueItems(limit: number, timestamp = this.now(), generation?: string): Promise<QueueItemRecord[]> {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) return [];

    const queueItems = await this.getQueueItemRecords();
    return queueItems
      .filter((item) => item.status === 'pending' && item.availableAt <= timestamp)
      .filter((item) => generation === undefined || item.generation === generation)
      .sort(compareQueueItemsForScheduling)
      .slice(0, normalizedLimit);
  }

  public async resetStaleRunningQueueItems(staleBefore: number, generation?: string): Promise<ResetStaleQueueResult> {
    const queueItems = await this.getQueueItemRecords();
    const staleItems = queueItems
      .filter((item) => item.status === 'running' && item.updatedAt <= staleBefore)
      .filter((item) => generation === undefined || item.generation === generation);
    const timestamp = this.now();

    if (staleItems.length === 0) {
      return {
        resetCount: 0
      };
    }

    const transaction = this.native.transaction(QUEUE_ITEMS_STORE, 'readwrite');
    const queueStore = transaction.objectStore(QUEUE_ITEMS_STORE);
    staleItems.forEach((item) => {
      queueStore.put({
        ...item,
        status: 'pending',
        availableAt: timestamp,
        updatedAt: timestamp,
        lastError: item.lastError ?? 'STALE_WORKER_RECOVERY'
      } satisfies QueueItemRecord);
    });
    await transactionDone(transaction);

    return {
      resetCount: staleItems.length
    };
  }

  public async updateQueueItem(id: string, update: QueueItemUpdate): Promise<QueueItemRecord> {
    const existing = await this.getRecord<QueueItemRecord>(QUEUE_ITEMS_STORE, id);
    if (!existing) {
      throw new Error(`Queue item not found: ${id}`);
    }

    const timestamp = this.now();
    const updated: QueueItemRecord = {
      ...existing,
      ...update,
      updatedAt: timestamp
    };

    const transaction = this.native.transaction([QUEUE_ITEMS_STORE, METADATA_STORE], 'readwrite');
    transaction.objectStore(QUEUE_ITEMS_STORE).put(updated);
    if (updated.status === 'failed' && updated.lastError) {
      transaction.objectStore(METADATA_STORE).put({
        id: 'lastError',
        message: updated.lastError,
        lastErrorAt: timestamp,
        diagnostic: updated.lastErrorDiagnostic ?? null
      } satisfies ErrorMetadataRecord);
    }
    await transactionDone(transaction);
    return updated;
  }

  public async saveCheckpoint(input: CheckpointInput): Promise<CheckpointRecord> {
    const timestamp = input.updatedAt ?? this.now();
    const checkpoint: CheckpointRecord = {
      id: input.id,
      kind: input.kind,
      status: input.status,
      cursor: input.cursor,
      processedCount: input.processedCount,
      retainedCount: input.retainedCount,
      updatedAt: timestamp,
      lastError: input.lastError,
      ...(input.generation ? { generation: input.generation } : {}),
      lastErrorDiagnostic: input.lastErrorDiagnostic ?? null
    };

    const transaction = this.native.transaction([CHECKPOINTS_STORE, METADATA_STORE], 'readwrite');
    transaction.objectStore(CHECKPOINTS_STORE).put(checkpoint);
    if (checkpoint.status === 'failed' && checkpoint.lastError) {
      transaction.objectStore(METADATA_STORE).put({
        id: 'lastError',
        message: checkpoint.lastError,
        lastErrorAt: timestamp,
        diagnostic: checkpoint.lastErrorDiagnostic ?? null
      } satisfies ErrorMetadataRecord);
    }
    await transactionDone(transaction);
    return checkpoint;
  }

  public async getWorkerLease(id: string): Promise<WorkerLeaseRecord | null> {
    return this.getMetadataRecord<WorkerLeaseRecord>(id);
  }

  public async saveIndexStatus(input: SaveIndexStatusInput): Promise<IndexStatusMetadataRecord> {
    const existing = await this.getMetadataRecord<IndexStatusMetadataRecord>('indexStatus');
    const timestamp = this.now();
    const record: IndexStatusMetadataRecord = {
      id: 'indexStatus',
      activeGeneration:
        input.activeGeneration !== undefined ? input.activeGeneration : (existing?.activeGeneration ?? null),
      lastSuccessfulListAt:
        input.lastSuccessfulListAt !== undefined ? input.lastSuccessfulListAt : (existing?.lastSuccessfulListAt ?? null),
      lastSuccessfulDetailAt:
        input.lastSuccessfulDetailAt !== undefined
          ? input.lastSuccessfulDetailAt
          : (existing?.lastSuccessfulDetailAt ?? null),
      lastCompletedAt:
        input.lastCompletedAt !== undefined ? input.lastCompletedAt : (existing?.lastCompletedAt ?? null),
      updatedAt: timestamp
    };
    await this.putRecord(METADATA_STORE, record);
    return record;
  }

  public async discardQueueItemsForOtherGenerations(activeGeneration: string): Promise<DiscardQueueGenerationResult> {
    const queueItems = await this.getQueueItemRecords();
    const staleItems = queueItems.filter(
      (item) =>
        item.generation !== activeGeneration &&
        (item.status === 'pending' || item.status === 'running' || item.status === 'failed')
    );

    if (staleItems.length === 0) {
      await this.saveIndexStatus({ activeGeneration });
      return { discardedCount: 0 };
    }

    const transaction = this.native.transaction([QUEUE_ITEMS_STORE, METADATA_STORE], 'readwrite');
    const queueStore = transaction.objectStore(QUEUE_ITEMS_STORE);
    staleItems.forEach((item) => {
      queueStore.delete(item.id);
    });
    transaction.objectStore(METADATA_STORE).put({
      id: 'indexStatus',
      activeGeneration,
      lastSuccessfulListAt: null,
      lastSuccessfulDetailAt: null,
      lastCompletedAt: null,
      updatedAt: this.now()
    } satisfies IndexStatusMetadataRecord);
    await transactionDone(transaction);
    return { discardedCount: staleItems.length };
  }

  public async resetIndexForRebuild(activeGeneration: string): Promise<ResetIndexResult> {
    const [conversations, messages, queueItems] = await Promise.all([
      this.getConversationRecords(),
      this.getMessageRecords(),
      this.getQueueItemRecords()
    ]);
    const transaction = this.native.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE, QUEUE_ITEMS_STORE, CHECKPOINTS_STORE, METADATA_STORE],
      'readwrite'
    );

    conversations.forEach((conversation) => transaction.objectStore(CONVERSATIONS_STORE).delete(conversation.id));
    messages.forEach((message) => transaction.objectStore(MESSAGES_STORE).delete(message.key));
    queueItems.forEach((queueItem) => transaction.objectStore(QUEUE_ITEMS_STORE).delete(queueItem.id));
    transaction.objectStore(CHECKPOINTS_STORE).clear();
    transaction.objectStore(METADATA_STORE).delete('lastError');
    transaction.objectStore(METADATA_STORE).put({
      id: 'indexStatus',
      activeGeneration,
      lastSuccessfulListAt: null,
      lastSuccessfulDetailAt: null,
      lastCompletedAt: null,
      updatedAt: this.now()
    } satisfies IndexStatusMetadataRecord);

    await transactionDone(transaction);
    return {
      clearedQueueCount: queueItems.length,
      clearedConversationCount: conversations.length,
      clearedMessageCount: messages.length
    };
  }

  public async tryAcquireWorkerLease(id: string, ownerId: string, ttlMs: number): Promise<WorkerLeaseRecord | null> {
    const timestamp = this.now();
    const existing = await this.getWorkerLease(id);
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > timestamp) {
      return null;
    }

    const lease: WorkerLeaseRecord = {
      id,
      ownerId,
      expiresAt: timestamp + ttlMs,
      updatedAt: timestamp
    };
    await this.putRecord(METADATA_STORE, lease);
    return lease;
  }

  public async heartbeatWorkerLease(id: string, ownerId: string, ttlMs: number): Promise<WorkerLeaseRecord | null> {
    const timestamp = this.now();
    const existing = await this.getWorkerLease(id);
    if (!existing || existing.ownerId !== ownerId || existing.expiresAt <= timestamp) {
      return null;
    }

    const lease: WorkerLeaseRecord = {
      ...existing,
      expiresAt: timestamp + ttlMs,
      updatedAt: timestamp
    };
    await this.putRecord(METADATA_STORE, lease);
    return lease;
  }

  public async releaseWorkerLease(id: string, ownerId: string): Promise<boolean> {
    const existing = await this.getWorkerLease(id);
    if (!existing || existing.ownerId !== ownerId) return false;

    const transaction = this.native.transaction(METADATA_STORE, 'readwrite');
    transaction.objectStore(METADATA_STORE).delete(id);
    await transactionDone(transaction);
    return true;
  }

  public async getDataDiagnostics(): Promise<DataDiagnostics> {
    const [
      conversations,
      messages,
      queueItems,
      checkpoints,
      schemaMetadata,
      retentionMetadata,
      errorMetadata,
      indexStatusMetadata
    ] =
      await Promise.all([
        this.getAllRecords<ConversationRecord>(CONVERSATIONS_STORE),
        this.getAllRecords<MessageRecord>(MESSAGES_STORE),
        this.getAllRecords<QueueItemRecord>(QUEUE_ITEMS_STORE),
        this.getAllRecords<CheckpointRecord>(CHECKPOINTS_STORE),
        this.getMetadataRecord<SchemaMetadataRecord>('schema'),
        this.getMetadataRecord<RetentionMetadataRecord>('retention'),
        this.getMetadataRecord<ErrorMetadataRecord>('lastError'),
        this.getMetadataRecord<IndexStatusMetadataRecord>('indexStatus')
      ]);

    const queueCounts = createEmptyQueueCounts();
    queueItems.forEach((queueItem) => {
      queueCounts[queueItem.status] += 1;
    });

    return {
      dbName: this.dbName,
      dbVersion: this.native.version,
      schemaVersion: schemaMetadata?.schemaVersion ?? DEEP_SEARCH_DB_VERSION,
      conversationCount: conversations.length,
      messageCount: messages.length,
      retainedConversationCount: conversations.filter((conversation) => conversation.retentionRank !== null).length,
      queueCounts,
      checkpointCount: checkpoints.length,
      lastMigrationAt: schemaMetadata?.lastMigrationAt ?? null,
      lastRetentionAt: retentionMetadata?.lastRetentionAt ?? null,
      lastErrorAt: errorMetadata?.lastErrorAt ?? null,
      lastError: errorMetadata?.diagnostic ?? null,
      activeGeneration: indexStatusMetadata?.activeGeneration ?? null,
      lastSuccessfulListAt: indexStatusMetadata?.lastSuccessfulListAt ?? null,
      lastSuccessfulDetailAt: indexStatusMetadata?.lastSuccessfulDetailAt ?? null,
      lastCompletedAt: indexStatusMetadata?.lastCompletedAt ?? null
    };
  }

  public async getConversationRecords(): Promise<ConversationRecord[]> {
    return this.getAllRecords<ConversationRecord>(CONVERSATIONS_STORE);
  }

  public async getMessageRecords(): Promise<MessageRecord[]> {
    return this.getAllRecords<MessageRecord>(MESSAGES_STORE);
  }

  public async getQueueItemRecords(): Promise<QueueItemRecord[]> {
    return this.getAllRecords<QueueItemRecord>(QUEUE_ITEMS_STORE);
  }

  public async getCheckpointRecords(): Promise<CheckpointRecord[]> {
    return this.getAllRecords<CheckpointRecord>(CHECKPOINTS_STORE);
  }

  private async upsertConversationSnapshot(snapshot: ConversationSnapshot): Promise<void> {
    const existingConversation = await this.getRecord<ConversationRecord>(CONVERSATIONS_STORE, snapshot.id);
    const existingMessages = await this.getMessagesForConversation(snapshot.id);
    const messageMap = new Map(existingMessages.map((message) => [message.key, message]));

    snapshot.messages.forEach((message) => {
      const key = createMessageKey(snapshot.id, message.id);
      const existingMessage = messageMap.get(key);
      messageMap.set(key, {
        key,
        conversationId: snapshot.id,
        id: message.id,
        role: message.role,
        order: message.order,
        text: message.text,
        createdAt: message.createdAt ?? existingMessage?.createdAt ?? null,
        updatedAt: message.updatedAt ?? existingMessage?.updatedAt ?? null
      });
    });

    const messages = Array.from(messageMap.values()).sort(compareMessagesForStorage);
    const timestamp = this.now();
    const conversation: ConversationRecord = {
      id: snapshot.id,
      title: snapshot.title,
      createdAt: snapshot.createdAt ?? existingConversation?.createdAt ?? null,
      updatedAt: snapshot.updatedAt ?? existingConversation?.updatedAt ?? snapshot.createdAt ?? 0,
      indexedAt: timestamp,
      lastSeenAt: timestamp,
      messageCount: messages.length,
      retentionRank: existingConversation?.retentionRank ?? null
    };

    const transaction = this.native.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
    const conversationsStore = transaction.objectStore(CONVERSATIONS_STORE);
    const messagesStore = transaction.objectStore(MESSAGES_STORE);

    messages.forEach((message) => {
      messagesStore.put(message);
    });
    conversationsStore.put(conversation);

    await transactionDone(transaction);
  }

  private async getMessagesForConversation(conversationId: string): Promise<MessageRecord[]> {
    const messages = await this.getAllRecords<MessageRecord>(MESSAGES_STORE);
    return messages.filter((message) => message.conversationId === conversationId);
  }

  private async getRecord<T>(storeName: DeepSearchStoreName, key: IDBValidKey): Promise<T | null> {
    const transaction = this.native.transaction(storeName, 'readonly');
    const result = await requestToPromise<T | undefined>(transaction.objectStore(storeName).get(key));
    return result ?? null;
  }

  private async getMetadataRecord<T extends MetadataRecord>(id: T['id']): Promise<T | null> {
    return this.getRecord<T>(METADATA_STORE, id);
  }

  private async getAllRecords<T>(storeName: DeepSearchStoreName): Promise<T[]> {
    const transaction = this.native.transaction(storeName, 'readonly');
    return requestToPromise<T[]>(transaction.objectStore(storeName).getAll());
  }

  private async putRecord<T>(storeName: DeepSearchStoreName, record: T): Promise<void> {
    const transaction = this.native.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    await transactionDone(transaction);
  }
}

export function createMessageKey(conversationId: string, messageId: string): string {
  return `${conversationId}::${messageId}`;
}

function migrateDeepSearchDatabase(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  dbName: string,
  timestamp: number
): void {
  const conversationsStore = ensureObjectStore(database, transaction, CONVERSATIONS_STORE, { keyPath: 'id' });
  ensureIndex(conversationsStore, 'updatedAt', 'updatedAt');
  ensureIndex(conversationsStore, 'retentionRank', 'retentionRank');

  const messagesStore = ensureObjectStore(database, transaction, MESSAGES_STORE, { keyPath: 'key' });
  ensureIndex(messagesStore, 'conversationId', 'conversationId');
  ensureIndex(messagesStore, 'conversationId_order', ['conversationId', 'order']);

  if (oldVersion < 2) {
    const queueStore = ensureObjectStore(database, transaction, QUEUE_ITEMS_STORE, { keyPath: 'id' });
    ensureIndex(queueStore, 'conversationId', 'conversationId');
    ensureIndex(queueStore, 'status', 'status');
    ensureIndex(queueStore, 'availableAt', 'availableAt');
    ensureIndex(queueStore, 'status_availableAt', ['status', 'availableAt']);

    const checkpointsStore = ensureObjectStore(database, transaction, CHECKPOINTS_STORE, { keyPath: 'id' });
    ensureIndex(checkpointsStore, 'kind', 'kind');
    ensureIndex(checkpointsStore, 'status', 'status');

    ensureObjectStore(database, transaction, DIAGNOSTICS_STORE, { keyPath: 'id' });
    const metadataStore = ensureObjectStore(database, transaction, METADATA_STORE, { keyPath: 'id' });
    metadataStore.put({
      id: 'schema',
      dbName,
      dbVersion: DEEP_SEARCH_DB_VERSION,
      schemaVersion: DEEP_SEARCH_DB_VERSION,
      previousVersion: oldVersion,
      lastMigrationAt: timestamp
    } satisfies SchemaMetadataRecord);
  }
}

function ensureObjectStore(
  database: IDBDatabase,
  transaction: IDBTransaction,
  name: DeepSearchStoreName,
  options: IDBObjectStoreParameters
): IDBObjectStore {
  if (database.objectStoreNames.contains(name)) {
    return transaction.objectStore(name);
  }
  return database.createObjectStore(name, options);
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[]): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath);
  }
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

function compareConversationsForRetention(left: ConversationRecord, right: ConversationRecord): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.id.localeCompare(right.id);
}

function compareMessagesForStorage(left: MessageRecord, right: MessageRecord): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.id.localeCompare(right.id);
}

function compareQueueItemsForScheduling(left: QueueItemRecord, right: QueueItemRecord): number {
  if (left.availableAt !== right.availableAt) return left.availableAt - right.availableAt;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  return left.id.localeCompare(right.id);
}

function createEmptyQueueCounts(): QueueStatusCounts {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0
  };
}
