import type { SearchPanelStateSnapshot, SearchResult } from '../shared/types';

export type PanelMode = 'initial' | 'loading' | 'empty' | 'error' | 'progress' | 'results';

export interface SearchPanelModel {
  readonly mode: PanelMode;
  readonly queryText: string;
  readonly results: readonly SearchResult[];
  readonly total: number;
  readonly state: SearchPanelStateSnapshot | null;
  readonly error: string | null;
  readonly navigationStatus: string | null;
}

export interface SearchPanelViewState {
  readonly mode: PanelMode;
  readonly headerStats: string;
  readonly progressLabel: string;
  readonly emptyMessage: string;
  readonly footerCount: string;
  readonly showResults: boolean;
  readonly showProgress: boolean;
  readonly errorMessage: string | null;
  readonly navigationStatus: string | null;
}

export function createInitialPanelModel(): SearchPanelModel {
  return {
    mode: 'initial',
    queryText: '',
    results: [],
    total: 0,
    state: null,
    error: null,
    navigationStatus: null
  };
}

export function derivePanelViewState(model: SearchPanelModel): SearchPanelViewState {
  const state = model.state;
  const conversationCount = state?.conversationCount ?? 0;
  const messageCount = state?.messageCount ?? 0;
  const derivedMode = deriveMode(model);

  return {
    mode: derivedMode,
    headerStats: `${conversationCount} 个对话 · ${messageCount} 条消息`,
    progressLabel: createProgressLabel(state),
    emptyMessage: createEmptyMessage(derivedMode, model.queryText, state),
    footerCount: `显示前 ${model.results.length} / ${model.total} 条`,
    showResults: derivedMode === 'results',
    showProgress: state?.status === 'indexing',
    errorMessage: derivedMode === 'error' ? model.error ?? createIndexErrorMessage(state) : null,
    navigationStatus: model.navigationStatus
  };
}

function deriveMode(model: SearchPanelModel): PanelMode {
  if (model.mode === 'loading') return 'loading';
  if (model.mode === 'error') return 'error';
  if (model.results.length > 0) return 'results';
  if (model.state?.status === 'error') return 'error';
  if (model.state?.status === 'indexing') return 'progress';
  if (model.queryText.trim()) return 'empty';
  return model.mode;
}

function createProgressLabel(state: SearchPanelStateSnapshot | null): string {
  if (!state) return '正在读取索引状态';
  if (state.status === 'indexing') {
    const progress = state.progress;
    if (progress && progress.totalCount > 0) {
      return `正在索引 ${progress.processedCount} / ${progress.totalCount} 个对话`;
    }
    return '正在准备索引任务';
  }
  if (state.status === 'initializing') return '正在初始化本地索引';
  if (state.status === 'error') return createIndexErrorMessage(state);
  if (state.status === 'completed') {
    return state.lastSuccessAt ? `索引完成 · ${formatTimestamp(state.lastSuccessAt)}` : '索引完成';
  }
  if (state.messageCount > 0) return '最近对话';
  return '索引未启用';
}

function createEmptyMessage(mode: PanelMode, queryText: string, state: SearchPanelStateSnapshot | null): string {
  if (mode === 'loading') return '正在搜索本地索引...';
  if (mode === 'progress') return '索引进行中，可以搜索已经保存到本地的对话。';
  if (queryText.trim()) return '没有找到匹配结果。';
  if (state?.status === 'initializing') return '正在连接 ChatGPT 会话并准备索引最近对话。';
  if (state?.messageCount) return '输入关键词开始搜索标题、用户消息和助手回复。';
  return '暂无本地索引。完成索引后即可搜索历史对话。';
}

function createIndexErrorMessage(state: SearchPanelStateSnapshot | null): string {
  const diagnostic = state?.lastError;
  if (diagnostic?.httpStatus === 404 && diagnostic.backendErrorCode === 'conversation_inaccessible') {
    return '无法访问该对话，当前 ChatGPT 会话认证无效或该对话已不可用。';
  }
  if (diagnostic?.httpStatus) {
    const backendCode = diagnostic.backendErrorCode ? `（${diagnostic.backendErrorCode}）` : '';
    return `索引失败：ChatGPT API 返回 HTTP ${diagnostic.httpStatus}${backendCode}。`;
  }
  return '索引失败，请查看诊断信息后重试。';
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(
    2,
    '0'
  )} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
