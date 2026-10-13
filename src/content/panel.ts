import { navigateToSearchResult } from './navigation';
import { createRuntimeSearchPanelClient, type SearchPanelClient } from './panel-client';
import { createInitialPanelModel, derivePanelViewState, type SearchPanelModel } from './panel-state';
import type { SearchField, SearchResult, SearchSort } from '../shared/types';

export interface DeepSearchPanel {
  readonly isOpen: () => boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
}

export interface DeepSearchPanelOptions {
  readonly client?: SearchPanelClient;
}

const PANEL_HOST_ID = 'chatgpt-deep-search-panel-host';
const PANEL_RENDER_VERSION = 'phase-5-search-panel';
const SEARCH_DEBOUNCE_MS = 180;
const RESULT_LIMIT = 30;

export function createDeepSearchPanel(doc: Document = document, options: DeepSearchPanelOptions = {}): DeepSearchPanel {
  const existing = doc.getElementById(PANEL_HOST_ID) as HTMLElement | null;
  const host = existing ?? doc.createElement('div');
  host.id = PANEL_HOST_ID;
  host.dataset.chatgptDeepSearchPanel = 'true';

  if (!existing) {
    doc.documentElement.append(host);
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const client = options.client ?? createRuntimeSearchPanelClient(doc.defaultView ?? window);

  if (host.dataset.chatgptDeepSearchPanelRender !== PANEL_RENDER_VERSION) {
    shadow.replaceChildren();
    renderPanel(shadow, doc);
    host.dataset.chatgptDeepSearchPanelRender = PANEL_RENDER_VERSION;
  }

  const controller = new SearchPanelController(shadow, doc, client);
  return controller.createHandle();
}

class SearchPanelController {
  private readonly overlay: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly fieldFilter: HTMLSelectElement;
  private readonly sortFilter: HTMLSelectElement;
  private readonly stats: HTMLElement;
  private readonly progressStrip: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly results: HTMLElement;
  private readonly footerCount: HTMLElement;
  private readonly navigationStatus: HTMLElement;
  private readonly client: SearchPanelClient;
  private readonly doc: Document;
  private model: SearchPanelModel = createInitialPanelModel();
  private searchTimer: number | null = null;
  private searchSequence = 0;
  private stateLoaded = false;

  public constructor(shadow: ShadowRoot, doc: Document, client: SearchPanelClient) {
    this.doc = doc;
    this.client = client;
    this.overlay = mustFind(shadow, '[data-panel-overlay]');
    this.panel = mustFind(shadow, '[data-panel]');
    this.searchInput = mustFind(shadow, '[data-search-input]');
    this.fieldFilter = mustFind(shadow, '[data-field-filter]');
    this.sortFilter = mustFind(shadow, '[data-sort-filter]');
    this.stats = mustFind(shadow, '[data-panel-stats]');
    this.progressStrip = mustFind(shadow, '[data-progress-strip]');
    this.progressText = mustFind(shadow, '[data-progress-text]');
    this.results = mustFind(shadow, '[data-results]');
    this.footerCount = mustFind(shadow, '[data-footer-count]');
    this.navigationStatus = mustFind(shadow, '[data-navigation-status]');

    this.bindEvents(shadow);
    this.render();
  }

  public createHandle(): DeepSearchPanel {
    return {
      isOpen: () => this.overlay.hidden !== true,
      open: () => this.setOpen(true),
      close: () => this.setOpen(false),
      toggle: () => this.setOpen(this.overlay.hidden === true)
    };
  }

  private bindEvents(shadow: ShadowRoot): void {
    shadow.querySelectorAll('[data-close-panel]').forEach((element) => {
      element.addEventListener('click', () => this.setOpen(false));
    });

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.setOpen(false);
    });

    shadow.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        event.preventDefault();
        this.setOpen(false);
      }
    });

    this.searchInput.addEventListener('input', () => this.scheduleSearch());
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.runSearch();
      }
    });

    this.fieldFilter.addEventListener('change', () => this.runSearchIfQueryExists());
    this.sortFilter.addEventListener('change', () => this.runSearchIfQueryExists());
  }

  private setOpen(open: boolean): void {
    this.overlay.hidden = !open;
    this.overlay.setAttribute('aria-hidden', String(!open));
    if (!open) return;

    void this.loadState();
    this.doc.defaultView?.setTimeout(() => this.searchInput.focus(), 0);
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;

    try {
      const state = await this.client.getState();
      this.model = {
        ...this.model,
        mode: state.status === 'indexing' ? 'progress' : 'initial',
        state,
        error: null
      };
      this.render();
    } catch (error) {
      this.model = {
        ...this.model,
        mode: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
      this.render();
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== null) {
      this.doc.defaultView?.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    this.searchTimer =
      this.doc.defaultView?.setTimeout(() => {
        this.searchTimer = null;
        this.runSearch();
      }, SEARCH_DEBOUNCE_MS) ?? null;
  }

  private runSearchIfQueryExists(): void {
    if (!this.searchInput.value.trim()) {
      this.model = {
        ...this.model,
        queryText: '',
        results: [],
        total: 0,
        mode: this.model.state?.status === 'indexing' ? 'progress' : 'initial'
      };
      this.render();
      return;
    }

    this.runSearch();
  }

  private async runSearch(): Promise<void> {
    if (this.searchTimer !== null) {
      this.doc.defaultView?.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    const queryText = this.searchInput.value;
    const trimmedQuery = queryText.trim();
    const sequence = ++this.searchSequence;

    if (!trimmedQuery) {
      this.model = {
        ...this.model,
        mode: this.model.state?.status === 'indexing' ? 'progress' : 'initial',
        queryText,
        results: [],
        total: 0,
        error: null
      };
      this.render();
      return;
    }

    this.model = {
      ...this.model,
      mode: 'loading',
      queryText,
      results: [],
      total: 0,
      error: null,
      navigationStatus: null
    };
    this.render();

    try {
      const response = await this.client.search({
        text: queryText,
        field: this.fieldFilter.value as SearchField,
        sort: this.sortFilter.value as SearchSort,
        limit: RESULT_LIMIT
      });
      if (sequence !== this.searchSequence) return;

      this.model = {
        ...this.model,
        mode: response.results.length > 0 ? 'results' : 'empty',
        results: response.results,
        total: response.total,
        state: response.state,
        error: null
      };
      this.render();
    } catch (error) {
      if (sequence !== this.searchSequence) return;

      this.model = {
        ...this.model,
        mode: 'error',
        results: [],
        total: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      this.render();
    }
  }

  private render(): void {
    const view = derivePanelViewState(this.model);
    this.panel.dataset.panelState = view.mode;
    this.stats.textContent = view.headerStats;
    this.progressText.textContent = view.progressLabel;
    this.footerCount.textContent = view.footerCount;
    this.progressStrip.hidden = !view.showProgress && view.mode !== 'initial' && view.mode !== 'results';
    this.navigationStatus.hidden = !view.navigationStatus;
    this.navigationStatus.textContent = view.navigationStatus ?? '';

    this.results.replaceChildren();
    if (view.showResults) {
      this.model.results.forEach((result) => {
        this.results.append(this.createResultRow(result));
      });
      return;
    }

    const state = this.doc.createElement('div');
    state.className = `state state-${view.mode}`;
    state.dataset.emptyState = view.mode === 'empty' ? 'true' : 'false';
    state.textContent = view.errorMessage ?? view.emptyMessage;
    this.results.append(state);
  }

  private createResultRow(result: SearchResult): HTMLElement {
    const row = this.doc.createElement('button');
    row.type = 'button';
    row.className = 'result';
    row.dataset.resultItem = 'true';
    row.dataset.conversationId = result.conversationId;
    if (result.messageId) row.dataset.messageId = result.messageId;

    const main = this.doc.createElement('span');
    main.className = 'result-main';

    const heading = this.doc.createElement('span');
    heading.className = 'result-heading';

    const title = this.doc.createElement('span');
    title.className = 'result-title';
    title.dataset.resultTitle = 'true';
    title.textContent = result.title;

    const pill = this.doc.createElement('span');
    pill.className = 'role-pill';
    pill.textContent = roleLabel(result.role);

    heading.append(title, pill);

    const snippet = this.doc.createElement('span');
    snippet.className = 'snippet';
    snippet.dataset.resultSnippet = 'true';
    if (result.highlightSegments.length > 0) {
      result.highlightSegments.forEach((segment) => {
        const span = this.doc.createElement('span');
        if (segment.highlighted) span.dataset.highlight = 'true';
        span.textContent = segment.text;
        snippet.append(span);
      });
    } else {
      snippet.textContent = result.snippet.text;
    }

    main.append(heading, snippet);

    const meta = this.doc.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = formatDate(result.date);

    row.append(main, meta);
    row.addEventListener('click', () => {
      void this.openResult(result);
    });
    return row;
  }

  private async openResult(result: SearchResult): Promise<void> {
    const navigationResult = await navigateToSearchResult(result, {
      window: this.doc.defaultView ?? window
    });

    this.model = {
      ...this.model,
      navigationStatus: navigationResult.located ? '已定位到命中消息' : '已打开对话，未能定位到具体消息'
    };
    this.render();
  }
}

function renderPanel(shadow: ShadowRoot, doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = createPanelCss();

  const overlay = doc.createElement('div');
  overlay.hidden = true;
  overlay.dataset.panelOverlay = 'true';
  overlay.setAttribute('aria-hidden', 'true');

  const panel = doc.createElement('section');
  panel.className = 'panel';
  panel.dataset.panel = 'true';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'cgds-panel-title');

  panel.append(createTopbar(doc), createSearchRow(doc), createFilters(doc), createSyntaxHint(doc), createProgressStrip(doc), createResults(doc), createFooter(doc));
  overlay.append(panel);
  shadow.append(style, overlay);
}

function createTopbar(doc: Document): HTMLElement {
  const topbar = doc.createElement('div');
  topbar.className = 'topbar';

  const title = doc.createElement('h2');
  title.id = 'cgds-panel-title';
  title.textContent = '深度搜索';

  const stats = doc.createElement('div');
  stats.className = 'stats';
  stats.dataset.panelStats = 'true';
  stats.textContent = '0 个对话 · 0 条消息';

  const more = doc.createElement('button');
  more.className = 'icon-button more-button';
  more.type = 'button';
  more.setAttribute('aria-label', '更多');
  more.textContent = '•••';

  const close = doc.createElement('button');
  close.className = 'icon-button';
  close.type = 'button';
  close.dataset.closePanel = 'true';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';

  topbar.append(title, stats, more, close);
  return topbar;
}

function createSearchRow(doc: Document): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'search-row';

  const searchBox = doc.createElement('label');
  searchBox.className = 'search-box';

  const icon = createSearchIcon(doc);
  const input = doc.createElement('input');
  input.dataset.searchInput = 'true';
  input.placeholder = '搜索全部历史对话...';
  input.autocomplete = 'off';
  input.spellcheck = false;

  searchBox.append(icon, input);

  const button = doc.createElement('button');
  button.className = 'secondary';
  button.type = 'button';
  button.disabled = true;
  button.textContent = '索引当前对话';

  row.append(searchBox, button);
  return row;
}

function createFilters(doc: Document): HTMLElement {
  const filters = doc.createElement('div');
  filters.className = 'filters';

  filters.append(
    createSelect(doc, 'field-filter', '搜索范围', [
      ['all', '全部内容'],
      ['title', '标题'],
      ['user', '用户'],
      ['assistant', '助手']
    ]),
    createSelect(doc, 'sort-filter', '排序', [
      ['relevance', '按相关度'],
      ['time', '按时间']
    ]),
    createCheckboxChip(doc, '精确搜索', true, true),
    createCheckboxChip(doc, '容错搜索', false, false),
    createDisabledChip(doc, '日期筛选')
  );

  return filters;
}

function createSyntaxHint(doc: Document): HTMLElement {
  const hint = doc.createElement('div');
  hint.className = 'syntax';
  hint.textContent =
    '语法：空格表示“并且”，“完整短语”精确匹配，| 表示“或者”，-词 表示排除；还支持 title:、user:、assistant:、after:2026-01-01、before:2026-12-31。';
  return hint;
}

function createProgressStrip(doc: Document): HTMLElement {
  const strip = doc.createElement('div');
  strip.className = 'progress-strip';
  strip.dataset.progressStrip = 'true';

  const dot = doc.createElement('span');
  dot.className = 'progress-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = doc.createElement('span');
  text.dataset.progressText = 'true';
  text.textContent = '索引未启用';

  strip.append(dot, text);
  return strip;
}

function createResults(doc: Document): HTMLElement {
  const results = doc.createElement('div');
  results.className = 'results';
  results.dataset.results = 'true';
  return results;
}

function createFooter(doc: Document): HTMLElement {
  const footer = doc.createElement('div');
  footer.className = 'footer';

  const shortcut = doc.createElement('span');
  shortcut.textContent = 'Alt + Shift + F 打开   Esc 关闭';

  const status = doc.createElement('span');
  status.className = 'navigation-status';
  status.dataset.navigationStatus = 'true';
  status.hidden = true;

  const count = doc.createElement('span');
  count.dataset.footerCount = 'true';
  count.textContent = '显示前 0 / 0 条';

  footer.append(shortcut, status, count);
  return footer;
}

function createSelect(doc: Document, name: string, label: string, options: readonly (readonly [string, string])[]): HTMLElement {
  const wrapper = doc.createElement('label');
  wrapper.className = 'chip select-chip';
  wrapper.setAttribute('aria-label', label);

  const select = doc.createElement('select');
  select.dataset[name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = 'true';
  options.forEach(([value, text]) => {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  });

  wrapper.append(select);
  return wrapper;
}

function createCheckboxChip(doc: Document, label: string, checked: boolean, enabled: boolean): HTMLElement {
  const wrapper = doc.createElement('label');
  wrapper.className = enabled ? 'chip checkbox-chip' : 'chip checkbox-chip disabled';

  const checkbox = doc.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  checkbox.disabled = true;
  if (label === '精确搜索') checkbox.dataset.exactSearch = 'true';

  const text = doc.createElement('span');
  text.textContent = label;

  wrapper.append(checkbox, text);
  return wrapper;
}

function createDisabledChip(doc: Document, label: string): HTMLElement {
  const chip = doc.createElement('button');
  chip.className = 'chip';
  chip.type = 'button';
  chip.disabled = true;
  chip.textContent = label;
  return chip;
}

function createSearchIcon(doc: Document): SVGSVGElement {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');

  const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '11');
  circle.setAttribute('cy', '11');
  circle.setAttribute('r', '7');

  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm16.5 16.5 4 4');
  icon.append(circle, path);
  return icon;
}

function createPanelCss(): string {
  return `
    :host {
      all: initial;
      color-scheme: light dark;
      font-family: Arial, "Microsoft YaHei", sans-serif;
    }

    [data-panel-overlay] {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: grid;
      place-items: center;
      padding: 28px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, .42);
      backdrop-filter: blur(3px);
      font-family: Arial, "Microsoft YaHei", sans-serif;
    }

    [data-panel-overlay][hidden] {
      display: none;
    }

    .panel {
      width: min(92vw, 1120px);
      height: min(86vh, 820px);
      min-height: 520px;
      display: grid;
      grid-template-rows: auto auto auto auto auto minmax(0, 1fr) auto;
      overflow: hidden;
      border: 1px solid rgba(0, 0, 0, .16);
      border-radius: 20px;
      background: #fff;
      color: #202123;
      box-shadow: 0 24px 90px rgba(0, 0, 0, .34);
    }

    .topbar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 34px 28px 16px;
    }

    h2 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0;
    }

    .stats {
      margin-left: auto;
      color: #6f6f6f;
      font-size: 16px;
      line-height: 1.4;
      white-space: nowrap;
    }

    .icon-button {
      width: 34px;
      height: 34px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
    }

    .icon-button:hover {
      background: rgba(0, 0, 0, .06);
    }

    .more-button {
      color: #555;
      font-weight: 700;
    }

    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 0 28px 14px;
    }

    .search-box {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 62px;
      box-sizing: border-box;
      border: 1px solid #8fd0b8;
      border-radius: 16px;
      padding: 0 18px;
      box-shadow: 0 0 0 4px rgba(74, 168, 132, .16);
      background: #fff;
    }

    .search-box svg {
      width: 23px;
      height: 23px;
      color: #676767;
      flex: 0 0 auto;
    }

    input,
    select,
    button {
      font-family: inherit;
    }

    [data-search-input] {
      width: 100%;
      min-width: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: inherit;
      font-size: 24px;
      line-height: 1.25;
    }

    [data-search-input]::placeholder {
      color: #7b7b7b;
    }

    .secondary {
      min-height: 62px;
      border: 1px solid rgba(0, 0, 0, .14);
      border-radius: 14px;
      padding: 0 20px;
      background: transparent;
      color: #202123;
      font-size: 22px;
      cursor: default;
      white-space: nowrap;
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 0 28px 16px;
    }

    .chip {
      min-height: 44px;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      border: 1px solid rgba(0, 0, 0, .13);
      border-radius: 10px;
      padding: 0 14px;
      background: transparent;
      color: #202123;
      font-size: 20px;
      line-height: 1;
    }

    .select-chip {
      padding: 0;
      overflow: hidden;
    }

    .select-chip select {
      height: 42px;
      border: 0;
      padding: 0 38px 0 14px;
      background: transparent;
      color: inherit;
      font-size: 20px;
      outline: 0;
      cursor: pointer;
    }

    .checkbox-chip input {
      width: 18px;
      height: 18px;
      margin: 0;
      accent-color: #10a37f;
    }

    .checkbox-chip.disabled {
      color: #8a8a8a;
    }

    .syntax {
      padding: 0 28px 18px;
      color: #6f6f6f;
      font-size: 16px;
      line-height: 1.55;
    }

    .progress-strip {
      min-height: 38px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-top: 1px solid rgba(0, 0, 0, .1);
      border-bottom: 1px solid rgba(0, 0, 0, .1);
      padding: 0 28px;
      color: #6f6f6f;
      font-size: 16px;
    }

    .progress-strip[hidden] {
      display: none;
    }

    .progress-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #4aa884;
      flex: 0 0 auto;
    }

    .results {
      min-height: 0;
      overflow: auto;
      padding: 0;
      scrollbar-color: #8a8a8a transparent;
    }

    .state {
      height: 100%;
      min-height: 220px;
      display: grid;
      place-items: center;
      padding: 32px;
      box-sizing: border-box;
      color: #777;
      font-size: 18px;
      line-height: 1.6;
      text-align: center;
    }

    .state-loading::after {
      content: "";
      width: 20px;
      height: 20px;
      margin-left: 12px;
      border: 2px solid rgba(0, 0, 0, .14);
      border-top-color: #10a37f;
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }

    .result {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      border: 0;
      border-bottom: 1px solid rgba(0, 0, 0, .06);
      padding: 24px 30px;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .result:hover {
      background: rgba(0, 0, 0, .035);
    }

    .result-main {
      min-width: 0;
      display: grid;
      gap: 10px;
    }

    .result-heading {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .result-title {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 20px;
      line-height: 1.35;
      font-weight: 700;
    }

    .role-pill {
      border: 1px solid rgba(0, 0, 0, .12);
      border-radius: 999px;
      padding: 2px 8px;
      color: #6f6f6f;
      font-size: 14px;
      line-height: 1.3;
      white-space: nowrap;
      flex: 0 0 auto;
    }

    .snippet {
      max-width: 100%;
      color: #626262;
      font-size: 16px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    [data-highlight="true"] {
      border-radius: 4px;
      background: rgba(255, 214, 10, .42);
      color: inherit;
    }

    .result-meta {
      color: #6f6f6f;
      font-size: 16px;
      line-height: 1.4;
      white-space: nowrap;
    }

    .footer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 16px;
      align-items: center;
      border-top: 1px solid rgba(0, 0, 0, .1);
      padding: 14px 28px 18px;
      color: #6f6f6f;
      font-size: 16px;
    }

    .navigation-status {
      color: #4a7f68;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (prefers-color-scheme: dark) {
      .panel,
      .search-box {
        background: #202123;
        color: #f4f4f4;
      }

      .panel {
        border-color: rgba(255, 255, 255, .16);
      }

      .stats,
      .syntax,
      .progress-strip,
      .snippet,
      .result-meta,
      .footer,
      .role-pill,
      .state {
        color: #b6b6b6;
      }

      .secondary,
      .chip,
      .role-pill {
        border-color: rgba(255, 255, 255, .16);
        color: #f4f4f4;
      }

      .icon-button:hover,
      .result:hover {
        background: rgba(255, 255, 255, .07);
      }

      .progress-strip,
      .footer,
      .result {
        border-color: rgba(255, 255, 255, .12);
      }

      [data-highlight="true"] {
        background: rgba(255, 214, 10, .26);
      }
    }

    @media (max-width: 760px), (max-height: 640px) {
      [data-panel-overlay] {
        padding: 10px;
      }

      .panel {
        width: 100%;
        height: 94vh;
        min-height: 0;
        border-radius: 14px;
      }

      .topbar {
        padding: 18px 16px 12px;
      }

      h2 {
        font-size: 22px;
      }

      .stats {
        display: none;
      }

      .search-row {
        grid-template-columns: 1fr;
        padding: 0 16px 12px;
      }

      .search-box,
      .secondary {
        min-height: 52px;
      }

      [data-search-input] {
        font-size: 18px;
      }

      .filters,
      .syntax,
      .progress-strip {
        padding-left: 16px;
        padding-right: 16px;
      }

      .chip,
      .select-chip select {
        font-size: 16px;
      }

      .result {
        grid-template-columns: minmax(0, 1fr);
        padding: 18px 16px;
      }

      .result-meta {
        font-size: 14px;
      }

      .footer {
        grid-template-columns: 1fr;
        padding: 12px 16px;
      }
    }
  `;
}

function roleLabel(role: SearchResult['role']): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  return '对话';
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function mustFind<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Deep search panel missing element: ${selector}`);
  return element;
}
