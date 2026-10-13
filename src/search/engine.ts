import type {
  ConversationRecord,
  MessageRecord,
  MessageRole,
  ParsedSearchGroup,
  ParsedSearchQuery,
  ParsedSearchTerm,
  SearchHighlightSegment,
  SearchQuery,
  SearchResult,
  SearchSnippet
} from '../shared/types';
import { parseSearchQuery } from './query';

interface ExactSearchInput {
  readonly query: string | SearchQuery | ParsedSearchQuery;
  readonly conversations: readonly ConversationRecord[];
  readonly messages: readonly MessageRecord[];
  readonly snippetRadius?: number;
  readonly limit?: number;
}

interface SearchDocument {
  readonly key: string;
  readonly kind: 'title' | 'message';
  readonly conversation: ConversationRecord;
  readonly message: MessageRecord | null;
  readonly title: string;
  readonly text: string;
  readonly role: MessageRole | null;
  readonly date: number;
}

interface MatchRange {
  readonly start: number;
  readonly end: number;
}

interface DocumentMatch {
  readonly document: SearchDocument;
  readonly ranges: MatchRange[];
  readonly hitCount: number;
  readonly phraseHitCount: number;
}

const DEFAULT_SNIPPET_RADIUS = 36;

export function searchExact(input: ExactSearchInput): SearchResult[] {
  const parsed = isParsedQuery(input.query) ? input.query : parseSearchQuery(input.query);
  if (parsed.groups.length === 0) return [];

  const conversationsById = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  const documents = createSearchDocuments(input.conversations, input.messages);
  const bestMatches = new Map<string, DocumentMatch>();

  for (const document of documents) {
    if (!isWithinDateRange(document.date, parsed.after, parsed.before)) continue;

    for (const group of parsed.groups) {
      const match = matchDocument(document, group);
      if (!match) continue;

      const existing = bestMatches.get(document.key);
      if (!existing || scoreMatch(match) > scoreMatch(existing)) {
        bestMatches.set(document.key, match);
      }
    }
  }

  const results = Array.from(bestMatches.values()).map((match) => buildResult(match, input.snippetRadius ?? DEFAULT_SNIPPET_RADIUS));
  results.sort(parsed.sort === 'time' ? compareByTime : compareByRelevance);
  return input.limit === undefined ? results : results.slice(0, input.limit).filter((result) => conversationsById.has(result.conversationId));
}

function createSearchDocuments(
  conversations: readonly ConversationRecord[],
  messages: readonly MessageRecord[]
): SearchDocument[] {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const documents: SearchDocument[] = [];

  conversations.forEach((conversation) => {
    documents.push({
      key: `title:${conversation.id}`,
      kind: 'title',
      conversation,
      message: null,
      title: conversation.title,
      text: conversation.title,
      role: null,
      date: conversation.updatedAt
    });
  });

  messages.forEach((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;

    const conversation = conversationsById.get(message.conversationId);
    if (!conversation) return;

    documents.push({
      key: `message:${message.key}`,
      kind: 'message',
      conversation,
      message,
      title: conversation.title,
      text: message.text,
      role: message.role,
      date: message.createdAt ?? message.updatedAt ?? conversation.updatedAt
    });
  });

  return documents;
}

function matchDocument(document: SearchDocument, group: ParsedSearchGroup): DocumentMatch | null {
  const ranges: MatchRange[] = [];
  let hitCount = 0;
  let phraseHitCount = 0;

  for (const excludedTerm of group.exclude) {
    if (!termCanMatchDocument(excludedTerm, document)) continue;
    if (findAllRanges(document.text, excludedTerm.text).length > 0) return null;
  }

  for (const includedTerm of group.include) {
    if (!termCanMatchDocument(includedTerm, document)) return null;

    const termRanges = findAllRanges(document.text, includedTerm.text);
    if (termRanges.length === 0) return null;

    ranges.push(...termRanges);
    hitCount += termRanges.length;
    if (includedTerm.phrase) phraseHitCount += termRanges.length;
  }

  return {
    document,
    ranges: mergeRanges(ranges),
    hitCount,
    phraseHitCount
  };
}

function termCanMatchDocument(term: ParsedSearchTerm, document: SearchDocument): boolean {
  if (term.field === 'all') return true;
  if (term.field === 'title') return document.kind === 'title';
  if (term.field === 'user') return document.role === 'user';
  return document.role === 'assistant';
}

function findAllRanges(text: string, needle: string): MatchRange[] {
  const normalizedText = normalizeForExactMatch(text);
  const normalizedNeedle = normalizeForExactMatch(needle);
  const ranges: MatchRange[] = [];
  if (!normalizedNeedle) return ranges;

  let start = 0;
  while (start <= normalizedText.length) {
    const index = normalizedText.indexOf(normalizedNeedle, start);
    if (index < 0) break;

    ranges.push({
      start: index,
      end: index + normalizedNeedle.length
    });
    start = index + Math.max(1, normalizedNeedle.length);
  }

  return ranges;
}

function buildResult(match: DocumentMatch, snippetRadius: number): SearchResult {
  const snippet = createSnippet(match.document.text, match.ranges, snippetRadius);
  const highlightSegments = createHighlightSegments(snippet.text, snippet.start, match.ranges);

  return {
    conversationId: match.document.conversation.id,
    messageId: match.document.message?.id ?? null,
    title: match.document.title,
    role: match.document.role,
    date: match.document.date,
    score: scoreMatch(match),
    hitCount: match.hitCount,
    snippet,
    highlightSegments
  };
}

function createSnippet(text: string, ranges: readonly MatchRange[], radius: number): SearchSnippet {
  const firstRange = ranges[0] ?? { start: 0, end: 0 };
  const start = Math.max(0, firstRange.start - radius);
  const end = Math.min(text.length, firstRange.end + radius);

  return {
    text: text.slice(start, end),
    start,
    end
  };
}

function createHighlightSegments(snippetText: string, snippetStart: number, ranges: readonly MatchRange[]): SearchHighlightSegment[] {
  const segments: SearchHighlightSegment[] = [];
  const snippetEnd = snippetStart + snippetText.length;
  let cursor = 0;

  for (const range of mergeRanges(ranges)) {
    const start = Math.max(range.start, snippetStart);
    const end = Math.min(range.end, snippetEnd);
    if (start >= end) continue;

    const localStart = start - snippetStart;
    const localEnd = end - snippetStart;
    if (localStart > cursor) {
      segments.push({
        text: snippetText.slice(cursor, localStart),
        highlighted: false
      });
    }
    segments.push({
      text: snippetText.slice(localStart, localEnd),
      highlighted: true
    });
    cursor = localEnd;
  }

  if (cursor < snippetText.length) {
    segments.push({
      text: snippetText.slice(cursor),
      highlighted: false
    });
  }

  return segments;
}

function scoreMatch(match: DocumentMatch): number {
  const titleBonus = match.document.kind === 'title' ? 1_000 : 0;
  return titleBonus + match.phraseHitCount * 100 + match.hitCount * 10 + match.document.date / 1_000_000_000_000_000;
}

function compareByRelevance(left: SearchResult, right: SearchResult): number {
  if (left.score !== right.score) return right.score - left.score;
  return compareByTime(left, right);
}

function compareByTime(left: SearchResult, right: SearchResult): number {
  if (left.date !== right.date) return right.date - left.date;
  if (left.conversationId !== right.conversationId) return left.conversationId.localeCompare(right.conversationId);
  return (left.messageId ?? '').localeCompare(right.messageId ?? '');
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = ranges.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MatchRange[] = [];

  sorted.forEach((range) => {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push(range);
      return;
    }

    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end)
    };
  });

  return merged;
}

function isWithinDateRange(date: number, after: number | null, before: number | null): boolean {
  if (after !== null && date < after) return false;
  if (before !== null && date > before) return false;
  return true;
}

function normalizeForExactMatch(value: string): string {
  return value.toLocaleLowerCase();
}

function isParsedQuery(value: string | SearchQuery | ParsedSearchQuery): value is ParsedSearchQuery {
  return typeof value === 'object' && value !== null && 'groups' in value;
}
