import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { ChatMessages } from "../chat/ChatMessages";
import type { Message } from "../chat/types";

export type { Message, ToolCallInfo } from "../chat/types";

interface AgentChatProps {
  messages: Message[];
}

export function AgentChat({ messages }: AgentChatProps) {
  const { t } = useTranslation();
  const agentKey = useSettingsStore((s) => s.agentKey);
  const hotkeyLabel = formatHotkeyLabel(agentKey);

  return (
    <ChatMessages
      messages={messages}
      emptyState={
        <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
          <div
            className="text-muted-foreground/30"
            style={{ animation: "agent-mic-pulse 3s ease-in-out infinite" }}
          >
            <Mic size={20} />
          </div>
          <div className="text-center">
            <p className="text-[12px] text-muted-foreground/50">
              {t("agentMode.chat.emptyState", { hotkey: hotkeyLabel })}
            </p>
            <p className="text-[11px] text-muted-foreground/30 mt-0.5">
              {t("agentMode.chat.orType")}
            </p>
          </div>
        </div>
      }
    />
  );
}
