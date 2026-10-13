import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const CONTENT_SCRIPT_PATH = path.resolve(process.cwd(), 'dist/content/index.js');
const DEEP_ROW = '[data-chatgpt-deep-search-row="true"]';

interface RecordedMessage {
  readonly type: string;
  readonly conversationId?: string;
  readonly reason?: string;
}

test('reports content ready and a new chat route when the URL becomes /c/new-id', async ({ page }) => {
  const recorder = await installRecordingRuntime(page.context());
  await page.goto('http://127.0.0.1:4173/');
  await loadContentScript(page);

  await page.evaluate(() => {
    window.history.pushState({}, '', '/c/new-id');
    (window as unknown as { __mockChatGPT: { renderConversationContent: () => void } }).__mockChatGPT.renderConversationContent();
  });

  await recorder.waitFor((messages) =>
    messages.some((message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' && message.conversationId === 'new-id')
  );
  expect(recorder.messages.some((message) => message.type === 'DEEP_SEARCH_CONTENT_READY')).toBe(true);
});

test('reports appended messages in the current conversation after debounce', async ({ page }) => {
  const recorder = await installRecordingRuntime(page.context());
  await page.goto('http://127.0.0.1:4173/c/conversation-hit');
  await loadContentScript(page);

  await recorder.waitFor((messages) =>
    messages.some(
      (message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' && message.conversationId === 'conversation-hit'
    )
  );

  await page.evaluate(() => {
    const container = document.querySelector('.mock-conversation');
    const article = document.createElement('article');
    article.className = 'mock-message';
    article.dataset.messageId = 'message-new';
    article.textContent = '新增消息触发自动增量索引';
    container?.append(article);
  });

  await recorder.waitFor((messages) =>
    messages.some(
      (message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED' && message.conversationId === 'conversation-hit'
    )
  );
});

test('handles two tabs on the same conversation with one idempotent pending queue entry', async ({ context }) => {
  const recorder = await installRecordingRuntime(context);
  const first = await context.newPage();
  const second = await context.newPage();

  await first.goto('http://127.0.0.1:4173/c/conversation-hit');
  await second.goto('http://127.0.0.1:4173/c/conversation-hit');
  await loadContentScript(first);
  await loadContentScript(second);

  await recorder.waitFor(() => recorder.queueIds.has('conversation-hit'));
  expect(recorder.queueIds.size).toBe(1);
  expect(
    recorder.messages.filter(
      (message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' && message.conversationId === 'conversation-hit'
    ).length
  ).toBeGreaterThanOrEqual(2);
});

test('refresh re-reports the current conversation without duplicating the sidebar row', async ({ page }) => {
  const recorder = await installRecordingRuntime(page.context());
  await page.goto('http://127.0.0.1:4173/c/conversation-hit');
  await loadContentScript(page);
  await recorder.waitFor(
    (messages) =>
      messages.filter(
        (message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' && message.conversationId === 'conversation-hit'
      ).length >= 1
  );

  await page.reload();
  await loadContentScript(page);
  await recorder.waitFor(
    (messages) =>
      messages.filter(
        (message) => message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' && message.conversationId === 'conversation-hit'
      ).length >= 2
  );

  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
});

test('panel progress can show automatic indexing status for the recent 200 range', async ({ page }) => {
  await installRecordingRuntime(page.context(), {
    panelState: {
      status: 'indexing',
      conversationCount: 200,
      messageCount: 1800,
      retainedConversationCount: 200,
      queueCounts: { pending: 195, running: 0, completed: 5, failed: 0 },
      checkpoint: {
        id: 'auto-index',
        kind: 'auto-index',
        status: 'running',
        cursor: 'conversation-195',
        processedCount: 5,
        retainedCount: 200,
        updatedAt: Date.now(),
        lastError: null
      },
      progress: {
        processedCount: 5,
        retainedCount: 200,
        totalCount: 200
      },
      lastErrorAt: null
    }
  });
  await page.goto('http://127.0.0.1:4173/');
  await loadContentScript(page);
  await page.locator(DEEP_ROW).click();

  await expect(page.getByRole('dialog', { name: '深度搜索' })).toBeVisible();
  await expect(page.getByText('200 个对话 · 1800 条消息')).toBeVisible();
  await expect(page.getByText('正在索引 5 / 200 个对话')).toBeVisible();
});

async function loadContentScript(page: Page): Promise<void> {
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
  await expect(page.locator('html')).toHaveAttribute('data-chatgpt-deep-search-boot', 'phase-1-sidebar');
}

async function installRecordingRuntime(
  context: BrowserContext,
  options: {
    readonly panelState?: unknown;
  } = {}
): Promise<{
  readonly messages: RecordedMessage[];
  readonly queueIds: Set<string>;
  readonly waitFor: (predicate: (messages: readonly RecordedMessage[]) => boolean) => Promise<void>;
}> {
  const messages: RecordedMessage[] = [];
  const queueIds = new Set<string>();
  await context.exposeBinding('recordDeepSearchMessage', (_source, message: RecordedMessage) => {
    messages.push(message);
    if (
      (message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_SEEN' ||
        message.type === 'DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED') &&
      message.conversationId
    ) {
      queueIds.add(message.conversationId);
    }
  });

  await context.addInitScript((panelState) => {
    const defaultState = {
      status: 'ready',
      conversationCount: 0,
      messageCount: 0,
      retainedConversationCount: 0,
      queueCounts: { pending: 0, running: 0, completed: 0, failed: 0 },
      checkpoint: null,
      progress: null,
      lastErrorAt: null
    };
    const browserWindow = window as unknown as {
      recordDeepSearchMessage: (message: RecordedMessage) => void;
      chrome: {
        runtime: {
          lastError?: { message: string };
          onMessage: { addListener: () => void };
          sendMessage: (message: RecordedMessage, callback?: (response: unknown) => void) => void;
        };
      };
    };

    browserWindow.chrome = {
      runtime: {
        onMessage: {
          addListener: () => undefined
        },
        sendMessage: (message, callback) => {
          browserWindow.recordDeepSearchMessage(message);
          if (message.type === 'DEEP_SEARCH_PANEL_STATE') {
            callback?.({ ok: true, state: panelState ?? defaultState });
            return;
          }
          if (message.type === 'DEEP_SEARCH_QUERY') {
            callback?.({ ok: true, results: [], total: 0, state: panelState ?? defaultState });
            return;
          }
          callback?.({ ok: true });
        }
      }
    };
  }, options.panelState ?? null);

  return {
    messages,
    queueIds,
    waitFor: async (predicate) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (predicate(messages)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for messages. Saw: ${JSON.stringify(messages)}`);
    }
  };
}
