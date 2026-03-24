import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import ChatHeader from "./ChatHeader";
import ConversationList from "./ConversationList";
import EmptyChatState from "./EmptyChatState";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";

const platform = getCachedPlatform();

export default function ChatView() {
  const { t } = useTranslation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeTitle, setActiveTitle] = useState("Untitled");
  const [refreshKey, setRefreshKey] = useState(0);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const persistence = useChatPersistence({
    conversationId: activeConversationId,
    onConversationCreated: (id, title) => {
      setActiveConversationId(id);
      setActiveTitle(title);
      setRefreshKey((k) => k + 1);
    },
  });

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const handleSelectConversation = useCallback(
    async (id: number, title: string) => {
      if (id === activeConversationId) return;
      setActiveConversationId(id);
      setActiveTitle(title);
      await persistence.loadConversation(id);
    },
    [activeConversationId, persistence]
  );

  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    setActiveTitle("Untitled");
    persistence.handleNewChat();
  }, [persistence]);

  const handleTextSubmit = useCallback(
    async (text: string) => {
      let convId = activeConversationId;
      if (!convId) {
        const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
        convId = await persistence.createConversation(title);
        setActiveTitle(title);
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        isStreaming: false,
      };
      persistence.setMessages((prev) => [...prev, userMsg]);
      persistence.saveUserMessage(text);

      const allMessages = [...persistence.messages, userMsg];
      streaming.sendToAI(text, allMessages);
    },
    [activeConversationId, persistence, streaming]
  );

  const handleTitleChange = useCallback(
    async (title: string) => {
      if (!activeConversationId) return;
      setActiveTitle(title);
      await window.electronAPI?.updateAgentConversationTitle?.(activeConversationId, title);
      setRefreshKey((k) => k + 1);
    },
    [activeConversationId]
  );

  const handleArchive = useCallback(async (_id: number) => {
    // Archive not yet supported in the DB API
  }, []);

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: t("chat.delete"),
        description: t("chat.deleteConfirm"),
        onConfirm: async () => {
          await window.electronAPI?.deleteAgentConversation?.(id);
          if (activeConversationId === id) {
            handleNewChat();
          }
          setRefreshKey((k) => k + 1);
        },
        variant: "destructive",
      });
    },
    [activeConversationId, handleNewChat, showConfirmDialog, t]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewChat]);

  const hasActiveChat = activeConversationId !== null || persistence.messages.length > 0;

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
      <div className="flex h-full">
        <div className="w-56 min-w-50 shrink-0 border-r border-border/15 dark:border-white/6">
          <ConversationList
            activeConversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onNewChat={handleNewChat}
            onArchive={handleArchive}
            onDelete={handleDelete}
            refreshKey={refreshKey}
          />
        </div>
        <div className="flex-1 min-w-80 flex flex-col">
          {hasActiveChat ? (
            <>
              <ChatHeader
                title={activeTitle}
                onTitleChange={handleTitleChange}
                onNewChat={handleNewChat}
              />
              <ChatMessages messages={persistence.messages} />
              <ChatInput
                agentState={streaming.agentState}
                partialTranscript=""
                toolStatus={streaming.toolStatus}
                activeToolName={streaming.activeToolName}
                onTextSubmit={handleTextSubmit}
              />
            </>
          ) : (
            <EmptyChatState />
          )}
        </div>
      </div>
    </>
  );
}
