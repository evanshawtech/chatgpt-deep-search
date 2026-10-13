import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const CONTENT_SCRIPT_PATH = path.resolve(process.cwd(), 'dist/content/index.js');
const DEEP_ROW = '[data-chatgpt-deep-search-row="true"]';

type MockMode = 'results' | 'empty' | 'loading' | 'error' | 'progress' | 'missing-message';

test('renders the Phase 5 panel in light and dark mode with stable geometry', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPanelWithMockRuntime(page, 'results');
  await assertPanelFitsViewport(page);

  const lightBackground = await panelBackground(page);
  expect(lightBackground).toBe('rgb(255, 255, 255)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await openPanelWithMockRuntime(page, 'results');
  await assertPanelFitsViewport(page);

  const darkBackground = await panelBackground(page);
  expect(darkBackground).not.toBe(lightBackground);
});

test('keeps the search panel usable across window sizes', async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 860, height: 620 },
    { width: 430, height: 760 }
  ]) {
    await page.setViewportSize(viewport);
    await openPanelWithMockRuntime(page, 'results');
    await assertPanelFitsViewport(page);
    await expect(page.locator('[data-search-input]')).toBeVisible();
  }
});

test('renders long titles, long code snippets, safe highlights, and exact search results', async ({ page }) => {
  await openPanelWithMockRuntime(page, 'results');

  await page.locator('[data-search-input]').fill('精确连续子串不能丢失');
  await page.locator('[data-search-input]').press('Enter');

  await expect(page.locator('[data-panel][data-panel-state="results"]')).toBeVisible();
  await expect(page.locator('[data-result-item]')).toHaveCount(2);
  await expect(page.locator('[data-result-title]').first()).toContainText('非常长的标题');
  await expect(page.locator('[data-result-snippet]').first()).toContainText('```ts');
  await expect(page.locator('[data-highlight]').first()).toHaveText('精确连续子串不能丢失');

  const unsafeHtmlRendered = await page.evaluate(() => {
    const shadow = document.getElementById('chatgpt-deep-search-panel-host')?.shadowRoot;
    return Boolean(shadow?.querySelector('img, script'));
  });
  expect(unsafeHtmlRendered).toBe(false);

  const overflow = await page.locator('[data-results]').evaluate((results) => ({
    scrollWidth: results.scrollWidth,
    clientWidth: results.clientWidth
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('renders empty, loading, error, and indexing progress states', async ({ page }) => {
  await openPanelWithMockRuntime(page, 'empty');
  await page.locator('[data-search-input]').fill('没有结果');
  await page.locator('[data-search-input]').press('Enter');
  await expect(page.locator('[data-panel][data-panel-state="empty"]')).toBeVisible();
  await expect(page.getByText('没有找到匹配结果。')).toBeVisible();

  await openPanelWithMockRuntime(page, 'loading');
  await page.locator('[data-search-input]').fill('加载中');
  await page.locator('[data-search-input]').press('Enter');
  await expect(page.locator('[data-panel][data-panel-state="loading"]')).toBeVisible();
  await expect(page.locator('[data-panel][data-panel-state="results"]')).toBeVisible();

  await openPanelWithMockRuntime(page, 'error');
  await page.locator('[data-search-input]').fill('错误');
  await page.locator('[data-search-input]').press('Enter');
  await expect(page.locator('[data-panel][data-panel-state="error"]')).toBeVisible();
  await expect(page.getByText('固定搜索错误')).toBeVisible();

  await openPanelWithMockRuntime(page, 'progress');
  await expect(page.getByText('正在索引 2 / 5 个对话')).toBeVisible();
});

test('opens the correct conversation and highlights the target message', async ({ page }) => {
  await openPanelWithMockRuntime(page, 'results');

  await page.locator('[data-search-input]').fill('定位消息');
  await page.locator('[data-search-input]').press('Enter');
  await page.locator('[data-result-item]').first().click();

  await expect(page).toHaveURL(/\/c\/conversation-hit$/);
  await expect(page.locator('.mock-message[data-message-id="message-hit"]')).toHaveAttribute(
    'data-chatgpt-deep-search-target',
    'true'
  );
  await expect(page.getByText('已定位到命中消息')).toBeVisible();
});

test('shows an explicit fallback when message location fails after opening a conversation', async ({ page }) => {
  await openPanelWithMockRuntime(page, 'missing-message');

  await page.locator('[data-search-input]').fill('无法定位');
  await page.locator('[data-search-input]').press('Enter');
  await page.locator('[data-result-item]').first().click();

  await expect(page).toHaveURL(/\/c\/conversation-hit$/);
  await expect(page.getByText('已打开对话，未能定位到具体消息')).toBeVisible();
});

async function openPanelWithMockRuntime(page: Page, mode: MockMode): Promise<void> {
  await installMockRuntime(page, mode);
  await page.goto('http://127.0.0.1:4173/');
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
  await expect(page.locator('html')).toHaveAttribute('data-chatgpt-deep-search-boot', 'phase-1-sidebar');
  await page.locator(DEEP_ROW).click();
  await expect(page.getByRole('dialog', { name: '深度搜索' })).toBeVisible();
}

async function installMockRuntime(page: Page, mode: MockMode): Promise<void> {
  await page.addInitScript((mockMode) => {
    const readyState = {
      status: 'ready',
      conversationCount: 615,
      messageCount: 11630,
      retainedConversationCount: 200,
      queueCounts: { pending: 0, running: 0, completed: 3, failed: 0 },
      checkpoint: null,
      progress: null,
      lastErrorAt: null
    };
    const progressState = {
      ...readyState,
      status: 'indexing',
      queueCounts: { pending: 3, running: 1, completed: 2, failed: 0 },
      checkpoint: {
        id: 'phase5-progress',
        kind: 'test',
        status: 'running',
        cursor: 'conversation-3',
        processedCount: 2,
        retainedCount: 5,
        updatedAt: Date.now(),
        lastError: null
      },
      progress: {
        processedCount: 2,
        retainedCount: 5,
        totalCount: 5
      }
    };
    const resultMessageId = mockMode === 'missing-message' ? 'message-missing' : 'message-hit';
    const results = [
      {
        conversationId: 'conversation-hit',
        messageId: resultMessageId,
        title: '非常长的标题 ChatGPT 深度搜索结果需要稳定截断但不能挤破面板布局 '.repeat(3),
        role: 'assistant',
        date: Date.UTC(2026, 5, 16),
        score: 200,
        hitCount: 2,
        snippet: {
          text: '```ts\nconst exact = "精确连续子串不能丢失";\nconsole.log(exact.repeat(20));\n```',
          start: 0,
          end: 78
        },
        highlightSegments: [
          { text: '```ts\nconst exact = "', highlighted: false },
          { text: '精确连续子串不能丢失', highlighted: true },
          { text: '";\nconsole.log(exact.repeat(20));\n```', highlighted: false }
        ]
      },
      {
        conversationId: 'conversation-hit',
        messageId: 'message-long-code',
        title: '安全高亮测试',
        role: 'user',
        date: Date.UTC(2026, 5, 15),
        score: 120,
        hitCount: 1,
        snippet: {
          text: '<img src=x onerror=alert(1)> 应该作为纯文本显示',
          start: 0,
          end: 38
        },
        highlightSegments: [{ text: '<img src=x onerror=alert(1)>', highlighted: true }, { text: ' 应该作为纯文本显示', highlighted: false }]
      }
    ];

    const browserWindow = window as unknown as {
      chrome: {
        runtime: {
          lastError?: { message: string };
          onMessage: { addListener: () => void };
          sendMessage: (message: { type: string }, callback: (response: unknown) => void) => void;
        };
      };
    };

    browserWindow.chrome = {
      runtime: {
        onMessage: {
          addListener: () => undefined
        },
        sendMessage: (message: { type: string }, callback: (response: unknown) => void) => {
          if (message.type === 'DEEP_SEARCH_PANEL_STATE') {
            callback({ ok: true, state: mockMode === 'progress' ? progressState : readyState });
            return;
          }

          if (message.type === 'DEEP_SEARCH_QUERY') {
            if (mockMode === 'error') {
              callback({ ok: false, error: '固定搜索错误' });
              return;
            }
            const response = {
              ok: true,
              results: mockMode === 'empty' ? [] : results,
              total: mockMode === 'empty' ? 0 : results.length,
              state: mockMode === 'progress' ? progressState : readyState
            };
            if (mockMode === 'loading') {
              window.setTimeout(() => callback(response), 350);
              return;
            }
            callback(response);
          }
        }
      }
    };
  }, mode);
}

async function assertPanelFitsViewport(page: Page): Promise<void> {
  const geometry = await page.locator('[data-panel]').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });

  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.width).toBeGreaterThan(320);
  expect(geometry.height).toBeGreaterThan(420);
}

async function panelBackground(page: Page): Promise<string> {
  return page.locator('[data-panel]').evaluate((panel) => window.getComputedStyle(panel).backgroundColor);
}
