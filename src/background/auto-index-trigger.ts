import type { DeepSearchRunAutoIndexCheckResponse } from '../shared/types';

export interface AutoIndexTriggerRequest {
  readonly reason: string;
  readonly scanList: boolean;
  readonly currentConversationId?: string;
}

export type AutoIndexTriggerRunner = (
  request: AutoIndexTriggerRequest
) => Promise<DeepSearchRunAutoIndexCheckResponse>;

export interface AutoIndexTriggerController {
  readonly trigger: (request: AutoIndexTriggerRequest) => Promise<DeepSearchRunAutoIndexCheckResponse>;
}

interface PendingAutoIndexBatch {
  readonly currentConversationIds: Set<string>;
  reasons: string[];
  scanList: boolean;
}

export function createAutoIndexTriggerController(run: AutoIndexTriggerRunner): AutoIndexTriggerController {
  let activeRun: Promise<DeepSearchRunAutoIndexCheckResponse> | null = null;
  const pending: PendingAutoIndexBatch = {
    currentConversationIds: new Set<string>(),
    reasons: [],
    scanList: false
  };

  const trigger = (request: AutoIndexTriggerRequest): Promise<DeepSearchRunAutoIndexCheckResponse> => {
    mergePendingRequest(pending, request);
    activeRun ??= drainPendingRequests(run, pending).finally(() => {
      activeRun = null;
      if (hasPendingRequest(pending)) {
        activeRun = drainPendingRequests(run, pending).finally(() => {
          activeRun = null;
        });
      }
    });
    return activeRun;
  };

  return { trigger };
}

async function drainPendingRequests(
  run: AutoIndexTriggerRunner,
  pending: PendingAutoIndexBatch
): Promise<DeepSearchRunAutoIndexCheckResponse> {
  let latestResponse = emptyAutoIndexResponse();

  while (hasPendingRequest(pending)) {
    const requests = takePendingRequests(pending);
    for (const request of requests) {
      latestResponse = await run(request);
    }
  }

  return latestResponse;
}

function mergePendingRequest(pending: PendingAutoIndexBatch, request: AutoIndexTriggerRequest): void {
  pending.scanList ||= request.scanList;
  pending.reasons.push(request.reason);
  if (request.currentConversationId) pending.currentConversationIds.add(request.currentConversationId);
}

function takePendingRequests(pending: PendingAutoIndexBatch): AutoIndexTriggerRequest[] {
  const reason = pending.reasons.at(-1) ?? 'auto-index';
  const scanList = pending.scanList;
  const currentConversationIds = [...pending.currentConversationIds];
  pending.scanList = false;
  pending.reasons = [];
  pending.currentConversationIds.clear();

  if (currentConversationIds.length === 0) {
    return scanList ? [{ reason, scanList: true }] : [];
  }

  return currentConversationIds.map((currentConversationId, index) => ({
    reason,
    scanList: scanList && index === 0,
    currentConversationId
  }));
}

function hasPendingRequest(pending: PendingAutoIndexBatch): boolean {
  return pending.scanList || pending.currentConversationIds.size > 0;
}

function emptyAutoIndexResponse(): DeepSearchRunAutoIndexCheckResponse {
  return {
    ok: true,
    acquiredLease: false,
    listedCount: 0,
    enqueuedCount: 0,
    processedCount: 0,
    retainedCount: 0,
    deletedCount: 0
  };
}
