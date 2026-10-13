import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_SEARCH_LABEL,
  DEEP_SEARCH_ROW_SELECTOR,
  SidebarInjector,
  SidebarLocator
} from '../../src/content/sidebar-locator';

function getShadowButton(row: Element | null): HTMLButtonElement | null {
  return row instanceof HTMLElement ? row.shadowRoot?.querySelector('button') ?? null : null;
}

describe('SidebarLocator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('finds the native search row by visible text inside the sidebar navigation', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <a href="#new">新聊天</a>
          <a href="#search">搜索聊天</a>
          <a href="#library">文件库</a>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.getAttribute('href')).toBe('#search');
    expect(location?.matchedLabel).toBe('搜索聊天');
    expect(location?.strategy).toBe('element');
  });

  it('promotes a nested aria-label match to the clickable row', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <button type="button" aria-label="搜索聊天">
            <span><span>搜索聊天</span></span>
          </button>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.tagName).toBe('BUTTON');
  });

  it('ignores hidden matching rows', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <a href="#hidden" hidden>搜索聊天</a>
          <a href="#search">搜索聊天</a>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.getAttribute('href')).toBe('#search');
  });

  it('finds a non-interactive sidebar row when 搜索聊天 is split across descendants', () => {
    document.body.innerHTML = `
      <aside aria-label="ChatGPT 侧栏">
        <nav aria-label="主导航">
          <div class="row"><span>新聊天</span></div>
          <div class="row" data-row="native-search">
            <span aria-hidden="true"></span>
            <span>搜索</span><span>聊天</span>
          </div>
          <div class="row"><span>文件库</span></div>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.getAttribute('data-row')).toBe('native-search');
  });

  it('does not treat a grouped menu container as the native search row', () => {
    document.body.innerHTML = `
      <aside aria-label="ChatGPT 侧栏">
        <nav aria-label="主导航">
          <div data-row-group="primary">
            <div class="row"><span>新聊天</span></div>
            <div class="row" data-row="native-search">
              <span aria-hidden="true"></span>
              <span>搜索</span><span>聊天</span>
            </div>
            <div class="row"><span>文件库</span></div>
            <div class="row"><span>项目</span></div>
          </div>
          <div class="row"><span>已安排</span></div>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.getAttribute('data-row')).toBe('native-search');
    expect(location?.searchRow.getAttribute('data-row-group')).toBeNull();
  });

  it('promotes a nested native button to its tight row wrapper for insertion', () => {
    document.body.innerHTML = `
      <aside aria-label="ChatGPT 侧栏">
        <nav aria-label="主导航">
          <div data-row="new"><button type="button">新聊天</button></div>
          <div data-row="native-search">
            <button type="button" aria-label="搜索聊天"><span>搜索聊天</span></button>
          </div>
          <div data-row="library"><button type="button">文件库</button></div>
        </nav>
      </aside>
    `;

    const location = new SidebarLocator(document).locate();

    expect(location?.searchRow.getAttribute('data-row')).toBe('native-search');
  });
});

describe('SidebarInjector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('inserts 深度搜索 immediately below 搜索聊天', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <a href="#new">新聊天</a>
          <a href="#search" data-testid="native-search-chat">搜索聊天</a>
          <a href="#library">文件库</a>
        </nav>
      </aside>
    `;

    const injector = new SidebarInjector({ document, onOpenPanel: vi.fn() });
    expect(injector.ensureInjected('unit')).toBe(true);

    const nativeSearch = document.querySelector('[data-testid="native-search-chat"]');
    const deepSearch = document.querySelector(DEEP_SEARCH_ROW_SELECTOR);
    const button = getShadowButton(deepSearch);

    expect(button?.textContent).toContain(DEEP_SEARCH_LABEL);
    expect(button?.querySelector('.dot')).toBeNull();
    expect(button?.querySelector('.cgds-sidebar-dot')).toBeNull();
    expect(nativeSearch?.nextElementSibling).toBe(deepSearch);
  });

  it('reuses the native search icon sprite and block label structure', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <button
            tabindex="0"
            data-fill=""
            class="group __menu-item hoverable w-full"
            data-sidebar-item="true"
            type="button"
            data-revealed=""
            data-testid="native-search-chat"
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <div class="relative flex items-center justify-center icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true" class="icon">
                  <use href="/cdn/assets/sprites-core-c74d0474.svg#ac6d36" fill="currentColor"></use>
                </svg>
              </div>
              <div class="flex min-w-0 grow items-center gap-2.5">
                <div class="truncate">搜索聊天</div>
              </div>
            </div>
          </button>
          <button type="button">文件库</button>
        </nav>
      </aside>
    `;

    const injector = new SidebarInjector({ document, onOpenPanel: vi.fn() });
    expect(injector.ensureInjected('unit')).toBe(true);

    const deepSearch = document.querySelector(DEEP_SEARCH_ROW_SELECTOR);
    const button = getShadowButton(deepSearch);
    const iconUse = button?.querySelector('.cgds-sidebar-icon svg use');
    const icon = button?.querySelector('.cgds-sidebar-icon');
    const label = button?.querySelector('.cgds-sidebar-label');

    expect(iconUse?.getAttribute('href')).toBe('/cdn/assets/sprites-core-c74d0474.svg#ac6d36');
    expect(icon?.tagName).toBe('DIV');
    expect(label?.tagName).toBe('DIV');
  });

  it('keeps insertion idempotent across repeated ensure calls', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <a href="#search" data-testid="native-search-chat">搜索聊天</a>
          <a href="#library">文件库</a>
        </nav>
      </aside>
    `;

    const injector = new SidebarInjector({ document, onOpenPanel: vi.fn() });
    injector.ensureInjected('first');
    injector.ensureInjected('second');

    expect(document.querySelectorAll(DEEP_SEARCH_ROW_SELECTOR)).toHaveLength(1);
  });

  it('moves an existing row back under a rebuilt native search row', () => {
    document.body.innerHTML = `
      <aside>
        <nav data-testid="nav">
          <a href="#search" data-testid="native-search-chat">搜索聊天</a>
          <a href="#library">文件库</a>
        </nav>
      </aside>
    `;

    const injector = new SidebarInjector({ document, onOpenPanel: vi.fn() });
    injector.ensureInjected('first');

    const nav = document.querySelector('[data-testid="nav"]');
    expect(nav).not.toBeNull();
    nav!.innerHTML = `
      <a href="#new">新聊天</a>
      <a href="#search" data-testid="native-search-chat">搜索聊天</a>
      <a href="#projects">项目</a>
    `;

    injector.ensureInjected('rebuild');

    const nativeSearch = document.querySelector('[data-testid="native-search-chat"]');
    const rows = document.querySelectorAll(DEEP_SEARCH_ROW_SELECTOR);
    expect(rows).toHaveLength(1);
    expect(nativeSearch?.nextElementSibling).toBe(rows[0]);
  });

  it('opens the placeholder panel callback when the row is clicked', () => {
    document.body.innerHTML = `
      <aside>
        <nav>
          <a href="#search" data-testid="native-search-chat">搜索聊天</a>
        </nav>
      </aside>
    `;

    const onOpenPanel = vi.fn();
    const injector = new SidebarInjector({ document, onOpenPanel });
    injector.ensureInjected('unit');

    getShadowButton(document.querySelector(DEEP_SEARCH_ROW_SELECTOR))?.click();

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });
});
