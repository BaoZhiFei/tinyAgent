// agent 包负责生成沙箱中 Codex Agent 的运行配置。
package agent

import "encoding/json"

// Settings 是一次沙箱运行需要的模型设置。它只描述“要连接谁、用什么模型、
// 从哪个环境变量取密钥”，不负责真正发请求。
//
// ProviderID 是 Codex 配置中的机器标识，ProviderName 是人类可读名称；BaseURL
// 和 Model 决定请求发往哪里、使用哪个模型。APIKeyEnv 只描述“从哪个环境变量
// 读取密钥”，APIKey 本身由服务在运行时注入，不能写入镜像或代码配置文件。
type Settings struct {
	APIKey       string
	ProviderID   string
	ProviderName string
	BaseURL      string
	Model        string
	APIKeyEnv    string
}

// CodexEnvironment 把 Settings 转成沙箱启动脚本能直接使用的环境变量列表。
//
// 返回值使用 KEY=value 形式，供沙箱启动脚本直接注入。CODEX_CONFIG 负责告诉 Codex
// 模型地址、模型名和协议类型；MODEL_PROVIDER 与它一起作用于新建和 session/load 恢复。
// APIKey 只在运行时放进环境变量，不能写进镜像或提交到代码库。
func CodexEnvironment(settings Settings) []string {
	// 配置对象放进一个环境变量，避免在镜像中写入与部署环境绑定的 provider 信息。
	configuration := map[string]any{
		"model_provider": settings.ProviderID,
		"model":          settings.Model,
		"model_providers": map[string]any{settings.ProviderID: map[string]string{
			"name": settings.ProviderName, "base_url": settings.BaseURL, "wire_api": "responses", "env_key": settings.APIKeyEnv,
		}},
	}
	// map 只包含代码里构造的简单字符串，正常不会序列化失败。
	// 这里仍然忽略错误，因为函数签名是返回环境变量列表；如果真的失败，
	// Codex 会在第一次请求时暴露配置问题，测试也会帮助尽早发现。
	encodedConfiguration, _ := json.Marshal(configuration)
	return []string{"AGENT_CMD=codex-acp", "CODEX_API_KEY=" + settings.APIKey, settings.APIKeyEnv + "=" + settings.APIKey, "MODEL_PROVIDER=" + settings.ProviderID, "CODEX_CONFIG=" + string(encodedConfiguration), "NO_BROWSER=1"}
}
