import type { ConversationMessageSnapshot, ConversationSnapshot, IndexingErrorDiagnostic, MessageRole } from '../shared/types';

export type ChatGPTAdapterErrorCode =
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONVERSATION_INACCESSIBLE'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE';

export interface ChatGPTAdapterErrorOptions {
  readonly code: ChatGPTAdapterErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly recoverable: boolean;
  readonly message: string;
  readonly diagnostic?: IndexingErrorDiagnostic;
}

export class ChatGPTAdapterError extends Error {
  public readonly code: ChatGPTAdapterErrorCode;
  public readonly status: number | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly recoverable: boolean;
  public readonly diagnostic: IndexingErrorDiagnostic | undefined;

  public constructor(options: ChatGPTAdapterErrorOptions) {
    super(options.message);
    this.name = 'ChatGPTAdapterError';
    this.code = options.code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.recoverable = options.recoverable;
    this.diagnostic = options.diagnostic;
  }
}

export interface ChatGPTTransportRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers?: Record<string, string>;
  readonly stage?: 'list' | 'detail';
}

export interface ChatGPTTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers | Record<string, string>;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}

export interface ChatGPTTransport {
  request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse>;
}

export interface ChatGPTConversationListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ChatGPTConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number | undefined;
  readonly updatedAt: number | undefined;
}

export interface ChatGPTConversationListPage {
  readonly items: ChatGPTConversationListItem[];
  readonly nextCursor: string | null;
}

export interface ChatGPTConversationAdapterOptions {
  readonly transport?: ChatGPTTransport;
  readonly baseUrl?: string;
}

export class ChatGPTConversationAdapter {
  private readonly transport: ChatGPTTransport;
  private readonly baseUrl: string;

  public constructor(options: ChatGPTConversationAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchChatGPTTransport();
    this.baseUrl = options.baseUrl ?? 'https://chatgpt.com';
  }

  public async listConversations(options: ChatGPTConversationListOptions = {}): Promise<ChatGPTConversationListPage> {
    const url = new URL('/backend-api/conversations', this.baseUrl);
    const limit = options.limit ?? 50;
    const offset = options.cursor ? Math.max(0, Number(options.cursor) || 0) : 0;
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('order', 'updated');
    url.searchParams.set('is_archived', 'false');
    url.searchParams.set('is_starred', 'false');

    const payload = await this.requestJson({
      url: url.toString(),
      method: 'GET',
      stage: 'list'
    });

    return normalizeConversationList(payload);
  }

  public async getConversationDetail(conversationId: string): Promise<ConversationSnapshot> {
    const url = new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, this.baseUrl);
    const payload = await this.requestJson({
      url: url.toString(),
      method: 'GET',
      stage: 'detail'
    });

    return normalizeConversationDetail(payload, conversationId);
  }

  private async requestJson(request: ChatGPTTransportRequest): Promise<unknown> {
    let response: ChatGPTTransportResponse;
    try {
      response = await this.transport.request(request);
    } catch (error) {
      if (error instanceof ChatGPTAdapterError) throw error;
      throw new ChatGPTAdapterError({
        code: 'NETWORK_ERROR',
        recoverable: true,
        message: 'ChatGPT request failed before receiving a response',
        diagnostic: createDiagnostic({
          request,
          httpStatus: null,
          backendErrorCode: null,
          canRetry: true
        })
      });
    }

    if (!response.ok) {
      throw await createHttpError(response, request);
    }

    try {
      return await response.json();
    } catch {
      throw new ChatGPTAdapterError({
        code: 'INVALID_RESPONSE',
        status: response.status,
        recoverable: false,
        message: 'ChatGPT response was not valid JSON',
        diagnostic: createDiagnostic({
          request,
          httpStatus: response.status,
          backendErrorCode: 'invalid_json',
          canRetry: false
        })
      });
    }
  }
}

export class FetchChatGPTTransport implements ChatGPTTransport {
  private readonly fetchImplementation: typeof globalThis.fetch;

  public constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImplementation = fetchImplementation;
  }

  public async request(request: ChatGPTTransportRequest): Promise<ChatGPTTransportResponse> {
    const init: RequestInit = {
      method: request.method,
      credentials: 'include'
    };
    if (request.headers) init.headers = request.headers;

    const response = await this.fetchImplementation(request.url, init);

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
      text: () => response.text()
    };
  }
}

function normalizeConversationList(payload: unknown): ChatGPTConversationListPage {
  if (!isRecord(payload)) {
    throwInvalidResponse('ChatGPT conversation list response was not an object');
  }

  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.conversations)
      ? payload.conversations
      : null;

  if (!rawItems) {
    throwInvalidResponse('ChatGPT conversation list response did not include an item array');
  }

  const items = rawItems.map((item) => normalizeConversationListItem(item));
  const limit = readOptionalNumber(payload.limit);
  const offset = readOptionalNumber(payload.offset);
  const total = readOptionalNumber(payload.total);
  const offsetNextCursor =
    limit !== undefined && offset !== undefined && total !== undefined && offset + items.length < total
      ? String(offset + Math.max(items.length, limit))
      : null;

  return {
    items,
    nextCursor:
      readOptionalString(payload.next_cursor) ??
      readOptionalString(payload.nextCursor) ??
      readOptionalString(payload.cursor) ??
      offsetNextCursor
  };
}

function normalizeConversationListItem(item: unknown): ChatGPTConversationListItem {
  if (!isRecord(item)) {
    throwInvalidResponse('ChatGPT conversation list item was not an object');
  }

  const id = readRequiredString(item.id, 'conversation id');
  return {
    id,
    title: readOptionalString(item.title) ?? 'Untitled',
    createdAt: normalizeTimestamp(item.create_time ?? item.createdAt),
    updatedAt: normalizeTimestamp(item.update_time ?? item.updatedAt)
  };
}

function normalizeConversationDetail(payload: unknown, fallbackId: string): ConversationSnapshot {
  const root = isRecord(payload) && isRecord(payload.conversation) ? payload.conversation : payload;
  if (!isRecord(root)) {
    throwInvalidResponse('ChatGPT conversation detail response was not an object');
  }

  const id = readOptionalString(root.id) ?? fallbackId;
  const title = readOptionalString(root.title) ?? 'Untitled';
  const messages = normalizeDetailMessages(root);

  if (messages.length === 0) {
    throwInvalidResponse('ChatGPT conversation detail did not contain visible messages');
  }

  const snapshot: ConversationSnapshot = {
    id,
    title,
    messages
  };
  const createdAt = normalizeTimestamp(root.create_time ?? root.createdAt);
  const updatedAt = normalizeTimestamp(root.update_time ?? root.updatedAt);
  if (createdAt !== undefined) snapshot.createdAt = createdAt;
  if (updatedAt !== undefined) snapshot.updatedAt = updatedAt;
  return snapshot;
}

function normalizeDetailMessages(root: Record<string, unknown>): ConversationMessageSnapshot[] {
  const rawMessages = Array.isArray(root.messages)
    ? root.messages
    : isRecord(root.mapping)
      ? Object.values(root.mapping)
          .map((node) => (isRecord(node) ? node.message : null))
          .filter((message): message is unknown => message !== null && message !== undefined)
      : [];

  return rawMessages
    .map((message, index) => normalizeMessage(message, index))
    .filter((message): message is ConversationMessageSnapshot => message !== null)
    .map((message, index) => ({
      ...message,
      order: index
    }));
}

function normalizeMessage(message: unknown, fallbackOrder: number): ConversationMessageSnapshot | null {
  if (!isRecord(message)) return null;

  const text = extractVisibleText(message.content);
  if (!text) return null;

  const snapshot: ConversationMessageSnapshot = {
    id: readOptionalString(message.id) ?? `message-${fallbackOrder}`,
    role: normalizeRole(message.role ?? (isRecord(message.author) ? message.author.role : undefined)),
    order: fallbackOrder,
    text
  };
  const createdAt = normalizeTimestamp(message.create_time ?? message.createdAt);
  const updatedAt = normalizeTimestamp(message.update_time ?? message.updatedAt);
  if (createdAt !== undefined) snapshot.createdAt = createdAt;
  if (updatedAt !== undefined) snapshot.updatedAt = updatedAt;
  return snapshot;
}

function extractVisibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return joinTextParts(content.map((part) => extractVisibleText(part)));
  if (!isRecord(content)) return '';

  const directText = readOptionalString(content.text) ?? readOptionalString(content.result);
  const nestedContent = directText ?? extractVisibleText(content.content);
  const parts = Array.isArray(content.parts) ? joinTextParts(content.parts.map((part) => extractVisibleText(part))) : '';
  return joinTextParts([nestedContent, parts]);
}

function joinTextParts(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join('\n');
}

async function createHttpError(
  response: ChatGPTTransportResponse,
  request: ChatGPTTransportRequest
): Promise<ChatGPTAdapterError> {
  const status = response.status;
  const backendError = await readBackendError(response);
  const retryAfterMs = parseRetryAfterMs(readHeader(response.headers, 'retry-after'));
  const backendCanRetry = backendError.canRetry;
  const code =
    backendError.code === 'conversation_inaccessible' && backendCanRetry === false
      ? 'CONVERSATION_INACCESSIBLE'
      : status === 401
        ? 'UNAUTHORIZED'
        : status === 429
          ? 'RATE_LIMITED'
          : status === 403
            ? 'FORBIDDEN'
            : status >= 500
              ? 'SERVER_ERROR'
              : 'HTTP_ERROR';
  const recoverable =
    code === 'RATE_LIMITED' ||
    code === 'SERVER_ERROR' ||
    (backendCanRetry === true && status !== 401 && status !== 404);

  const options: ChatGPTAdapterErrorOptions = {
    code,
    status,
    recoverable,
    message: `ChatGPT request failed with HTTP ${status}`,
    diagnostic: createDiagnostic({
      request,
      httpStatus: status,
      backendErrorCode: backendError.code,
      canRetry: backendCanRetry
    }),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
  return new ChatGPTAdapterError(options);
}

async function readBackendError(
  response: ChatGPTTransportResponse
): Promise<{ readonly code: string | null; readonly canRetry: boolean | null }> {
  try {
    const payload = await response.json();
    const detail = isRecord(payload) && isRecord(payload.detail) ? payload.detail : payload;
    if (!isRecord(detail)) return { code: null, canRetry: null };
    return {
      code: readOptionalString(detail.code) ?? null,
      canRetry: typeof detail.can_retry === 'boolean' ? detail.can_retry : null
    };
  } catch {
    return { code: null, canRetry: null };
  }
}

function createDiagnostic(options: {
  readonly request: ChatGPTTransportRequest;
  readonly httpStatus: number | null;
  readonly backendErrorCode: string | null;
  readonly canRetry: boolean | null;
}): IndexingErrorDiagnostic {
  const url = new URL(options.request.url);
  return {
    endpoint: `${url.pathname}${url.search}`,
    method: options.request.method,
    httpStatus: options.httpStatus,
    backendErrorCode: options.backendErrorCode,
    canRetry: options.canRetry,
    stage: options.request.stage ?? 'scheduler',
    occurredAt: Date.now(),
    retryCount: 0,
    nextRetryAt: null
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1_000));
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

function readHeader(headers: Headers | Record<string, string>, name: string): string | null {
  const maybeHeaders = headers as Headers;
  if (typeof maybeHeaders.get === 'function') return maybeHeaders.get(name);

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return normalizeTimestamp(parsed);

    const date = Date.parse(value);
    return Number.isFinite(date) ? date : undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 1_000_000_000_000 ? Math.round(value * 1_000) : Math.round(value);
}

function normalizeRole(value: unknown): MessageRole {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool' ? value : 'unknown';
}

function readRequiredString(value: unknown, label: string): string {
  const result = readOptionalString(value);
  if (!result) throwInvalidResponse(`ChatGPT response was missing ${label}`);
  return result;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function throwInvalidResponse(message: string): never {
  throw new ChatGPTAdapterError({
    code: 'INVALID_RESPONSE',
    recoverable: false,
    message
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
