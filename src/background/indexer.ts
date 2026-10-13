import { ChatGPTAdapterError, type ChatGPTConversationAdapter, type ChatGPTConversationListItem } from '../chatgpt';
import type { DeepSearchDatabase } from '../data';
import type { CheckpointRecord, IndexerDiagnostics, IndexingErrorDiagnostic, QueueItemRecord } from '../shared/types';

export const PHASE3_CONVERSATION_HARD_LIMIT = 3;
export const AUTO_INDEX_CONVERSATION_LIMIT = 200;
export const AUTO_INDEX_REAL_TEST_LIMIT = 3;
export const AUTO_INDEX_BURST_DETAIL_LIMIT = 5;
export const CHATGPT_ADAPTER_GENERATION = 'chatgpt-offset-page-bridge-v1';

const PHASE3_CHECKPOINT_ID = 'phase3-test-run';
const AUTO_INDEX_CHECKPOINT_ID = 'auto-index';
const INDEXER_LEASE_ID = 'deep-search-indexer';
const STALE_RUNNING_QUEUE_MS = 60_000;

export interface IndexedDBWorkerLeaseOptions {
  readonly ownerId: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export class IndexedDBWorkerLease {
  private readonly database: DeepSearchDatabase;
  private readonly ownerId: string;
  private readonly ttlMs: number;
  private held = false;

  public constructor(database: DeepSearchDatabase, options: IndexedDBWorkerLeaseOptions) {
    this.database = database;
    this.ownerId = options.ownerId;
    this.ttlMs = options.ttlMs ?? 15_000;
  }

  public getOwnerId(): string {
    return this.ownerId;
  }

  public isHeld(): boolean {
    return this.held;
  }

  public async acquire(): Promise<boolean> {
    const lease = await this.database.tryAcquireWorkerLease(INDEXER_LEASE_ID, this.ownerId, this.ttlMs);
    this.held = lease !== null;
    return this.held;
  }

  public async heartbeat(): Promise<boolean> {
    const lease = await this.database.heartbeatWorkerLease(INDEXER_LEASE_ID, this.ownerId, this.ttlMs);
    this.held = lease !== null;
    return this.held;
  }

  public async release(): Promise<boolean> {
    const released = await this.database.releaseWorkerLease(INDEXER_LEASE_ID, this.ownerId);
    if (released) this.held = false;
    return released;
  }
}

export interface IndexingSchedulerOptions {
  readonly adapter: ChatGPTConversationAdapter;
  readonly database: DeepSearchDatabase;
  readonly lease: IndexedDBWorkerLease;
  readonly ownerId: string;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly baseDelayMs?: number;
  readonly jitterMs?: number;
  readonly maxAttempts?: number;
}

export interface StartTestRunOptions {
  readonly maxItemsThisRun?: number;
}

export interface IndexingRunResult {
  readonly acquiredLease: boolean;
  readonly listedCount: number;
  readonly cappedCount: number;
  readonly processedCount: number;
}

export interface AutoIndexCycleOptions {
  readonly reason?: string;
  readonly scanList?: boolean;
  readonly currentConversationId?: string;
  readonly maxDetailsThisRun?: number;
}

export interface AutoIndexRunResult {
  readonly acquiredLease: boolean;
  readonly listedCount: number;
  readonly enqueuedCount: number;
  readonly processedCount: number;
  readonly retainedCount: number;
  readonly deletedCount: number;
}

export interface RetryDelayOptions {
  readonly attempt: number;
  readonly retryAfterMs?: number;
  readonly baseDelayMs: number;
  readonly jitterMs: number;
  readonly random: () => number;
}

interface ProcessConversationOptions {
  readonly checkpointId: string;
  readonly checkpointKind: string;
  readonly retainedCount: number;
  readonly waitForRetry: boolean;
}

export class IndexingScheduler {
  private readonly adapter: ChatGPTConversationAdapter;
  private readonly database: DeepSearchDatabase;
  private readonly lease: IndexedDBWorkerLease;
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly jitterMs: number;
  private readonly maxAttempts: number;
  private lastRunAt: number | null = null;
  private lastAutoScanAt: number | null = null;
  private lastIncrementalAt: number | null = null;
  private nextWakeAt: number | null = null;
  private offlineRecoveryCount = 0;
  private retentionDeletedCount = 0;
  private lastErrorCode: string | null = null;
  private lastBackoffMs: number | null = null;
  private processedCount = 0;

  public constructor(options: IndexingSchedulerOptions) {
    this.adapter = options.adapter;
    this.database = options.database;
    this.lease = options.lease;
    this.ownerId = options.ownerId;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? defaultDelay;
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.jitterMs = options.jitterMs ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  public async startTestRun(options: StartTestRunOptions = {}): Promise<IndexingRunResult> {
    const acquiredLease = await this.lease.acquire();
    if (!acquiredLease) {
      return {
        acquiredLease: false,
        listedCount: 0,
        cappedCount: 0,
        processedCount: 0
      };
    }

    this.lastRunAt = this.now();
    await this.lease.heartbeat();

    const page = await this.adapter.listConversations({ limit: PHASE3_CONVERSATION_HARD_LIMIT });
    const cappedItems = page.items.slice(0, PHASE3_CONVERSATION_HARD_LIMIT);
    await this.ensureQueueItems(cappedItems.map((item) => item.id));

    const completedBeforeRun = await this.countCompleted(cappedItems.map((item) => item.id));
    await this.saveCheckpoint({
      status: 'running',
      processedCount: completedBeforeRun,
      retainedCount: cappedItems.length,
      cursor: cappedItems[completedBeforeRun]?.id ?? null,
      lastError: null
    });

    const maxItemsThisRun = Math.min(options.maxItemsThisRun ?? PHASE3_CONVERSATION_HARD_LIMIT, PHASE3_CONVERSATION_HARD_LIMIT);
    let processedThisRun = 0;

    for (const item of cappedItems) {
      if (processedThisRun >= maxItemsThisRun) break;
      if (await this.isConversationCompleted(item.id)) continue;

      await this.lease.heartbeat();
      const processed = await this.processConversation(item.id, {
        checkpointId: PHASE3_CHECKPOINT_ID,
        checkpointKind: 'phase3-test-run',
        retainedCount: PHASE3_CONVERSATION_HARD_LIMIT,
        waitForRetry: true
      });
      if (processed) processedThisRun += 1;

      const completedCount = await this.countCompleted(cappedItems.map((conversation) => conversation.id));
      const nextCursor = await this.getNextIncompleteConversationId(cappedItems.map((conversation) => conversation.id));
      await this.saveCheckpoint({
        status: completedCount === cappedItems.length ? 'completed' : 'running',
        processedCount: completedCount,
        retainedCount: cappedItems.length,
        cursor: nextCursor,
        lastError: this.lastErrorCode
      });

      if (processedThisRun < maxItemsThisRun && completedCount < cappedItems.length) {
        await this.delay(calculateRequestDelay(this.baseDelayMs, this.jitterMs, this.random));
      }
    }

    await this.database.applyRetentionLimit(PHASE3_CONVERSATION_HARD_LIMIT);
    this.processedCount += processedThisRun;

    const completedAfterRun = await this.countCompleted(cappedItems.map((item) => item.id));
    const nextCursorAfterRun = await this.getNextIncompleteConversationId(cappedItems.map((conversation) => conversation.id));
    await this.saveCheckpoint({
      status: completedAfterRun === cappedItems.length ? 'completed' : 'running',
      processedCount: completedAfterRun,
      retainedCount: cappedItems.length,
      cursor: nextCursorAfterRun,
      lastError: this.lastErrorCode
    });

    return {
      acquiredLease: true,
      listedCount: page.items.length,
      cappedCount: cappedItems.length,
      processedCount: processedThisRun
    };
  }

  public async runAutoIndexCycle(options: AutoIndexCycleOptions = {}): Promise<AutoIndexRunResult> {
    const acquiredLease = await this.lease.acquire();
    if (!acquiredLease) {
      return {
        acquiredLease: false,
        listedCount: 0,
        enqueuedCount: 0,
        processedCount: 0,
        retainedCount: 0,
        deletedCount: 0
      };
    }

    this.lastRunAt = this.now();
    await this.lease.heartbeat();
    await this.database.discardQueueItemsForOtherGenerations(CHATGPT_ADAPTER_GENERATION);

    const recovered = await this.database.resetStaleRunningQueueItems(
      this.now() - STALE_RUNNING_QUEUE_MS,
      CHATGPT_ADAPTER_GENERATION
    );
    this.offlineRecoveryCount += recovered.resetCount;

    let listedItems: ChatGPTConversationListItem[] = [];
    let enqueuedCount = 0;
    const activeLimit = Math.min(AUTO_INDEX_CONVERSATION_LIMIT, AUTO_INDEX_REAL_TEST_LIMIT);

    if (options.currentConversationId) {
      await this.database.enqueueConversation(options.currentConversationId, options.reason ?? 'incremental', {
        generation: CHATGPT_ADAPTER_GENERATION
      });
      this.lastIncrementalAt = this.now();
      enqueuedCount += 1;
    }

    if (options.scanList ?? true) {
      try {
        listedItems = await this.listRecentConversations(activeLimit);
        this.lastAutoScanAt = this.now();
        await this.database.saveIndexStatus({
          activeGeneration: CHATGPT_ADAPTER_GENERATION,
          lastSuccessfulListAt: this.lastAutoScanAt
        });
      } catch (error) {
        const adapterError = toAdapterError(error);
        this.lastErrorCode = adapterError.code;
        const diagnostic = withRetryState(adapterError.diagnostic, 0, null);
        await this.saveCheckpoint({
          checkpointId: AUTO_INDEX_CHECKPOINT_ID,
          checkpointKind: 'auto-index',
          status: 'failed',
          processedCount: this.processedCount,
          retainedCount: 0,
          cursor: null,
          lastError: adapterError.code,
          lastErrorDiagnostic: diagnostic
        });
        return {
          acquiredLease: true,
          listedCount: 0,
          enqueuedCount,
          processedCount: 0,
          retainedCount: 0,
          deletedCount: 0
        };
      }
      const changes = await this.database.upsertConversationListMetadata(listedItems.map(toConversationMetadataInput));

      for (const change of changes) {
        if (!change.isNew && !change.updatedAtChanged && !change.titleChanged) continue;
        const reason = change.isNew ? 'auto-new' : change.titleChanged ? 'auto-title-changed' : 'auto-updated';
        await this.database.enqueueConversation(change.conversationId, reason, {
          generation: CHATGPT_ADAPTER_GENERATION
        });
        enqueuedCount += 1;
      }
    }

    const retentionAfterList = await this.database.applyRetentionLimit(AUTO_INDEX_CONVERSATION_LIMIT);
    this.retentionDeletedCount += retentionAfterList.deletedCount;

    await this.saveCheckpoint({
      checkpointId: AUTO_INDEX_CHECKPOINT_ID,
      checkpointKind: 'auto-index',
      status: 'running',
      processedCount: this.processedCount,
      retainedCount: retentionAfterList.retainedCount,
      cursor: await this.getNextPendingQueueId(),
      lastError: this.lastErrorCode,
      lastErrorDiagnostic: null
    });

    const processedCount = await this.processDueAutoQueue(options.maxDetailsThisRun ?? AUTO_INDEX_BURST_DETAIL_LIMIT);
    const retentionAfterBurst = await this.database.applyRetentionLimit(AUTO_INDEX_CONVERSATION_LIMIT);
    this.retentionDeletedCount += retentionAfterBurst.deletedCount;
    const pendingCursor = await this.getNextPendingQueueId();

    await this.saveCheckpoint({
      checkpointId: AUTO_INDEX_CHECKPOINT_ID,
      checkpointKind: 'auto-index',
      status: pendingCursor ? 'running' : 'completed',
      processedCount: this.processedCount,
      retainedCount: retentionAfterBurst.retainedCount,
      cursor: pendingCursor,
      lastError: this.lastErrorCode,
      lastErrorDiagnostic: null
    });
    if (!pendingCursor && this.lastErrorCode === null) {
      await this.database.saveIndexStatus({
        activeGeneration: CHATGPT_ADAPTER_GENERATION,
        lastCompletedAt: this.now()
      });
    }

    return {
      acquiredLease: true,
      listedCount: listedItems.length,
      enqueuedCount,
      processedCount,
      retainedCount: retentionAfterBurst.retainedCount,
      deletedCount: retentionAfterList.deletedCount + retentionAfterBurst.deletedCount
    };
  }

  public async getIndexerDiagnostics(): Promise<IndexerDiagnostics> {
    const diagnostics = await this.database.getDataDiagnostics();
    const checkpoints = await this.database.getCheckpointRecords();
    const checkpoint =
      checkpoints.find((record) => record.id === AUTO_INDEX_CHECKPOINT_ID) ??
      checkpoints.find((record) => record.id === PHASE3_CHECKPOINT_ID) ??
      null;

    return {
      hardLimit: PHASE3_CONVERSATION_HARD_LIMIT,
      autoLimit: AUTO_INDEX_CONVERSATION_LIMIT,
      burstLimit: AUTO_INDEX_BURST_DETAIL_LIMIT,
      leaseOwnerId: this.ownerId,
      leaseActive: this.lease.isHeld(),
      lastRunAt: this.lastRunAt,
      lastAutoScanAt: this.lastAutoScanAt,
      lastIncrementalAt: this.lastIncrementalAt,
      nextWakeAt: this.nextWakeAt,
      offlineRecoveryCount: this.offlineRecoveryCount,
      retentionDeletedCount: this.retentionDeletedCount,
      lastErrorCode: this.lastErrorCode ?? checkpoint?.lastError ?? null,
      lastError: checkpoint?.lastErrorDiagnostic ?? diagnostics.lastError,
      lastBackoffMs: this.lastBackoffMs,
      processedCount: this.processedCount,
      queueCounts: diagnostics.queueCounts,
      checkpoint
    };
  }

  public async releaseLease(): Promise<boolean> {
    return this.lease.release();
  }

  public async rebuildIndex(): Promise<{
    readonly clearedQueueCount: number;
    readonly clearedConversationCount: number;
    readonly clearedMessageCount: number;
  }> {
    this.processedCount = 0;
    this.lastErrorCode = null;
    this.lastBackoffMs = null;
    return this.database.resetIndexForRebuild(CHATGPT_ADAPTER_GENERATION);
  }

  public setNextWakeAt(timestamp: number | null): void {
    this.nextWakeAt = timestamp;
  }

  private async listRecentConversations(limit: number): Promise<ChatGPTConversationListItem[]> {
    const items: ChatGPTConversationListItem[] = [];
    let cursor: string | null = null;

    while (items.length < limit) {
      const remaining = limit - items.length;
      const page = await this.adapter.listConversations({
        limit: Math.min(50, remaining),
        cursor
      });
      items.push(...page.items.slice(0, remaining));
      if (!page.nextCursor || page.items.length === 0) break;
      cursor = page.nextCursor;
    }

    return items;
  }

  private async ensureQueueItems(conversationIds: readonly string[]): Promise<void> {
    const existingQueueItems = await this.database.getQueueItemRecords();
    const existingById = new Map(existingQueueItems.map((item) => [item.id, item]));

    for (const conversationId of conversationIds) {
      const existing = existingById.get(conversationId);
      if (existing?.status === 'completed' || existing?.status === 'failed' || existing?.status === 'pending') continue;

      if (existing?.status === 'running') {
        await this.database.updateQueueItem(conversationId, {
          status: 'pending',
          lastError: existing.lastError
        });
        continue;
      }

      await this.database.enqueueConversation(conversationId, 'phase3-test-run');
    }
  }

  private async processDueAutoQueue(limit: number): Promise<number> {
    const dueItems = await this.database.getDueQueueItems(limit, this.now(), CHATGPT_ADAPTER_GENERATION);
    let processedCount = 0;

    for (const item of dueItems) {
      await this.lease.heartbeat();
      const processed = await this.processConversation(item.conversationId, {
        checkpointId: AUTO_INDEX_CHECKPOINT_ID,
        checkpointKind: 'auto-index',
        retainedCount: Math.min(AUTO_INDEX_CONVERSATION_LIMIT, AUTO_INDEX_REAL_TEST_LIMIT),
        waitForRetry: false
      });
      if (processed) {
        processedCount += 1;
        this.processedCount += 1;
      }

      if (processedCount < dueItems.length) {
        await this.delay(calculateRequestDelay(this.baseDelayMs, this.jitterMs, this.random));
      }
    }

    return processedCount;
  }

  private async processConversation(conversationId: string, options: ProcessConversationOptions): Promise<boolean> {
    let queueItem = (await this.database.getQueueItemRecords()).find((item) => item.id === conversationId);
    if (!queueItem || queueItem.status === 'completed' || queueItem.status === 'failed') return false;

    while (queueItem.attempts < this.maxAttempts) {
      const attempt = queueItem.attempts + 1;
      queueItem = await this.database.updateQueueItem(conversationId, {
        status: 'running',
        attempts: attempt,
        lastError: null
      });

      try {
        const snapshot = await this.adapter.getConversationDetail(conversationId);
        await this.database.upsertConversationSnapshots([snapshot]);
        await this.database.saveIndexStatus({
          activeGeneration: CHATGPT_ADAPTER_GENERATION,
          lastSuccessfulDetailAt: this.now()
        });
        await this.database.updateQueueItem(conversationId, {
          status: 'completed',
          attempts: attempt,
          lastError: null
        });
        this.lastErrorCode = null;
        this.lastBackoffMs = null;
        return true;
      } catch (error) {
        const adapterError = toAdapterError(error);
        this.lastErrorCode = adapterError.code;

        if (adapterError.recoverable && attempt < this.maxAttempts) {
          const retryDelayOptions: RetryDelayOptions = {
            attempt,
            baseDelayMs: this.baseDelayMs,
            jitterMs: this.jitterMs,
            random: this.random,
            ...(adapterError.retryAfterMs !== undefined ? { retryAfterMs: adapterError.retryAfterMs } : {})
          };
          const delayMs = calculateRetryDelay(retryDelayOptions);
          this.lastBackoffMs = delayMs;
          const nextRetryAt = this.now() + delayMs;
          const diagnostic = withRetryState(adapterError.diagnostic, attempt, nextRetryAt);
          queueItem = await this.database.updateQueueItem(conversationId, {
            status: 'pending',
            attempts: attempt,
            availableAt: nextRetryAt,
            lastError: adapterError.code,
            lastErrorDiagnostic: diagnostic
          });
          await this.saveCheckpoint({
            checkpointId: options.checkpointId,
            checkpointKind: options.checkpointKind,
            status: 'running',
            processedCount: this.processedCount,
            retainedCount: options.retainedCount,
            cursor: conversationId,
            lastError: adapterError.code,
            lastErrorDiagnostic: diagnostic
          });
          if (!options.waitForRetry) return false;

          await this.delay(delayMs);
          continue;
        }

        const diagnostic = withRetryState(adapterError.diagnostic, attempt, null);
        await this.database.updateQueueItem(conversationId, {
          status: 'failed',
          attempts: attempt,
          lastError: adapterError.code,
          lastErrorDiagnostic: diagnostic
        });
        await this.saveCheckpoint({
          checkpointId: options.checkpointId,
          checkpointKind: options.checkpointKind,
          status: 'failed',
          processedCount: this.processedCount,
          retainedCount: options.retainedCount,
          cursor: conversationId,
          lastError: adapterError.code,
          lastErrorDiagnostic: diagnostic
        });
        return false;
      }
    }

    return false;
  }

  private async isConversationCompleted(conversationId: string): Promise<boolean> {
    return (await this.database.getQueueItemRecords()).some((item) => item.id === conversationId && item.status === 'completed');
  }

  private async countCompleted(conversationIds: readonly string[]): Promise<number> {
    const allowedIds = new Set(conversationIds);
    return (await this.database.getQueueItemRecords()).filter((item) => allowedIds.has(item.id) && item.status === 'completed').length;
  }

  private async getNextIncompleteConversationId(conversationIds: readonly string[]): Promise<string | null> {
    const queueItems = await this.database.getQueueItemRecords();
    for (const conversationId of conversationIds) {
      if (!queueItems.some((item) => item.id === conversationId && item.status === 'completed')) {
        return conversationId;
      }
    }
    return null;
  }

  private async getNextPendingQueueId(): Promise<string | null> {
    const queueItems = await this.database.getQueueItemRecords();
    return queueItems.sort(compareQueueItemsForCursor).find((item) => item.status === 'pending' || item.status === 'running')?.id ?? null;
  }

  private async saveCheckpoint(input: {
    readonly checkpointId?: string;
    readonly checkpointKind?: string;
    readonly status: CheckpointRecord['status'];
    readonly processedCount: number;
    readonly retainedCount: number;
    readonly cursor: string | null;
    readonly lastError: string | null;
    readonly lastErrorDiagnostic?: IndexingErrorDiagnostic | null;
  }): Promise<void> {
    await this.database.saveCheckpoint({
      id: input.checkpointId ?? PHASE3_CHECKPOINT_ID,
      kind: input.checkpointKind ?? 'phase3-test-run',
      status: input.status,
      cursor: input.cursor,
      processedCount: input.processedCount,
      retainedCount: input.retainedCount,
      lastError: input.lastError,
      generation: CHATGPT_ADAPTER_GENERATION,
      lastErrorDiagnostic: input.lastErrorDiagnostic ?? null
    });
  }
}

export function calculateRetryDelay(options: RetryDelayOptions): number {
  const exponentialDelay = Math.round(options.baseDelayMs * 2 ** Math.max(0, options.attempt - 1));
  const floorDelay = Math.max(exponentialDelay, options.retryAfterMs ?? 0);
  return floorDelay + Math.round(options.jitterMs * options.random());
}

function toConversationMetadataInput(item: ChatGPTConversationListItem): {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
} {
  return {
    id: item.id,
    title: item.title,
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {})
  };
}

function calculateRequestDelay(baseDelayMs: number, jitterMs: number, random: () => number): number {
  return baseDelayMs + Math.round(jitterMs * random());
}

function compareQueueItemsForCursor(left: QueueItemRecord, right: QueueItemRecord): number {
  if (left.availableAt !== right.availableAt) return left.availableAt - right.availableAt;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  return left.id.localeCompare(right.id);
}

function toAdapterError(error: unknown): ChatGPTAdapterError {
  if (error instanceof ChatGPTAdapterError) return error;
  return new ChatGPTAdapterError({
    code: 'NETWORK_ERROR',
    recoverable: true,
    message: error instanceof Error ? error.message : 'Unknown indexing error',
    diagnostic: {
      endpoint: 'unknown',
      method: 'GET',
      httpStatus: null,
      backendErrorCode: 'scheduler_error',
      canRetry: true,
      stage: 'scheduler',
      occurredAt: Date.now(),
      retryCount: 0,
      nextRetryAt: null
    }
  });
}

function withRetryState(
  diagnostic: IndexingErrorDiagnostic | undefined,
  retryCount: number,
  nextRetryAt: number | null
): IndexingErrorDiagnostic | null {
  if (!diagnostic) return null;
  return {
    ...diagnostic,
    retryCount,
    nextRetryAt
  };
}

async function defaultDelay(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
