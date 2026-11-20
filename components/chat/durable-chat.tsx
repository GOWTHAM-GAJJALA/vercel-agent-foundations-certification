"use client";

/**
 * Shared chat shell for both agents, built from AI Elements.
 *
 * - `useChat` talks to a workflow-backed route through WorkflowChatTransport,
 *   which automatically reconnects if a response stream is cut off.
 * - The conversation and the id of any in-progress run are kept in
 *   localStorage. After a page refresh the finished turns are restored and,
 *   if a reply was still streaming, the chat re-attaches to that same run
 *   (GET `{api}/{runId}/stream`) and replays it once. Nothing is re-sent, so
 *   the agent never starts the same task twice.
 */
import { useChat } from "@ai-sdk/react";
// The /client entry only contains the transport, not the server runtime.
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { UIMessage } from "ai";
import { RotateCcw, SquarePen } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type StoredChat<M extends UIMessage> = {
  id: string;
  messages: M[];
  activeRunId: string | null;
};

function newChat<M extends UIMessage>(): StoredChat<M> {
  return { id: crypto.randomUUID(), messages: [], activeRunId: null };
}

function loadChat<M extends UIMessage>(key: string): StoredChat<M> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return newChat<M>();
    const parsed = JSON.parse(raw) as StoredChat<M>;
    if (!parsed?.id || !Array.isArray(parsed.messages)) return newChat<M>();
    return parsed;
  } catch {
    return newChat<M>();
  }
}

function saveChat<M extends UIMessage>(key: string, chat: StoredChat<M>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(chat));
  } catch {
    // Storage full or blocked (private mode): the chat still works, it just
    // won't survive a refresh.
  }
}

export type DurableChatProps<M extends UIMessage> = {
  /** localStorage key; also keeps the two agents' conversations separate. */
  storageKey: string;
  /** Chat route; reconnects use `{api}/{runId}/stream`. */
  api: string;
  placeholder: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon?: ReactNode;
  suggestions: string[];
  /** Renders non-text message parts (tool results). Return null to skip. */
  renderPart: (part: M["parts"][number], key: string) => ReactNode;
  /** Shown while waiting for the first output of a reply. */
  thinkingLabel?: string;
};

export function DurableChat<M extends UIMessage>(props: DurableChatProps<M>) {
  // Load after mount: the server render has no access to localStorage.
  const [stored, setStored] = useState<StoredChat<M> | null>(null);
  useEffect(() => {
    setStored(loadChat<M>(props.storageKey));
  }, [props.storageKey]);

  const startNewChat = useCallback(() => {
    const fresh = newChat<M>();
    saveChat(props.storageKey, fresh);
    setStored(fresh);
  }, [props.storageKey]);

  if (!stored) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <Spinner />
      </div>
    );
  }
  return (
    <ChatSession<M>
      key={stored.id}
      {...props}
      stored={stored}
      onNewChat={startNewChat}
    />
  );
}

function ChatSession<M extends UIMessage>({
  storageKey,
  api,
  placeholder,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  suggestions,
  renderPart,
  thinkingLabel = "Thinking…",
  stored,
  onNewChat,
}: DurableChatProps<M> & { stored: StoredChat<M>; onNewChat: () => void }) {
  const [input, setInput] = useState("");
  const activeRunId = useRef<string | null>(stored.activeRunId);

  const transport = useMemo(
    () =>
      new WorkflowChatTransport<M>({
        api,
        maxConsecutiveErrors: 5,
        onChatSendMessage: (response, options) => {
          activeRunId.current = response.headers.get("x-workflow-run-id");
          // Snapshot finished turns + the new message; the reply is restored
          // from the run's stream if the page reloads mid-response.
          saveChat(storageKey, {
            id: stored.id,
            messages: options.messages,
            activeRunId: activeRunId.current,
          });
        },
        prepareReconnectToStreamRequest: ({ api: fallback }) => ({
          api: activeRunId.current
            ? `${api}/${encodeURIComponent(activeRunId.current)}/stream`
            : fallback,
        }),
      }),
    [api, storageKey, stored.id],
  );

  const { messages, sendMessage, status, error, regenerate, clearError, stop } =
    useChat<M>({
      id: stored.id,
      messages: stored.messages,
      transport,
      // Re-attach to a reply that was still streaming before a refresh.
      resume: Boolean(stored.activeRunId),
      onFinish: ({ messages: finished }) => {
        activeRunId.current = null;
        saveChat(storageKey, { id: stored.id, messages: finished, activeRunId: null });
      },
      onError: () => {
        activeRunId.current = null;
      },
    });

  // Don't keep pointing at a run that errored or expired.
  useEffect(() => {
    if (error && !activeRunId.current) {
      saveChat(storageKey, { id: stored.id, messages, activeRunId: null });
    }
  }, [error, messages, storageKey, stored.id]);

  const busy = status === "submitted" || status === "streaming";

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (error) clearError();
    sendMessage({ text: trimmed });
    setInput("");
  };

  const handleSubmit = (message: PromptInputMessage) => send(message.text ?? "");

  // Stops showing the reply in this browser. The server run finishes on its
  // own; the stopped reply won't auto-resume after a refresh.
  const handleStop = () => {
    stop();
    activeRunId.current = null;
    saveChat(storageKey, { id: stored.id, messages, activeRunId: null });
  };

  const last = messages[messages.length - 1];
  const waitingForFirstOutput =
    busy && (last?.role === "user" || (last?.role === "assistant" && last.parts.length === 0));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {messages.length > 0 ? (
        <div className="flex justify-end border-b px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onNewChat}
            disabled={busy}
          >
            <SquarePen className="size-3.5" aria-hidden="true" />
            New chat
          </Button>
        </div>
      ) : null}

      <Conversation className="flex-1">
        <ConversationContent className="gap-5">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title={emptyTitle}
              description={emptyDescription}
              icon={emptyIcon}
            />
          ) : (
            messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent className="w-full max-w-full space-y-3">
                  {message.parts.map((part, index) => {
                    const key = `${message.id}-${index}`;
                    if (part.type === "text") {
                      return message.role === "assistant" ? (
                        <MessageResponse key={key}>{part.text}</MessageResponse>
                      ) : (
                        <p key={key} className="whitespace-pre-wrap">
                          {part.text}
                        </p>
                      );
                    }
                    return <div key={key}>{renderPart(part, key)}</div>;
                  })}
                </MessageContent>
              </Message>
            ))
          )}

          {waitingForFirstOutput ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Spinner className="size-3.5" />
              {thinkingLabel}
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
            >
              <span className="text-foreground">
                The assistant couldn't reply just now (it may be busy). Your conversation is saved; try again in a moment.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={() => {
                  clearError();
                  regenerate();
                }}
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Try again
              </Button>
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex flex-col gap-2 border-t p-3">
        {messages.length === 0 ? (
          <Suggestions aria-label="Suggested questions">
            {suggestions.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={send} disabled={busy} />
            ))}
          </Suggestions>
        ) : null}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              placeholder={placeholder}
              aria-label={placeholder}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit
              status={status}
              onStop={handleStop}
              disabled={!busy && !input.trim()}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
