export const NATIVE_SEARCH_LABELS = ['搜索聊天', 'Search chats', 'Search chat'] as const;
export const DEEP_SEARCH_LABEL = '深度搜索';
export const DEEP_SEARCH_ROW_ATTRIBUTE = 'data-chatgpt-deep-search-row';
export const DEEP_SEARCH_ROW_SELECTOR = `[${DEEP_SEARCH_ROW_ATTRIBUTE}="true"]`;
const DEEP_SEARCH_RENDER_VERSION = 'shadow-sidebar-v2-native-search-metrics';
const LEGACY_VISUAL_ROW_SELECTOR = '[data-chatgpt-deep-search-visual-row="true"]';
const LEGACY_SIDEBAR_STYLE_ID = 'chatgpt-deep-search-sidebar-style';
const HOST_MODE = 'shadow-sidebar';
const OTHER_NATIVE_SIDEBAR_LABELS = [
  '新聊天',
  'New chat',
  '文件库',
  'Library',
  '项目',
  'Projects',
  '已安排',
  'Scheduled',
  '应用',
  'Apps',
  '更多',
  'More',
  '已置顶',
  'Pinned',
  '最近',
  'Recents'
] as const;

const CANDIDATE_SELECTOR = [
  '[data-testid="native-search-chat"]',
  'a',
  'button',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[aria-label]',
  '[title]',
  '[tabindex]'
].join(',');

const STRUCTURAL_ROOT_SELECTOR = 'aside, nav, [role="navigation"]';

export interface SidebarLocation {
  readonly searchRow: HTMLElement;
  readonly strategy: string;
  readonly score: number;
  readonly matchedLabel: string;
  readonly candidateCount: number;
}

export interface SidebarLocatorDiagnostics {
  readonly found: boolean;
  readonly strategy: string | null;
  readonly candidateCount: number;
  readonly bestScore: number;
  readonly matchedLabel: string | null;
  readonly searchRowTag: string | null;
}

export interface SidebarInjectionDiagnostics {
  readonly started: boolean;
  readonly located: boolean;
  readonly inserted: boolean;
  readonly rowVisible: boolean;
  readonly visualFallbackActive: boolean;
  readonly visualFallbackVisible: boolean;
  readonly hostMode: 'shadow-sidebar' | null;
  readonly anchorText: string | null;
  readonly anchorTag: string | null;
  readonly rowRect: SidebarRowRect | null;
  readonly lastReason: string;
  readonly strategy: string | null;
  readonly candidateCount: number;
  readonly rowCount: number;
  readonly retryAttempts: number;
  readonly lastError: string | null;
  readonly searchRowTag: string | null;
  readonly rowParentTag: string | null;
  readonly rowPreviousSiblingTag: string | null;
}

export interface SidebarRowRect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
}

interface TextMatch {
  readonly label: string;
  readonly score: number;
}

interface Candidate {
  readonly row: HTMLElement;
  readonly strategy: string;
  readonly match: TextMatch;
  readonly score: number;
}

export interface SidebarInjectorOptions {
  readonly document?: Document;
  readonly locator?: SidebarLocator;
  readonly onOpenPanel: () => void;
  readonly onDiagnosticsChange?: (diagnostics: SidebarInjectionDiagnostics) => void;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxRetryAttempts?: number;
}

export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class SidebarLocator {
  private lastDiagnostics: SidebarLocatorDiagnostics = {
    found: false,
    strategy: null,
    candidateCount: 0,
    bestScore: 0,
    matchedLabel: null,
    searchRowTag: null
  };

  public constructor(
    private readonly root: ParentNode = document,
    private readonly labels: readonly string[] = NATIVE_SEARCH_LABELS
  ) {}

  public locate(): SidebarLocation | null {
    const candidates = this.collectCandidates();
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0] ?? null;

    this.lastDiagnostics = {
      found: best !== null,
      strategy: best?.strategy ?? null,
      candidateCount: candidates.length,
      bestScore: best?.score ?? 0,
      matchedLabel: best?.match.label ?? null,
      searchRowTag: best?.row.tagName.toLowerCase() ?? null
    };

    if (!best) return null;
    return {
      searchRow: best.row,
      strategy: best.strategy,
      score: best.score,
      matchedLabel: best.match.label,
      candidateCount: candidates.length
    };
  }

  public getDiagnostics(): SidebarLocatorDiagnostics {
    return this.lastDiagnostics;
  }

  private collectCandidates(): Candidate[] {
    const byRow = new Map<HTMLElement, Candidate>();

    this.collectElementCandidates(byRow);
    this.collectStructuredTextCandidates(byRow);
    this.collectTextNodeCandidates(byRow);

    return Array.from(byRow.values());
  }

  private collectElementCandidates(byRow: Map<HTMLElement, Candidate>): void {
    if (!hasQuerySelectorAll(this.root)) return;

    this.root.querySelectorAll(CANDIDATE_SELECTOR).forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      this.maybeAddCandidate(element, 'element', byRow);
    });
  }

  private collectTextNodeCandidates(byRow: Map<HTMLElement, Candidate>): void {
    const ownerDocument = getOwnerDocument(this.root);
    const walkerRoot = this.root instanceof Document ? this.root.body ?? this.root.documentElement : this.root;
    if (!walkerRoot) return;

    const walker = ownerDocument.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
    let visited = 0;
    while (visited < 500) {
      const current = walker.nextNode();
      if (!current) break;
      visited += 1;

      const text = normalizeVisibleText(current.textContent ?? '');
      if (!text) continue;

      const match = this.matchLabel(text);
      if (!match) continue;

      const parent: HTMLElement | null = current.parentElement;
      if (!parent) continue;

      const row = this.promoteToSidebarRow(parent, match.label);
      if (!row || !this.isVisible(row)) continue;

      this.addCandidate(byRow, {
        row,
        strategy: 'text-node',
        match,
        score: this.scoreRow(row, match, 'text-node')
      });
    }
  }

  private collectStructuredTextCandidates(byRow: Map<HTMLElement, Candidate>): void {
    if (!hasQuerySelectorAll(this.root)) return;

    const structuralRoots = Array.from(this.root.querySelectorAll(STRUCTURAL_ROOT_SELECTOR)).filter(
      (element): element is HTMLElement => element instanceof HTMLElement
    );

    let visited = 0;
    for (const root of structuralRoots) {
      if (visited >= 1_500) break;

      const elements = [root, ...Array.from(root.querySelectorAll('*'))];
      for (const element of elements) {
        if (visited >= 1_500) break;
        visited += 1;
        if (!(element instanceof HTMLElement)) continue;
        if (!this.isVisible(element)) continue;
        if (element.matches(DEEP_SEARCH_ROW_SELECTOR)) continue;

        const match = this.bestStructuralTextMatch(element);
        if (!match) continue;

        const row = this.promoteToSidebarRow(element, match.label);
        if (!row || !this.isVisible(row)) continue;

        this.addCandidate(byRow, {
          row,
          strategy: 'structure',
          match,
          score: this.scoreRow(row, match, 'structure')
        });
      }
    }
  }

  private maybeAddCandidate(element: HTMLElement, strategy: string, byRow: Map<HTMLElement, Candidate>): void {
    if (!this.isVisible(element)) return;

    const match = this.bestElementMatch(element);
    if (!match) return;

    const row = this.promoteToSidebarRow(element, match.label);
    if (!row || !this.isVisible(row)) return;

    this.addCandidate(byRow, {
      row,
      strategy,
      match,
      score: this.scoreRow(row, match, strategy)
    });
  }

  private addCandidate(byRow: Map<HTMLElement, Candidate>, candidate: Candidate): void {
    const existing = byRow.get(candidate.row);
    if (!existing || candidate.score > existing.score) {
      byRow.set(candidate.row, candidate);
    }
  }

  private bestElementMatch(element: HTMLElement): TextMatch | null {
    const values = [
      { value: element.getAttribute('aria-label') ?? '', bonus: 18 },
      { value: element.getAttribute('title') ?? '', bonus: 14 },
      { value: element.getAttribute('data-testid') === 'native-search-chat' ? '搜索聊天' : '', bonus: 28 },
      { value: elementText(element), bonus: 0 }
    ];

    let best: TextMatch | null = null;
    for (const { value, bonus } of values) {
      const match = this.matchLabel(value);
      if (!match) continue;
      const boosted = { label: match.label, score: match.score + bonus };
      if (!best || boosted.score > best.score) best = boosted;
    }

    return best;
  }

  private bestStructuralTextMatch(element: HTMLElement): TextMatch | null {
    const values = [
      { value: element.getAttribute('aria-label') ?? '', bonus: 14 },
      { value: element.getAttribute('title') ?? '', bonus: 10 },
      { value: elementText(element), bonus: 0 }
    ];

    let best: TextMatch | null = null;
    for (const { value, bonus } of values) {
      const match = this.matchLabel(value);
      if (!match) continue;
      const boosted = { label: match.label, score: match.score + bonus };
      if (!best || boosted.score > best.score) best = boosted;
    }

    return best;
  }

  private matchLabel(value: string): TextMatch | null {
    const normalized = normalizeVisibleText(value);
    if (!normalized) return null;

    for (const label of this.labels) {
      const target = normalizeVisibleText(label);
      if (normalized === target) return { label: target, score: 100 };
    }

    const compactNormalized = compactLabelText(normalized);
    for (const label of this.labels) {
      const target = normalizeVisibleText(label);
      if (compactNormalized === compactLabelText(target)) return { label: target, score: 96 };
    }

    for (const label of this.labels) {
      const target = normalizeVisibleText(label);
      if (normalized.includes(target) && normalized.length <= target.length + 24) {
        if (containsOtherNativeSidebarLabel(normalized, target)) continue;
        return { label: target, score: 70 };
      }
    }

    for (const label of this.labels) {
      const target = normalizeVisibleText(label);
      const compactTarget = compactLabelText(target);
      if (compactNormalized.includes(compactTarget) && compactNormalized.length <= compactTarget.length + 24) {
        if (containsOtherNativeSidebarLabel(normalized, target)) continue;
        return { label: target, score: 66 };
      }
    }

    return null;
  }

  private promoteToSidebarRow(element: HTMLElement, matchedLabel: string): HTMLElement | null {
    const interactive = closestWithin(element, isInteractiveRow, 6);
    if (interactive) {
      const boundary = this.promoteWithinSidebarStructure(interactive, matchedLabel);
      return boundary ?? interactive;
    }

    const structural = this.promoteWithinSidebarStructure(element, matchedLabel);
    if (structural) return structural;

    return closestWithin(
      element,
      (candidate) => {
        if (candidate.matches('html, body, main, aside, nav')) return false;
        const text = normalizeVisibleText(candidate.textContent ?? '');
        return text.includes(matchedLabel) && text.length <= matchedLabel.length + 48;
      },
      6
    );
  }

  private promoteWithinSidebarStructure(element: HTMLElement, matchedLabel: string): HTMLElement | null {
    let current: HTMLElement | null = element;
    let best: HTMLElement | null = null;
    let depth = 0;

    while (current && depth <= 8) {
      if (current.matches('html, body, main')) break;

      if (!current.matches('aside, nav, [role="navigation"]')) {
        const text = normalizeVisibleText(current.textContent ?? '');
        if (this.isTightLabelMatch(text, matchedLabel)) {
          best = current;
        }
      }

      const parent: HTMLElement | null = current.parentElement;
      if (!parent || parent.matches('aside, nav, [role="navigation"]')) break;

      current = parent;
      depth += 1;
    }

    return best;
  }

  private scoreRow(row: HTMLElement, match: TextMatch, strategy: string): number {
    let score = match.score;
    if (strategy === 'element') score += 6;
    if (strategy === 'structure') score += 2;
    if (row.getAttribute('data-testid') === 'native-search-chat') score += 20;
    if (isInteractiveRow(row)) score += 24;
    if (row.closest('nav')) score += 18;
    if (row.closest('aside')) score += 18;
    if (row.closest('[role="navigation"]')) score += 12;
    if (row.matches('html, body, main')) score -= 100;
    if (normalizeVisibleText(row.textContent ?? '').includes(DEEP_SEARCH_LABEL)) score -= 100;

    const index = siblingIndex(row);
    if (index >= 0 && index <= 8) score += 8;

    return score;
  }

  private isTightLabelMatch(text: string, label: string): boolean {
    const normalized = normalizeVisibleText(text);
    const target = normalizeVisibleText(label);
    return (
      normalized === target ||
      (normalized.includes(target) &&
        normalized.length <= target.length + 16 &&
        !containsOtherNativeSidebarLabel(normalized, target))
    );
  }

  private isVisible(element: HTMLElement): boolean {
    if (!element.isConnected) return false;

    let current: HTMLElement | null = element;
    while (current) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;

      const view = current.ownerDocument.defaultView;
      if (view) {
        const style = view.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      }

      current = current.parentElement;
    }

    if (!isLayoutlessDocument(element.ownerDocument)) {
      const rect = element.getBoundingClientRect();
      const view = element.ownerDocument.defaultView;
      const viewportWidth = view?.innerWidth ?? 0;
      const viewportHeight = view?.innerHeight ?? 0;
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.right <= 0 || rect.bottom <= 0) return false;
      if (viewportWidth > 0 && rect.left >= viewportWidth) return false;
      if (viewportHeight > 0 && rect.top >= viewportHeight) return false;
    }

    return true;
  }
}

export class SidebarInjector {
  private readonly document: Document;
  private readonly locator: SidebarLocator;
  private readonly onOpenPanel: () => void;
  private readonly onDiagnosticsChange: ((diagnostics: SidebarInjectionDiagnostics) => void) | undefined;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxRetryAttempts: number;
  private readonly boundRows = new WeakSet<HTMLElement>();
  private observer: MutationObserver | null = null;
  private retryTimer: number | null = null;
  private retryAttempts = 0;
  private started = false;
  private diagnostics: SidebarInjectionDiagnostics = {
    started: false,
    located: false,
    inserted: false,
    rowVisible: false,
    visualFallbackActive: false,
    visualFallbackVisible: false,
    hostMode: null,
    anchorText: null,
    anchorTag: null,
    rowRect: null,
    lastReason: 'not-started',
    strategy: null,
    candidateCount: 0,
    rowCount: 0,
    retryAttempts: 0,
    lastError: null,
    searchRowTag: null,
    rowParentTag: null,
    rowPreviousSiblingTag: null
  };

  public constructor(options: SidebarInjectorOptions) {
    this.document = options.document ?? document;
    this.locator = options.locator ?? new SidebarLocator(this.document);
    this.onOpenPanel = options.onOpenPanel;
    this.onDiagnosticsChange = options.onDiagnosticsChange;
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.retryMaxMs = options.retryMaxMs ?? 2_000;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 24;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.cleanupLegacyArtifacts();
    this.ensureInjected('start');

    const target = this.document.documentElement;
    this.observer = new MutationObserver(() => {
      this.scheduleRetry('mutation');
    });
    this.observer.observe(target, {
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
      childList: true,
      subtree: true
    });
  }

  public stop(): void {
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.retryTimer !== null) {
      this.document.defaultView?.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  public ensureInjected(reason = 'manual'): boolean {
    try {
      const location = this.locator.locate();
      if (!location) {
        this.updateDiagnostics({
          located: false,
          inserted: false,
          rowVisible: false,
          visualFallbackActive: false,
          visualFallbackVisible: false,
          hostMode: null,
          anchorText: null,
          anchorTag: null,
          rowRect: null,
          lastReason: reason,
          rowCount: this.findInjectedRows().length,
          lastError: null
        });
        this.scheduleRetry(reason);
        return false;
      }

      const row = this.getOrCreateRow(location.searchRow);
      this.bindRow(row);

      if (row.previousElementSibling !== location.searchRow) {
        location.searchRow.insertAdjacentElement('afterend', row);
      }

      this.removeDuplicateRows(row);
      this.cleanupLegacyArtifacts();
      const rowVisible = this.isInjectedRowVisible(row);
      const rowRect = getElementRect(row);

      this.updateDiagnostics({
        located: true,
        inserted: row.previousElementSibling === location.searchRow,
        rowVisible,
        visualFallbackActive: false,
        visualFallbackVisible: false,
        hostMode: HOST_MODE,
        anchorText: normalizeVisibleText(location.searchRow.textContent ?? ''),
        anchorTag: location.searchRow.tagName.toLowerCase(),
        rowRect,
        lastReason: reason,
        strategy: location.strategy,
        candidateCount: location.candidateCount,
        rowCount: this.findInjectedRows().length,
        lastError: null,
        searchRowTag: location.searchRow.tagName.toLowerCase(),
        rowParentTag: row.parentElement?.tagName.toLowerCase() ?? null,
        rowPreviousSiblingTag: row.previousElementSibling?.tagName.toLowerCase() ?? null
      });

      if (!rowVisible) {
        this.scheduleRetry(`${reason}:invisible-row`);
        return false;
      }

      this.retryAttempts = 0;
      return true;
    } catch (error) {
      this.updateDiagnostics({
        located: false,
        inserted: false,
        rowVisible: false,
        visualFallbackActive: false,
        visualFallbackVisible: false,
        hostMode: null,
        anchorText: null,
        anchorTag: null,
        rowRect: null,
        lastReason: reason,
        rowCount: this.findInjectedRows().length,
        lastError: error instanceof Error ? error.message : String(error)
      });
      this.scheduleRetry(reason);
      return false;
    }
  }

  public getDiagnostics(): SidebarInjectionDiagnostics {
    return this.diagnostics;
  }

  private getOrCreateRow(nativeSearchRow: HTMLElement): HTMLElement {
    const rows = this.findInjectedRows();
    const directRow = rows.find((row) => row.previousElementSibling === nativeSearchRow);
    const reusableRow = directRow ?? rows.find((row) => row.dataset.chatgptDeepSearchRender === DEEP_SEARCH_RENDER_VERSION);
    if (reusableRow?.dataset.chatgptDeepSearchRender === DEEP_SEARCH_RENDER_VERSION) {
      this.forceHostGeometry(reusableRow);
      this.ensureShadowTrigger(reusableRow, nativeSearchRow);
      return reusableRow;
    }

    rows.forEach((row) => row.remove());
    return this.createRow(nativeSearchRow);
  }

  private createRow(_nativeSearchRow: HTMLElement): HTMLElement {
    const host = this.document.createElement('div');
    host.setAttribute(DEEP_SEARCH_ROW_ATTRIBUTE, 'true');
    host.dataset.chatgptDeepSearchRender = DEEP_SEARCH_RENDER_VERSION;
    host.dataset.chatgptDeepSearchHostMode = HOST_MODE;
    host.setAttribute('aria-label', DEEP_SEARCH_LABEL);
    host.setAttribute('title', DEEP_SEARCH_LABEL);
    host.className = 'cgds-sidebar-host';
    this.forceHostGeometry(host);
    this.ensureShadowTrigger(host, _nativeSearchRow);
    return host;
  }

  private forceHostGeometry(host: HTMLElement): void {
    const styles: Array<readonly [string, string]> = [
      ['display', 'block'],
      ['width', '100%'],
      ['box-sizing', 'border-box'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['position', 'static'],
      ['transform', 'none'],
      ['overflow', 'visible'],
      ['color', 'inherit'],
      ['pointer-events', 'auto']
    ];

    styles.forEach(([name, value]) => {
      host.style.setProperty(name, value, 'important');
    });
  }

  private ensureShadowTrigger(host: HTMLElement, nativeSearchRow: HTMLElement): void {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const existingTrigger = shadow.querySelector('[data-deep-search-trigger="true"]');
    if (existingTrigger && host.dataset.chatgptDeepSearchRender === DEEP_SEARCH_RENDER_VERSION) return;

    shadow.replaceChildren(this.createShadowStyle(), this.createShadowButton(nativeSearchRow));
  }

  private createShadowStyle(): HTMLStyleElement {
    const style = this.document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        display: block;
        width: 100%;
        color: inherit;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      button {
        border: 0;
        color: inherit;
        cursor: pointer;
        font: inherit;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        box-sizing: border-box;
        transition: background-color .14s ease;
      }

      .sidebar-button {
        width: 100%;
        min-height: 40px;
        height: 40px;
        margin: 0;
        padding: 0 10px 0 16px;
        border-radius: 10px;
        background: transparent;
        text-align: left;
      }

      .sidebar-button:hover {
        background: rgba(128, 128, 128, .13);
      }

      .sidebar-button:focus-visible {
        outline: 2px solid rgba(16, 163, 127, .7);
        outline-offset: -2px;
      }

      .cgds-sidebar-content {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
      }

      .cgds-sidebar-icon {
        position: relative;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 20px;
        opacity: var(--menu-item-icon-opacity, 1);
      }

      .cgds-sidebar-icon svg {
        width: 20px;
        height: 20px;
        display: block;
      }

      .cgds-sidebar-label-wrap {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        align-items: center;
        gap: 10px;
      }

      .cgds-sidebar-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 14px;
        line-height: 20px;
        font-weight: 400;
      }
    `;
    return style;
  }

  private createShadowButton(nativeSearchRow: HTMLElement): HTMLButtonElement {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-button';
    button.tabIndex = 0;
    button.dataset.deepSearchTrigger = 'true';
    button.dataset.fill = '';
    button.dataset.sidebarItem = 'true';
    button.dataset.revealed = '';
    button.title = DEEP_SEARCH_LABEL;
    button.setAttribute('aria-label', DEEP_SEARCH_LABEL);

    const content = this.document.createElement('div');
    content.className = 'cgds-sidebar-content';

    const labelWrap = this.document.createElement('div');
    labelWrap.className = 'cgds-sidebar-label-wrap';
    labelWrap.append(this.createLabel());

    content.append(this.createIcon(nativeSearchRow), labelWrap);
    button.append(content);
    return button;
  }

  private createLabel(): HTMLElement {
    const label = this.document.createElement('div');
    label.className = 'cgds-sidebar-label';
    label.textContent = DEEP_SEARCH_LABEL;
    return label;
  }

  private createIcon(nativeSearchRow: HTMLElement): HTMLElement {
    const wrapper = this.document.createElement('div');
    wrapper.className = 'cgds-sidebar-icon';
    wrapper.setAttribute('aria-hidden', 'true');

    const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');

    const nativeIconHref = nativeSearchRow.querySelector('svg use')?.getAttribute('href');
    if (nativeIconHref) {
      const use = this.document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', nativeIconHref);
      use.setAttribute('fill', 'currentColor');
      svg.append(use);
    } else {
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');

      const circle = this.document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '11');
      circle.setAttribute('cy', '11');
      circle.setAttribute('r', '7');

      const line = this.document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', 'm20 20-3.8-3.8');

      svg.append(circle, line);
    }
    wrapper.append(svg);
    return wrapper;
  }

  private bindRow(row: HTMLElement): void {
    if (this.boundRows.has(row)) return;
    this.boundRows.add(row);
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOpenPanel();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      event.preventDefault();
      event.stopPropagation();
      this.onOpenPanel();
    });
  }

  private removeDuplicateRows(keep: HTMLElement): void {
    this.findInjectedRows().forEach((row) => {
      if (row !== keep) row.remove();
    });
  }

  private cleanupLegacyArtifacts(): void {
    this.document.querySelectorAll(LEGACY_VISUAL_ROW_SELECTOR).forEach((element) => {
      element.remove();
    });
    this.document.getElementById(LEGACY_SIDEBAR_STYLE_ID)?.remove();
  }

  private findInjectedRows(): HTMLElement[] {
    return Array.from(this.document.querySelectorAll(DEEP_SEARCH_ROW_SELECTOR)).filter(
      (element): element is HTMLElement => element instanceof HTMLElement
    );
  }

  private scheduleRetry(reason: string): void {
    if (!this.started) return;
    if (this.retryTimer !== null) return;
    if (this.retryAttempts >= this.maxRetryAttempts) {
      this.updateDiagnostics({
        lastReason: `${reason}:retry-limit`,
        retryAttempts: this.retryAttempts
      });
      return;
    }

    const delay = Math.min(this.retryMaxMs, Math.round(this.retryBaseMs * 1.6 ** this.retryAttempts));
    this.retryAttempts += 1;
    this.updateDiagnostics({ retryAttempts: this.retryAttempts });
    this.retryTimer = this.document.defaultView?.setTimeout(() => {
      this.retryTimer = null;
      this.ensureInjected(reason);
    }, delay) ?? null;
  }

  private isInjectedRowVisible(row: HTMLElement): boolean {
    if (!row.isConnected || row.hidden || row.getAttribute('aria-hidden') === 'true') return false;

    const view = row.ownerDocument.defaultView;
    if (view) {
      let current: HTMLElement | null = row;
      while (current) {
        const style = view.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        current = current.parentElement;
      }
    }

    const rect = row.getBoundingClientRect();
    if (this.isLayoutlessTestEnvironment(row)) return true;
    return rect.width > 0 && rect.height > 0;
  }

  private isLayoutlessTestEnvironment(row: HTMLElement): boolean {
    return isLayoutlessDocument(row.ownerDocument);
  }

  private updateDiagnostics(update: Partial<SidebarInjectionDiagnostics>): void {
    this.diagnostics = {
      ...this.diagnostics,
      ...update,
      started: this.started
    };
    this.onDiagnosticsChange?.(this.diagnostics);
  }
}

function hasQuerySelectorAll(root: ParentNode): root is ParentNode & Pick<Document, 'querySelectorAll'> {
  return typeof root.querySelectorAll === 'function';
}

function getOwnerDocument(root: ParentNode): Document {
  if (root instanceof Document) return root;
  return (root as Node).ownerDocument ?? document;
}

function elementText(element: HTMLElement): string {
  const innerText = 'innerText' in element ? element.innerText : '';
  return normalizeVisibleText(innerText || element.textContent || '');
}

function getElementRect(element: HTMLElement): SidebarRowRect {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    top: Math.round(rect.top),
    left: Math.round(rect.left)
  };
}

function isLayoutlessDocument(doc: Document): boolean {
  return doc.defaultView?.navigator.userAgent.toLowerCase().includes('jsdom') === true;
}

function compactLabelText(value: string): string {
  return value.replace(/\s+/g, '');
}

function containsOtherNativeSidebarLabel(value: string, matchedLabel: string): boolean {
  const compactValue = compactLabelText(value).toLowerCase();
  const compactMatchedLabel = compactLabelText(matchedLabel).toLowerCase();

  return OTHER_NATIVE_SIDEBAR_LABELS.some((label) => {
    const compactLabel = compactLabelText(label).toLowerCase();
    return compactLabel !== compactMatchedLabel && compactValue.includes(compactLabel);
  });
}

function closestWithin(
  start: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
  maxDepth: number
): HTMLElement | null {
  let current: HTMLElement | null = start;
  let depth = 0;
  while (current && depth <= maxDepth) {
    if (predicate(current)) return current;
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function isInteractiveRow(element: HTMLElement): boolean {
  if (element.matches('a, button')) return true;
  const role = element.getAttribute('role');
  if (role === 'button' || role === 'link' || role === 'menuitem') return true;
  return element.hasAttribute('tabindex');
}

function siblingIndex(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return -1;
  return Array.from(parent.children).indexOf(element);
}
