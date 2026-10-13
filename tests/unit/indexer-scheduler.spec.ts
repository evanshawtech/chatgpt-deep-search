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
  IndexedDBWorkerLease,
  IndexingScheduler,
  PHASE3_CONVERSATION_HARD_LIMIT,
  calculateRetryDelay
} from '../../src/background/indexer';
import { openDeepSearchDatabase, type DeepSearchDatabase } from '../../src/data';
import listFixture from '../fixtures/chatgpt/conversation-list.json';
import alphaFixture from '../fixtures/chatgpt/conversation-alpha.json';
import betaFixture from '../fixtures/chatgpt/conversation-beta.json';
import gammaFixture from '../fixtures/chatgpt/conversation-gamma.json';

let indexedDBFactory: IDBFactory;
let currentTime: number;

beforeEach(() => {
  indexedDBFactory = new FakeIDBFactory() as unknown as IDBFactory;
  currentTime = 1_800_000_000_000;
});

describe('IndexingScheduler', () => {
  it('hard-caps real-account test runs at 3 conversations and fetches details serially', async () => {
    const database = await openTestDatabase();
    const transport = new TrackingTransport();
    const scheduler = createScheduler(database, transport, 'owner-serial');

    try {
      const result = await scheduler.startTestRun();
      const conversations = await database.getConversationRecords();
      const queueItems = await database.getQueueItemRecords();

      expect(PHASE3_CONVERSATION_HARD_LIMIT).toBe(3);
      expect(result).toMatchObject({
        acquiredLease: true,
        listedCount: 5,
        cappedCount: 3,
        processedCount: 3
      });
      expect(transport.detailIds).toEqual(['conversation-alpha', 'conversation-beta', 'conversation-gamma']);
      expect(transport.detailIds).not.toContain('conversation-delta');
      expect(transport.maxActiveDetailRequests).toBe(1);
      expect(conversations.map((conversation) => conversation.id).sort()).toEqual([
        'conversation-alpha',
        'conversation-beta',
        'conversation-gamma'
      ]);
      expect(queueItems.every((queueItem) => queueItem.status === 'completed')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('uses retry-after and exponential backoff with jitter for recoverable errors', async () => {
    expect(
      calculateRetryDelay({
        attempt: 1,
        retryAfterMs: 2_000,
        baseDelayMs: 500,
        jitterMs: 100,
        random: () => 0.5
      })
    ).toBe(2_050);

    expect(
      calculateRetryDelay({
        attempt: 1,
        baseDelayMs: 500,
        jitterMs: 100,
        random: () => 0.25
      })
    ).toBe(525);

    expect(
      calculateRetryDelay({
        attempt: 3,
        baseDelayMs: 500,
        jitterMs: 100,
        random: () => 0.75
      })
    ).toBe(2_075);
  });

  it('schedules a recoverable 429 retry and persists sanitized queue/checkpoint state', async () => {
    const database = await openTestDatabase();
    const transport = new TrackingTransport({
      failures: {
        'conversation-alpha': [
          new ChatGPTAdapterError({
            code: 'RATE_LIMITED',
            status: 429,
            retryAfterMs: 2_000,
            recoverable: true,
            message: 'ChatGPT request failed with HTTP 429'
          })
        ]
      }
    });
    const delays: number[] = [];
    const scheduler = createScheduler(database, transport, 'owner-retry', {
      delay: async (ms) => {
        delays.push(ms);
      },
      random: () => 0
    });

    try {
      await scheduler.startTestRun({ maxItemsThisRun: 1 });

      const queueItems = await database.getQueueItemRecords();
      const checkpoints = await database.getCheckpointRecords();

      expect(delays).toContain(2_000);
      expect(queueItems[0]).toMatchObject({
        id: 'conversation-alpha',
        status: 'completed',
        attempts: 2,
        lastError: null
      });
      expect(checkpoints.at(-1)).toMatchObject({
        id: 'phase3-test-run',
        status: 'running',
        processedCount: 1
      });
    } finally {
      database.close();
    }
  });

  it('resumes from persisted queue state after a simulated service-worker restart', async () => {
    const database = await openTestDatabase();
    const firstTransport = new TrackingTransport();
    const firstScheduler = createScheduler(database, firstTransport, 'owner-resume-a');

    try {
      await firstScheduler.startTestRun({ maxItemsThisRun: 1 });
      await firstScheduler.releaseLease();
      currentTime += 10_000;

      const secondTransport = new TrackingTransport();
      const secondScheduler = createScheduler(database, secondTransport, 'owner-resume-b');
      await secondScheduler.startTestRun();

      const queueItems = await database.getQueueItemRecords();
      expect(firstTransport.detailIds).toEqual(['conversation-alpha']);
      expect(secondTransport.detailIds).toEqual(['conversation-beta', 'conversation-gamma']);
      expect(queueItems.every((queueItem) => queueItem.status === 'completed')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('allows only one active lease owner and recovers stale leases', async () => {
    const database = await openTestDatabase();
    const firstLease = new IndexedDBWorkerLease(database, {
      ownerId: 'lease-a',
      now,
      ttlMs: 1_000
    });
    const secondLease = new IndexedDBWorkerLease(database, {
      ownerId: 'lease-b',
      now,
      ttlMs: 1_000
    });

    try {
      expect(await firstLease.acquire()).toBe(true);
      expect(await secondLease.acquire()).toBe(false);

      currentTime += 1_001;
      expect(await secondLease.acquire()).toBe(true);
      expect(await firstLease.heartbeat()).toBe(false);
      expect(await secondLease.heartbeat()).toBe(true);
    } finally {
      database.close();
    }
  });

  it('returns diagnostics without leaking conversation body text', async () => {
    const database = await openTestDatabase();
    const transport = new TrackingTransport();
    const scheduler = createScheduler(database, transport, 'owner-diagnostics');

    try {
      await scheduler.startTestRun({ maxItemsThisRun: 1 });
      const diagnostics = await scheduler.getIndexerDiagnostics();
      const serialized = JSON.stringify(diagnostics);

      expect(diagnostics).toMatchObject({
        hardLimit: 3,
        leaseOwnerId: 'owner-diagnostics',
        queueCounts: {
          pending: 2,
          running: 0,
          completed: 1,
          failed: 0
        }
      });
      expect(serialized).not.toContain('精确连续子串不能丢失');
      expect(serialized).not.toContain('助手回复第一行');
    } finally {
      database.close();
    }
  });
});

interface SchedulerOverrides {
  readonly delay?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

function createScheduler(
  database: DeepSearchDatabase,
  transport: TrackingTransport,
  ownerId: string,
  overrides: SchedulerOverrides = {}
): IndexingScheduler {
  return new IndexingScheduler({
    adapter: new ChatGPTConversationAdapter({ transport }),
    database,
    lease: new IndexedDBWorkerLease(database, {
      ownerId,
      now,
      ttlMs: 1_000
    }),
    ownerId,
    now,
    delay: overrides.delay ?? (async () => undefined),
    random: overrides.random ?? (() => 0)
  });
}

async function openTestDatabase(): Promise<DeepSearchDatabase> {
  return openDeepSearchDatabase({ indexedDB: indexedDBFactory, now });
}

function now(): number {
  currentTime += 1;
  return currentTime;
}

interface TrackingTransportOptions {
  readonly failures?: Record<string, ChatGPTAdapterError[]>;
}

class TrackingTransport implements ChatGPTTransport {
  public readonly detailIds: string[] = [];
  public maxActiveDetailRequests = 0;
  private activeDetailRequests = 0;
  private readonly failures: Record<string, ChatGPTAdapterError[]>;

  public constructor(options: TrackingTransportOptions = {}) {
    this.failures = options.failures ?? {};
  }

  public async request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse> {
    if (request.url.includes('/backend-api/conversations')) {
      return jsonResponse(200, listFixture);
    }

    const id = decodeURIComponent(request.url.split('/backend-api/conversation/')[1]?.split('?')[0] ?? '');
    this.detailIds.push(id);
    this.activeDetailRequests += 1;
    this.maxActiveDetailRequests = Math.max(this.maxActiveDetailRequests, this.activeDetailRequests);

    await Promise.resolve();
    this.activeDetailRequests -= 1;

    const failure = this.failures[id]?.shift();
    if (failure) throw failure;

    const fixture = {
      'conversation-alpha': alphaFixture,
      'conversation-beta': betaFixture,
      'conversation-gamma': gammaFixture
    }[id];

    return jsonResponse(200, fixture ?? {});
  }
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
