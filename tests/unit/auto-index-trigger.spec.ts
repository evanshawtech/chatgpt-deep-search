import { describe, expect, it } from 'vitest';
import { createAutoIndexTriggerController, type AutoIndexTriggerRequest } from '../../src/background/auto-index-trigger';
import type { DeepSearchRunAutoIndexCheckResponse } from '../../src/shared/types';

describe('auto index trigger controller', () => {
  it('runs events received during an active auto-index cycle instead of dropping them', async () => {
    const firstRun = createDeferred<void>();
    const requests: AutoIndexTriggerRequest[] = [];
    const controller = createAutoIndexTriggerController(async (request) => {
      requests.push(request);
      if (requests.length === 1) await firstRun.promise;
      return response(requests.length);
    });

    const activePromise = controller.trigger({ reason: 'content-ready', scanList: true });
    const samePromise = controller.trigger({
      reason: 'current-conversation-changed',
      scanList: false,
      currentConversationId: 'conversation-late'
    });

    expect(samePromise).toBe(activePromise);
    expect(requests).toEqual([{ reason: 'content-ready', scanList: true }]);

    firstRun.resolve();
    await activePromise;

    expect(requests).toEqual([
      { reason: 'content-ready', scanList: true },
      {
        reason: 'current-conversation-changed',
        scanList: false,
        currentConversationId: 'conversation-late'
      }
    ]);
  });

  it('keeps scan-list work and each pending current conversation in the serial queue', async () => {
    const firstRun = createDeferred<void>();
    const requests: AutoIndexTriggerRequest[] = [];
    const controller = createAutoIndexTriggerController(async (request) => {
      requests.push(request);
      if (requests.length === 1) await firstRun.promise;
      return response(requests.length);
    });

    const activePromise = controller.trigger({
      reason: 'current-conversation-seen',
      scanList: false,
      currentConversationId: 'conversation-a'
    });
    controller.trigger({ reason: 'alarm', scanList: true });
    controller.trigger({
      reason: 'current-conversation-changed',
      scanList: false,
      currentConversationId: 'conversation-b'
    });

    firstRun.resolve();
    await activePromise;

    expect(requests).toEqual([
      {
        reason: 'current-conversation-seen',
        scanList: false,
        currentConversationId: 'conversation-a'
      },
      {
        reason: 'current-conversation-changed',
        scanList: true,
        currentConversationId: 'conversation-b'
      }
    ]);
  });
});

function response(processedCount: number): DeepSearchRunAutoIndexCheckResponse {
  return {
    ok: true,
    acquiredLease: true,
    listedCount: 0,
    enqueuedCount: 0,
    processedCount,
    retainedCount: 0,
    deletedCount: 0
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
