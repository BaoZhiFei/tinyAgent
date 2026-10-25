import type { PermissionRequest as PermissionRequestData } from "../types";

// 权限请求是一次性的。用户选择后由上层把结果交回 ACP，组件本身不保存请求状态。
interface PermissionRequestProps {
  request: PermissionRequestData;
  onRespond(optionID?: string): void;
}

export function PermissionRequest({
  request,
  onRespond,
}: PermissionRequestProps) {
  return (
    <section className="permission-request" aria-label="ACP 权限请求">
      <strong>Agent 请求权限</strong>
      <p>{request.description || request.title || "请选择允许的操作"}</p>
      <div className="permission-options">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            onClick={() => onRespond(option.optionId)}
          >
            {option.name || option.optionId}
          </button>
        ))}
        <button type="button" onClick={() => onRespond()}>
          取消
        </button>
      </div>
    </section>
  );
}
