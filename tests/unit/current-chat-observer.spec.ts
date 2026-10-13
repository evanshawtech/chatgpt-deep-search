import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCurrentChatObserver } from '../../src/content/current-chat-observer';
import type {
  DeepSearchContentReadyMessage,
  DeepSearchCurrentConversationChangedMessage,
  DeepSearchCurrentConversationSeenMessage
} from '../../src/shared/types';

type CurrentChatMessage =
  | DeepSearchContentReadyMessage
  | DeepSearchCurrentConversationSeenMessage
  | DeepSearchCurrentConversationChangedMessage;

describe('current chat observer', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/c/conversation-current');
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('reports ChatGPT mutations even when the same batch contains extension DOM changes', async () => {
    const messages: CurrentChatMessage[] = [];
    const observer = installCurrentChatObserver({
      document,
      debounceMs: 1,
      sendMessage: (message) => {
        messages.push(message);
      }
    });

    const extensionHost = document.createElement('div');
    extensionHost.id = 'chatgpt-deep-search-panel-host';
    const chatMessage = document.createElement('article');
    chatMessage.dataset.messageId = 'message-new';
    chatMessage.textContent = 'new visible ChatGPT message';

    document.body.append(extensionHost, chatMessage);
    await wait(20);
    observer.stop();

    expect(messages.map((message) => message.type)).toContain('DEEP_SEARCH_CONTENT_READY');
    expect(messages.map((message) => message.type)).toContain('DEEP_SEARCH_CURRENT_CONVERSATION_SEEN');
    expect(messages.map((message) => message.type)).toContain('DEEP_SEARCH_CURRENT_CONVERSATION_CHANGED');
  });
});

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}
