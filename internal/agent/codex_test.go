// 这些测试锁定 Codex 启动所需的环境变量和默认模型配置，防止沙箱启动后才发现配置错误。
package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCodexEnvironmentDoesNotApplyBusinessDefaults(t *testing.T) {
	// provider、地址、模型和密钥变量名都必须由配置注入，空 Settings 不能偷偷切到百炼。
	variables := CodexEnvironment(Settings{APIKey: "secret"})
	joined := strings.Join(variables, "\n")
	for _, unwanted := range []string{"MODEL_PROVIDER=bailian", "阿里云百炼", "llm-4im00vvmdedf6zgl", "qwen3.8-max", "MODEL_API_KEY=secret"} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("environment unexpectedly contains business default %q: %s", unwanted, joined)
		}
	}
}

// 这条测试守住百炼的 Responses 兼容地址。Codex 只走 Responses 协议；若误换成旧的
// Chat Completions 地址，沙箱虽然能启动，却会在用户第一次提问时才报错。
func TestCodexEnvironmentUsesBailianResponsesAPI(t *testing.T) {
	variables := CodexEnvironment(Settings{
		APIKey:       "bailian-secret",
		ProviderID:   "bailian",
		ProviderName: "阿里云百炼",
		BaseURL:      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		Model:        "qwen3.7-flash",
		APIKeyEnv:    "DASHSCOPE_API_KEY",
	})
	joined := strings.Join(variables, "\n")
	for _, want := range []string{"CODEX_API_KEY=bailian-secret", "DASHSCOPE_API_KEY=bailian-secret", "MODEL_PROVIDER=bailian", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen3.7-flash", "responses"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("environment missing %q: %s", want, joined)
		}
	}
}

func TestCodexEnvironmentDoesNotApplyBailianCatalogToAnotherProvider(t *testing.T) {
	// 使用其他 provider 时，只使用调用方给出的地址和模型，不能偷偷套用百炼默认值。
	variables := CodexEnvironment(Settings{
		APIKey:       "other-secret",
		ProviderID:   "other",
		ProviderName: "Other",
		BaseURL:      "https://example.test/v1",
		Model:        "other-model",
		APIKeyEnv:    "OTHER_API_KEY",
	})
	var configuration map[string]any
	for _, variable := range variables {
		if encoded, found := strings.CutPrefix(variable, "CODEX_CONFIG="); found {
			if err := json.Unmarshal([]byte(encoded), &configuration); err != nil {
				t.Fatalf("decode CODEX_CONFIG: %v", err)
			}
		}
	}
	if _, found := configuration["model_catalog_json"]; found {
		t.Fatalf("non-Bailian provider unexpectedly received Bailian model catalog: %#v", configuration)
	}
}
