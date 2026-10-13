import type { ConversationRecord, MessageRecord } from '../../../src/shared/types';

const localDate = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

export const searchConversationRecords: ConversationRecord[] = [
  {
    id: 'conversation-search-alpha',
    title: '精确搜索 Alpha 标题',
    createdAt: localDate(2026, 1, 10),
    updatedAt: localDate(2026, 1, 12, 9),
    indexedAt: localDate(2026, 1, 12, 10),
    lastSeenAt: localDate(2026, 1, 12, 10),
    messageCount: 2,
    retentionRank: 1
  },
  {
    id: 'conversation-search-beta',
    title: 'Beta OR 查询与日期',
    createdAt: localDate(2026, 2, 5),
    updatedAt: localDate(2026, 2, 7, 9),
    indexedAt: localDate(2026, 2, 7, 10),
    lastSeenAt: localDate(2026, 2, 7, 10),
    messageCount: 2,
    retentionRank: 2
  },
  {
    id: 'conversation-search-gamma',
    title: 'Gamma 排除词验证',
    createdAt: localDate(2026, 3, 3),
    updatedAt: localDate(2026, 3, 4, 9),
    indexedAt: localDate(2026, 3, 4, 10),
    lastSeenAt: localDate(2026, 3, 4, 10),
    messageCount: 1,
    retentionRank: 3
  }
];

export const searchMessageRecords: MessageRecord[] = [
  {
    key: 'conversation-search-alpha::alpha-user',
    conversationId: 'conversation-search-alpha',
    id: 'alpha-user',
    role: 'user',
    order: 0,
    text: [
      '这是一段完整原文，必须完整存储并支持搜索。',
      '关键中文连续字符串：精确连续子串不能丢失。',
      'EnglishTerm 12345 exact_identifier'
    ].join('\n'),
    createdAt: localDate(2026, 1, 12, 8),
    updatedAt: null
  },
  {
    key: 'conversation-search-alpha::alpha-assistant',
    conversationId: 'conversation-search-alpha',
    id: 'alpha-assistant',
    role: 'assistant',
    order: 1,
    text: [
      'Alpha 助手消息回答包含完整短语：局部网络函数学习方法。',
      '代码片段 <script>alert("x")</script> 只能作为文本高亮，不能生成 HTML。'
    ].join('\n'),
    createdAt: localDate(2026, 1, 12, 8, 5),
    updatedAt: null
  },
  {
    key: 'conversation-search-beta::beta-user',
    conversationId: 'conversation-search-beta',
    id: 'beta-user',
    role: 'user',
    order: 0,
    text: 'Beta 用户消息包含 数字 67890 和 OROnlyToken。',
    createdAt: localDate(2026, 2, 7, 8),
    updatedAt: null
  },
  {
    key: 'conversation-search-beta::beta-assistant',
    conversationId: 'conversation-search-beta',
    id: 'beta-assistant',
    role: 'assistant',
    order: 1,
    text: 'Beta 助手消息包含另一条 ExactAssistantToken。',
    createdAt: localDate(2026, 2, 7, 8, 5),
    updatedAt: null
  },
  {
    key: 'conversation-search-gamma::gamma-user',
    conversationId: 'conversation-search-gamma',
    id: 'gamma-user',
    role: 'user',
    order: 0,
    text: 'Gamma 包含 should-exclude 和 保留词。',
    createdAt: localDate(2026, 3, 4, 8),
    updatedAt: null
  }
];
