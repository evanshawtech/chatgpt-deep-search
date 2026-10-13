import { createDeepSearchPanel, type DeepSearchPanel } from './panel';
import { SidebarInjector, type SidebarInjectionDiagnostics } from './sidebar-locator';
import { afterStartupQuietWindow } from './startup-readiness';
import { installCurrentChatObserver, type CurrentChatObserver } from './current-chat-observer';
import { installChatGPTApiBridge } from './chatgpt-api-bridge';

const BOOT_KEY = '__chatgptDeepSearchPhase1App';
const DIAGNOSTICS_KEY = '__chatgptDeepSearchDiagnostics';
const BOOT_ATTRIBUTE = 'data-chatgpt-deep-search-boot';
const DIAGNOSTICS_ATTRIBUTE = 'data-chatgpt-deep-search-diagnostics';
const LOG_PREFIX = '[ChatGPT Deep Search]';

interface DeepSearchContentApp {
  readonly sidebar: SidebarInjector;
  readonly getDiagnostics: () => PhaseOneDiagnostics;
  readonly openPanel: () => void;
}

interface PhaseOneDiagnostics {
  readonly version: 'phase-1-sidebar';
  readonly url: string;
  readonly panelOpen: boolean;
  readonly sidebar: SidebarInjectionDiagnostics;
}

declare global {
  interface Window {
    [BOOT_KEY]?: DeepSearchContentApp;
    [DIAGNOSTICS_KEY]?: () => PhaseOneDiagnostics;
  }
}

function boot(): void {
  const existing = window[BOOT_KEY];
  if (existing) {
    if (document.documentElement.getAttribute(BOOT_ATTRIBUTE) === 'phase-1-sidebar') {
      existing.sidebar.ensureInjected('repeat-bootstrap');
    }
    return;
  }

  let panel: DeepSearchPanel | null = null;
  let latestSidebarDiagnostics: SidebarInjectionDiagnostics | null = null;
  let domPublishingEnabled = false;
  let pendingPanelOpen = false;
  let currentChatObserver: CurrentChatObserver | null = null;

  const getPanel = (): DeepSearchPanel => {
    panel ??= createDeepSearchPanel(document);
    return panel;
  };

  const openPanel = (): void => {
    if (!domPublishingEnabled) {
      pendingPanelOpen = true;
      return;
    }

    getPanel().open();
    publishDiagnostics();
  };

  const publishDiagnostics = (sidebarDiagnostics = latestSidebarDiagnostics): void => {
    if (!sidebarDiagnostics) return;
    latestSidebarDiagnostics = sidebarDiagnostics;
    const diagnostics: PhaseOneDiagnostics = {
      version: 'phase-1-sidebar',
      url: location.href,
      panelOpen: panel?.isOpen() ?? pendingPanelOpen,
      sidebar: sidebarDiagnostics
    };
    if (!domPublishingEnabled) return;
    document.documentElement.setAttribute(BOOT_ATTRIBUTE, diagnostics.version);
    document.documentElement.setAttribute(DIAGNOSTICS_ATTRIBUTE, JSON.stringify(diagnostics));
  };

  const sidebar = new SidebarInjector({
    document,
    onOpenPanel: openPanel,
    onDiagnosticsChange: publishDiagnostics
  });

  const app: DeepSearchContentApp = {
    sidebar,
    openPanel,
    getDiagnostics: () => ({
      version: 'phase-1-sidebar',
      url: location.href,
      panelOpen: panel?.isOpen() ?? pendingPanelOpen,
      sidebar: sidebar.getDiagnostics()
    })
  };

  window[BOOT_KEY] = app;
  window[DIAGNOSTICS_KEY] = app.getDiagnostics;

  installKeyboardFallback(openPanel);
  installRuntimeFallback(openPanel);
  installChatGPTApiBridge(window);

  void afterStartupQuietWindow({ document }).then(() => {
    domPublishingEnabled = true;
    document.documentElement.setAttribute(BOOT_ATTRIBUTE, 'phase-1-sidebar');
    sidebar.start();
    currentChatObserver ??= installCurrentChatObserver({ document });
    publishDiagnostics();
    if (pendingPanelOpen) {
      pendingPanelOpen = false;
      getPanel().open();
      publishDiagnostics();
    }
  });

  console.info(`${LOG_PREFIX} phase 1 content script injected`);
}

function installKeyboardFallback(openPanel: () => void): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openPanel();
      }
    },
    true
  );
}

function installRuntimeFallback(openPanel: () => void): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isOpenPanelMessage(message)) {
      openPanel();
    }
  });
}

function isOpenPanelMessage(message: unknown): message is { type: 'DEEP_SEARCH_OPEN_PANEL' } {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'DEEP_SEARCH_OPEN_PANEL';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
