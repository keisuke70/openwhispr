import { useTranslation } from "react-i18next";

export default function EmptyChatState() {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-center h-full select-none">
      <p className="text-xs text-muted-foreground/40">{t("chat.selectChat")}</p>
    </div>
  );
}
