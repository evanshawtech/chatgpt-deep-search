import { describe, expect, it } from 'vitest';
import { parseSearchQuery, searchExact } from '../../src/search';
import { searchConversationRecords, searchMessageRecords } from '../fixtures/search/records';

describe('parseSearchQuery', () => {
  it('parses AND, OR, quoted phrases, field scopes, exclusions, and dates', () => {
    const parsed = parseSearchQuery(
      'title:"精确搜索" user:完整 -assistant:"不要出现" after:2026-01-01 before:2026-01-31 | assistant:ExactAssistantToken'
    );

    expect(parsed.after).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
    expect(parsed.before).toBe(new Date(2026, 0, 31, 23, 59, 59, 999).getTime());
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]?.include).toMatchObject([
      { field: 'title', text: '精确搜索', phrase: true },
      { field: 'user', text: '完整', phrase: false }
    ]);
    expect(parsed.groups[0]?.exclude).toMatchObject([{ field: 'assistant', text: '不要出现', phrase: true }]);
    expect(parsed.groups[1]?.include).toMatchObject([{ field: 'assistant', text: 'ExactAssistantToken' }]);
  });
});

describe('searchExact', () => {
  it('finds full original text without truncation', () => {
    const results = runSearch('EnglishTerm 12345 exact_identifier');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      conversationId: 'conversation-search-alpha',
      messageId: 'alpha-user',
      role: 'user'
    });
    expect(results[0]?.snippet.text).toContain('EnglishTerm 12345 exact_identifier');
  });

  it('finds continuous Chinese substrings by direct original substring search', () => {
    const results = runSearch('精确连续子串不能丢失');

    expect(results).toHaveLength(1);
    expect(results[0]?.messageId).toBe('alpha-user');
    expect(results[0]?.snippet.text).toContain('精确连续子串不能丢失');
    expect(results[0]?.highlightSegments.some((segment) => segment.highlighted && segment.text === '精确连续子串不能丢失')).toBe(true);
  });

  it('does not falsely match a non-contiguous Chinese string', () => {
    expect(runSearch('精确连续不能丢失')).toHaveLength(0);
  });

  it('supports title, user, and assistant field filters', () => {
    expect(runSearch('title:精确搜索').map((result) => result.conversationId)).toEqual(['conversation-search-alpha']);
    expect(runSearch('user:ExactAssistantToken')).toHaveLength(0);
    expect(runSearch('assistant:ExactAssistantToken').map((result) => result.messageId)).toEqual(['beta-assistant']);
  });

  it('applies the panel default field filter without overriding explicit query fields', () => {
    expect(runSearchWithQuery({ text: 'ExactAssistantToken', field: 'assistant' }).map((result) => result.messageId)).toEqual([
      'beta-assistant'
    ]);
    expect(runSearchWithQuery({ text: 'ExactAssistantToken', field: 'user' })).toHaveLength(0);
    expect(runSearchWithQuery({ text: 'assistant:ExactAssistantToken', field: 'user' }).map((result) => result.messageId)).toEqual([
      'beta-assistant'
    ]);
  });

  it('supports AND, quoted phrase, OR, and exclusions together', () => {
    expect(runSearch('完整 原文').map((result) => result.messageId)).toEqual(['alpha-user']);
    expect(runSearch('"局部网络函数学习方法"').map((result) => result.messageId)).toEqual(['alpha-assistant']);
    expect(runSearch('OROnlyToken | ExactAssistantToken').map((result) => result.messageId)).toEqual(['beta-assistant', 'beta-user']);
    expect(runSearch('保留词 -should-exclude')).toHaveLength(0);
  });

  it('applies inclusive date ranges', () => {
    expect(runSearch('Beta after:2026-02-07 before:2026-02-07').map((result) => result.conversationId)).toEqual([
      'conversation-search-beta',
      'conversation-search-beta',
      'conversation-search-beta'
    ]);
    expect(runSearch('Beta before:2026-02-06')).toHaveLength(0);
  });

  it('sorts by relevance deterministically before falling back to time', () => {
    const results = runSearch('Beta');

    expect(results.map((result) => [result.messageId, result.title])).toEqual([
      [null, 'Beta OR 查询与日期'],
      ['beta-assistant', 'Beta OR 查询与日期'],
      ['beta-user', 'Beta OR 查询与日期']
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('sorts by newest time when requested', () => {
    const results = searchExact({
      query: { text: '消息', sort: 'time' },
      conversations: searchConversationRecords,
      messages: searchMessageRecords
    });

    expect(results.map((result) => result.conversationId)).toEqual([
      'conversation-search-beta',
      'conversation-search-beta',
      'conversation-search-alpha'
    ]);
    expect(results.map((result) => result.messageId)).toEqual(['beta-assistant', 'beta-user', 'alpha-assistant']);
  });

  it('returns safe snippet and highlight segments without HTML', () => {
    const [result] = runSearch('<script>alert("x")</script>');

    expect(result).toBeDefined();
    expect(result?.snippet.text).toContain('<script>alert("x")</script>');
    expect(result?.snippet.html).toBeUndefined();
    expect(result?.highlightSegments).toEqual(
      expect.arrayContaining([
        {
          text: '<script>alert("x")</script>',
          highlighted: true
        }
      ])
    );
  });
});

function runSearch(text: string) {
  return runSearchWithQuery({ text });
}

function runSearchWithQuery(query: Parameters<typeof searchExact>[0]['query']) {
  return searchExact({
    query,
    conversations: searchConversationRecords,
    messages: searchMessageRecords
  });
}
