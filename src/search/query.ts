import type { ParsedSearchGroup, ParsedSearchQuery, ParsedSearchTerm, SearchField, SearchQuery } from '../shared/types';

const FIELD_PREFIXES = ['title', 'user', 'assistant'] as const;

export function parseSearchQuery(query: string | SearchQuery): ParsedSearchQuery {
  const raw = typeof query === 'string' ? query : query.text;
  const defaultField = typeof query === 'string' ? 'all' : (query.field ?? 'all');
  const sort = typeof query === 'string' ? 'relevance' : (query.sort ?? 'relevance');
  const groups: ParsedSearchGroup[] = [];
  let after: number | null = null;
  let before: number | null = null;

  for (const segment of splitOnUnquotedOr(raw)) {
    const group: ParsedSearchGroup = {
      include: [],
      exclude: []
    };

    for (const token of tokenizeSegment(segment)) {
      const parsedDate = parseDateFilter(token);
      if (parsedDate) {
        if (parsedDate.kind === 'after') after = parsedDate.value;
        if (parsedDate.kind === 'before') before = parsedDate.value;
        continue;
      }

      const term = parseTerm(token, defaultField);
      if (!term) continue;
      if (term.excluded) group.exclude.push(term.term);
      else group.include.push(term.term);
    }

    if (group.include.length > 0 || group.exclude.length > 0) groups.push(group);
  }

  return {
    raw,
    groups,
    after,
    before,
    sort
  };
}

function splitOnUnquotedOr(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuote = false;

  for (const char of value) {
    if (char === '"') inQuote = !inQuote;
    if (char === '|' && !inQuote) {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  segments.push(current.trim());
  return segments.filter(Boolean);
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < segment.length) {
    while (index < segment.length && /\s/.test(segment[index] ?? '')) index += 1;
    if (index >= segment.length) break;

    let token = '';
    let inQuote = false;
    while (index < segment.length) {
      const char = segment[index] ?? '';
      if (char === '"') {
        inQuote = !inQuote;
        token += char;
        index += 1;
        continue;
      }
      if (!inQuote && /\s/.test(char)) break;
      token += char;
      index += 1;
    }

    if (token.trim()) tokens.push(token.trim());
  }

  return tokens;
}

function parseDateFilter(token: string): { kind: 'after' | 'before'; value: number } | null {
  const match = /^(after|before):(\d{4}-\d{2}-\d{2})$/i.exec(token);
  if (!match) return null;

  const [, rawKind, rawDate] = match;
  const dateParts = rawDate?.split('-').map(Number) ?? [];
  const [year, month, day] = dateParts;
  if (!year || !month || !day) return null;

  const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();

  if (rawKind?.toLowerCase() === 'after') {
    return { kind: 'after', value: start };
  }

  return { kind: 'before', value: new Date(year, month - 1, day, 23, 59, 59, 999).getTime() };
}

function parseTerm(token: string, defaultField: SearchField): { excluded: boolean; term: ParsedSearchTerm } | null {
  let remaining = token;
  const excluded = remaining.startsWith('-');
  if (excluded) remaining = remaining.slice(1);
  if (!remaining) return null;

  let field: SearchField = defaultField;
  for (const prefix of FIELD_PREFIXES) {
    const marker = `${prefix}:`;
    if (remaining.toLowerCase().startsWith(marker)) {
      field = prefix;
      remaining = remaining.slice(marker.length);
      break;
    }
  }

  const phrase = remaining.startsWith('"') && remaining.endsWith('"') && remaining.length >= 2;
  const text = phrase ? remaining.slice(1, -1) : remaining;
  const trimmed = text.trim();
  if (!trimmed) return null;

  return {
    excluded,
    term: {
      field,
      text: trimmed,
      phrase
    }
  };
}
