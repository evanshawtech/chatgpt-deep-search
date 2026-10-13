import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const CONTENT_SCRIPT_PATH = path.resolve(process.cwd(), 'dist/content/index.js');
const DEEP_ROW = '[data-chatgpt-deep-search-row="true"]';
const VISUAL_ROW = '[data-chatgpt-deep-search-visual-row="true"]';

async function loadContentScript(page: Page): Promise<void> {
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
  await expect(page.locator('html')).toHaveAttribute('data-chatgpt-deep-search-boot', 'phase-1-sidebar');
}

async function expectDeepSearchDirectlyBelowNative(
  page: Page,
  nativeSelector = '[data-testid="native-search-chat"]'
): Promise<void> {
  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '深度搜索' })).toBeVisible();
  await expect(page.locator(`${DEEP_ROW} .dot`)).toHaveCount(0);
  await expect(page.locator(`${DEEP_ROW} .cgds-sidebar-dot`)).toHaveCount(0);

  const isDirectSibling = await page.locator(nativeSelector).evaluate((nativeSearch) => {
    return nativeSearch.nextElementSibling?.getAttribute('data-chatgpt-deep-search-row') === 'true';
  });
  expect(isDirectSibling).toBe(true);
}

test('inserts the 深度搜索 row directly below 搜索聊天 and opens the search panel', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/');
  await loadContentScript(page);

  await expectDeepSearchDirectlyBelowNative(page);

  await page.locator(DEEP_ROW).click();
  await expect(page.getByRole('dialog', { name: '深度搜索' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索全部历史对话...')).toBeVisible();
  await expect(page.getByText('索引未启用')).toBeVisible();
});

test('waits for delayed sidebar rendering before inserting', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?scenario=delayed-sidebar&delay=300');
  await loadContentScript(page);

  await expectDeepSearchDirectlyBelowNative(page);
});

test('ignores offscreen duplicate sidebars and inserts into the visible ChatGPT sidebar', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?scenario=offscreen-duplicate');
  await loadContentScript(page);

  await expectDeepSearchDirectlyBelowNative(page, 'aside:not(.mock-offscreen-copy) [data-testid="native-search-chat"]');

  const placement = await page.evaluate(() => {
    const visibleSearch = document.querySelector('aside:not(.mock-offscreen-copy) [data-testid="native-search-chat"]');
    const hiddenSearch = document.querySelector('aside.mock-offscreen-copy [data-testid="native-search-chat"]');
    const deepRow = document.querySelector('[data-chatgpt-deep-search-row="true"]');
    const rect = deepRow?.getBoundingClientRect();
    return {
      visibleSibling: visibleSearch?.nextElementSibling === deepRow,
      hiddenSibling: hiddenSearch?.nextElementSibling === deepRow,
      left: rect?.left ?? -1,
      width: rect?.width ?? 0
    };
  });

  expect(placement.visibleSibling).toBe(true);
  expect(placement.hiddenSibling).toBe(false);
  expect(placement.left).toBeGreaterThanOrEqual(0);
  expect(placement.width).toBeGreaterThan(180);
});

test('waits for startup hydration before mutating the sidebar DOM', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?scenario=hydrating-sidebar&hydrateDelay=500');
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
  await page.waitForTimeout(100);

  await expect(page.locator('html')).toHaveAttribute('data-mock-hydration-error', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-chatgpt-deep-search-boot', 'phase-1-sidebar');
  await expectDeepSearchDirectlyBelowNative(page);
  await expect(page.locator('html')).toHaveAttribute('data-mock-hydration-error', 'false');
});

test('finds current-style nested sidebar rows with split visible text', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?variant=split-div');
  await loadContentScript(page);

  await expectDeepSearchDirectlyBelowNative(page, '[data-mock-row="搜索聊天"]');
});

test('inserts outside a clipped native button wrapper so the row is visible', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?variant=wrapped-button');
  await loadContentScript(page);

  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
  await expect(page.locator(DEEP_ROW)).toBeVisible();

  const placement = await page.locator('.mock-row-wrapper[data-mock-row="搜索聊天"]').evaluate((nativeWrapper) => {
    const deepRow = document.querySelector('[data-chatgpt-deep-search-row="true"]');
    return {
      isSiblingAfterWrapper: nativeWrapper.nextElementSibling === deepRow,
      deepParentIsWrapper: deepRow?.parentElement === nativeWrapper
    };
  });

  expect(placement).toEqual({
    isSiblingAfterWrapper: true,
    deepParentIsWrapper: false
  });
});

test('matches a direct div row shape when ChatGPT nav hides non-row tags', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?variant=strict-div');
  await loadContentScript(page);

  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
  await expect(page.locator(DEEP_ROW)).toBeVisible();

  const shape = await page.locator(DEEP_ROW).evaluate((deepRow) => ({
    tag: deepRow.tagName.toLowerCase(),
    parentTag: deepRow.parentElement?.tagName.toLowerCase(),
    previousSiblingTag: deepRow.previousElementSibling?.tagName.toLowerCase()
  }));

  expect(shape).toEqual({
    tag: 'div',
    parentTag: 'nav',
    previousSiblingTag: 'div'
  });
});

test('keeps compact inline row visible when sidebar CSS requires native wrappers', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?variant=clone-required');
  await loadContentScript(page);

  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
  await expect(page.locator(DEEP_ROW)).toBeVisible();
  await expect(page.getByRole('button', { name: '深度搜索' })).toBeVisible();
});

test('uses a shadow sidebar host that stays in flow when ChatGPT hides cloned nav rows', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?scenario=hidden-extension-row&variant=split-div');
  await loadContentScript(page);

  await expect(page.locator(DEEP_ROW)).toHaveCount(1);
  await expect(page.locator(DEEP_ROW)).toBeVisible();
  await expect(page.locator(VISUAL_ROW)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '深度搜索' })).toBeVisible();
  await expect(page.locator(`${DEEP_ROW} .dot`)).toHaveCount(0);
  await expect(page.locator(`${DEEP_ROW} .cgds-sidebar-dot`)).toHaveCount(0);

  const geometry = await page.locator(DEEP_ROW).evaluate((host) => {
    const rect = host.getBoundingClientRect();
    const searchRow = document.querySelector('[data-testid="native-search-chat"], [data-mock-row="搜索聊天"]');
    const nextRow = document.querySelector('[href="#library"], [data-mock-row="文件库"]');
    const button = host.shadowRoot?.querySelector('button');
    const label = host.shadowRoot?.querySelector('.cgds-sidebar-label');
    const icon = host.shadowRoot?.querySelector('.cgds-sidebar-icon');
    const content = host.shadowRoot?.querySelector('.cgds-sidebar-content');
    const iconUse = host.shadowRoot?.querySelector('.cgds-sidebar-icon svg use');
    const style = window.getComputedStyle(host);
    const buttonStyle = button ? window.getComputedStyle(button) : null;
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const contentStyle = content ? window.getComputedStyle(content) : null;
    const searchRect = searchRow?.getBoundingClientRect();
    const nextRect = nextRow?.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      height: rect.height,
      position: style.position,
      width: rect.width,
      leftDelta: searchRect ? Math.abs(rect.left - searchRect.left) : Number.POSITIVE_INFINITY,
      topDelta: searchRect ? Math.abs(rect.top - (searchRect.bottom + 2)) : Number.POSITIVE_INFINITY,
      widthDelta: searchRect ? Math.abs(rect.width - searchRect.width) : Number.POSITIVE_INFINITY,
      buttonWidth: buttonRect?.width ?? 0,
      buttonHeight: buttonRect?.height ?? 0,
      buttonMarginLeft: buttonStyle?.marginLeft ?? '',
      iconWidth: iconRect?.width ?? 0,
      labelFontSize: labelStyle?.fontSize ?? '',
      labelLineHeight: labelStyle?.lineHeight ?? '',
      contentGap: contentStyle?.gap ?? '',
      iconUseHref: iconUse?.getAttribute('href') ?? null,
      isBodyChild: host.parentElement === document.body,
      isSiblingAfterSearch: searchRow?.nextElementSibling === host,
      sameParentAsSearch: searchRow?.parentElement === host.parentElement,
      hasDot: Boolean(host.shadowRoot?.querySelector('.dot, .cgds-sidebar-dot')),
      labelFits: label ? label.scrollWidth <= label.clientWidth + 1 : false,
      overlapsNext: nextRect ? rect.bottom > nextRect.top && rect.top < nextRect.bottom : false
    };
  });

  expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
  expect(geometry.position).not.toBe('fixed');
  expect(geometry.height).toBeGreaterThan(32);
  expect(geometry.height).toBeLessThanOrEqual(44);
  expect(geometry.width).toBeGreaterThan(180);
  expect(geometry.buttonWidth).toBeGreaterThan(160);
  expect(geometry.buttonHeight).toBe(40);
  expect(geometry.buttonMarginLeft).toBe('0px');
  expect(geometry.iconWidth).toBe(20);
  expect(geometry.labelFontSize).toBe('14px');
  expect(geometry.labelLineHeight).toBe('20px');
  expect(geometry.contentGap).toBe('6px');
  expect(geometry.iconUseHref).toBe('/cdn/assets/sprites-core-c74d0474.svg#ac6d36');
  expect(geometry.leftDelta).toBeLessThanOrEqual(1);
  expect(geometry.topDelta).toBeLessThanOrEqual(2);
  expect(geometry.widthDelta).toBeLessThanOrEqual(1);
  expect(geometry.isBodyChild).toBe(false);
  expect(geometry.isSiblingAfterSearch).toBe(true);
  expect(geometry.sameParentAsSearch).toBe(true);
  expect(geometry.hasDot).toBe(false);
  expect(geometry.labelFits).toBe(true);
  expect(geometry.overlapsNext).toBe(false);

  await page.getByRole('button', { name: '深度搜索' }).click();
  await expect(page.getByRole('dialog', { name: '深度搜索' })).toBeVisible();
});

test('survives DOM rebuilds and repeated content script bootstrap without duplicates', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/');
  await loadContentScript(page);
  await loadContentScript(page);
  await expectDeepSearchDirectlyBelowNative(page);

  await page.evaluate(() => {
    const mock = (window as unknown as { __mockChatGPT: { rebuildSidebar: (options?: unknown) => void } }).__mockChatGPT;
    mock.rebuildSidebar({ variant: 'button' });
  });

  await expectDeepSearchDirectlyBelowNative(page);
});

test('keeps a single row when the sidebar is collapsed and expanded', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/?collapsed=true');
  await loadContentScript(page);
  await expectDeepSearchDirectlyBelowNative(page);

  await page.evaluate(() => {
    const mock = (window as unknown as { __mockChatGPT: { setCollapsed: (collapsed: boolean) => void } }).__mockChatGPT;
    mock.setCollapsed(false);
  });

  await expectDeepSearchDirectlyBelowNative(page);
});

test('opens the search panel from the keyboard fallback', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/');
  await loadContentScript(page);
  await expectDeepSearchDirectlyBelowNative(page);

  await page.keyboard.press('Alt+Shift+F');
  await expect(page.getByRole('dialog', { name: '深度搜索' })).toBeVisible();
});
