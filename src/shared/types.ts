export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown';

export interface IndexedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  order: number;
  text: string;
  createdAt?: number;
}

export interface IndexedConversation {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: IndexedMessage[];
}

export interface ConversationMessageSnapshot {
  id: string;
  role: MessageRole;
  order: number;
  text: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ConversationSnapshot {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ConversationMessageSnapshot[];
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number;
  indexedAt: number;
  lastSeenAt: number;
  messageCount: number;
  retentionRank: number | null;
}

export interface MessageRecord {
  key: string;
  conversationId: string;
  id: string;
  role: MessageRole;
  order: number;
  text: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export type QueueItemStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface IndexingErrorDiagnostic {
  endpoint: string;
  method: 'GET';
  httpStatus: number | null;
  backendErrorCode: string | null;
  canRetry: boolean | null;
  stage: 'list' | 'detail' | 'storage' | 'scheduler' | 'bridge';
  occurredAt: number;
  retryCount: number;
  nextRetryAt: number | null;
}

export interface QueueItemRecord {
  id: string;
  conversationId: string;
  reason: string;
  status: QueueItemStatus;
  attempts: number;
  availableAt: number;
  updatedAt: number;
  lastError: string | null;
  generation?: string;
  lastErrorDiagnostic?: IndexingErrorDiagnostic | null;
}

export type CheckpointStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface CheckpointRecord {
  id: string;
  kind: string;
  status: CheckpointStatus;
  cursor: string | null;
  processedCount: number;
  retainedCount: number;
  updatedAt: number;
  lastError: string | null;
  generation?: string;
  lastErrorDiagnostic?: IndexingErrorDiagnostic | null;
}

export interface QueueStatusCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface DataDiagnostics {
  dbName: string;
  dbVersion: number;
  schemaVersion: number;
  conversationCount: number;
  messageCount: number;
  retainedConversationCount: number;
  queueCounts: QueueStatusCounts;
  checkpointCount: number;
  lastMigrationAt: number | null;
  lastRetentionAt: number | null;
  lastErrorAt: number | null;
  lastError: IndexingErrorDiagnostic | null;
  activeGeneration: string | null;
  lastSuccessfulListAt: number | null;
  lastSuccessfulDetailAt: number | null;
  lastCompletedAt: number | null;
}

export interface WorkerLeaseRecord {
  id: string;
  ownerId: string;
  expiresAt: number;
  updatedAt: number;
}

export interface IndexerDiagnostics {
  hardLimit: number;
  autoLimit?: number;
  burstLimit?: number;
  leaseOwnerId: string;
  leaseActive: boolean;
  lastRunAt: number | null;
  lastAutoScanAt?: number | null;
  lastIncrementalAt?: number | null;
  nextWakeAt?: number | null;
  offlineRecoveryCount?: number;
  retentionDeletedCount?: number;
  lastErrorCode: string | null;
  lastError: IndexingErrorDiagnostic | null;
  lastBackoffMs: number | null;
  processedCount: number;
  queueCounts: QueueStatusCounts;
  checkpoint: CheckpointRecord | null;
}

export interface DeepSearchGetDataDiagnosticsMessage {
  type: 'DEEP_SEARCH_GET_DATA_DIAGNOSTICS';
}

export interface DeepSearchGetDataDiagnosticsResponse {
  ok: boolean;
  diagnostics?: DataDiagnostics;
  error?: string;
}

export interface DeepSearchStartIndexingTestRunMessage {
  type: 'DEEP_SEARCH_START_INDEXING_TEST_RUN';
}

export interface DeepSearchStartIndexingTestRunResponse {
  ok: boolean;
  acquiredLease?: boolean;
  listedCount?: number;
  cappedCount?: number;
  processedCount?: number;
  error?: string;
}

export interface DeepSearchGetIndexerDiagnosticsMessage {
  type: 'DEEP_SEARCH_GET_INDEXER_DIAGNOSTICS';
}

export interface DeepSearchGetIndexerDiagnosticsResponse {
  ok: boolean;
  diagnostics?: IndexerDiagnostics;
  error?: string;
}

export type SearchField = 'all' | 'title' | 'user' | 'assistant';
export type SearchSort = 'relevance' | 'time';

export interface SearchQuery {
  text: string;
  field?: SearchField;
  sort?: SearchSort;
}

export interface ParsedSearchTerm {
  field: SearchField;
  text: string;
  phrase: boolean;
}

export interface ParsedSearchGroup {
  include: ParsedSearchTerm[];
  exclude: ParsedSearchTerm[];
}

export interface ParsedSearchQuery {
  raw: string;
  groups: ParsedSearchGroup[];
  after: number | null;
  before: number | null;
  sort: SearchSort;
}

export interface SearchHighlightSegment {
  text: string;
  highlighted: boolean;
}

export interface SearchSnippet {
  text: string;
  start: number;
  end: number;
  html?: never;
}

export interface SearchResult {
  conversationId: string;
  messageId: string | null;
  title: string;
  role: MessageRole | null;
  date: number;
  score: number;
  hitCount: number;
  snippet: SearchSnippet;
  highlightSegments: SearchHighlightSegment[];
}

export type SearchPanelIndexStatus = 'empty' | 'ready' | 'indexing' | 'error' | 'initializing' | 'completed';

export interface SearchPanelProgress {
  processedCount: number;
  retainedCount: number;
  totalCount: number;
}

export interface SearchPanelStateSnapshot {
  status: SearchPanelIndexStatus;
  conversationCount: number;
  messageCount: number;
  retainedConversationCount: number;
  queueCounts: QueueStatusCounts;
  checkpoint: CheckpointRecord | null;
  progress: SearchPanelProgress | null;
  lastErrorAt: number | null;
  lastError: IndexingErrorDiagnostic | null;
  lastSuccessAt: number | null;
}

export interface DeepSearchPanelStateMessage {
  type: 'DEEP_SEARCH_PANEL_STATE';
}

export interface DeepSearchPanelStateResponse {
  ok: boolean;
  state?: SearchPanelStateSnapshot;
  error?: string;
}

export interface DeepSearchQueryMessage {
  type: 'DEEP_SEARCH_QUERY';
  query: SearchQuery;
  limit?: number;
}

export interface DeepSearchQueryResponse {
  ok: boolean;
  results?: SearchResult[];
  total?: number;
  state?: SearchPanelStateSnapshot;
  error?: string;
}

export type AutoIndexEventReason = 'content-ready' | 'current-conversation-seen' | 'current-conversation-changed' | 'manual-check';

export interface DeepSearchContentReadyMessage {
  type: 'DEEP_SEARCH_CONTENT_READY';
  reason?: AutoIndexEventReason;
}

export interface DeepSearchCurrentConversationSeenMessage {
  type: 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN';
  conversationId: string;
  url: string;
}

export interface DeepSearchCurrentConversationChangedMessage {
  type: 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED';
  conversationId: string;
  url: string;
  title?: string;
}

export interface DeepSearchRunAutoIndexCheckMessage {
  type: 'DEEP_SEARCH_RUN_AUTO_INDEX_CHECK';
  reason?: AutoIndexEventReason;
}

export interface DeepSearchRunAutoIndexCheckResponse {
  ok: boolean;
  acquiredLease?: boolean;
  listedCount?: number;
  enqueuedCount?: number;
  processedCount?: number;
  retainedCount?: number;
  deletedCount?: number;
  error?: string;
}

export interface DeepSearchRebuildIndexMessage {
  type: 'DEEP_SEARCH_REBUILD_INDEX';
}

export interface DeepSearchRebuildIndexResponse {
  ok: boolean;
  clearedQueueCount?: number;
  clearedConversationCount?: number;
  clearedMessageCount?: number;
  error?: string;
}

export interface DeepSearchChatGPTApiRequestMessage {
  type: 'DEEP_SEARCH_CHATGPT_API_REQUEST';
  requestId: string;
  path: string;
  method: 'GET';
  stage: 'list' | 'detail';
}

export interface DeepSearchChatGPTApiResponse {
  ok: boolean;
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
}
