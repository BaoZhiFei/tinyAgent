// 输入框只负责收集文字和触发表单提交；session 创建、网络请求和错误处理由 useSession 负责。
interface ComposerProps {
  text: string;
  sending: boolean;
  onChange(text: string): void;
  onSubmit(event: React.FormEvent<HTMLFormElement>): void;
}

export function Composer({ text, sending, onChange, onSubmit }: ComposerProps) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        value={text}
        disabled={sending}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter 发送，Shift+Enter 换行，和常见聊天输入框的操作保持一致。
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="输入你的任务…"
        aria-label="任务内容"
      />
      <button
        className="send-button"
        disabled={sending}
        aria-label={sending ? "正在处理中" : "发送任务"}
      >
        {sending ? "…" : "↑"}
      </button>
    </form>
  );
}
