// 这些测试确认必填配置、运行时默认值、模型配置注入、时间格式和本地 ACP 地址会在启动前被检查。
package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadRejectsMissingDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("Load() error = %v, want DATABASE_URL error", err)
	}
}

func TestLoadRejectsMissingRuntimeConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://tinyagent")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "LISTEN_ADDRESS") {
		t.Fatalf("Load() error = %v, want LISTEN_ADDRESS error", err)
	}
}

func TestLoadUsesInjectedRuntimeConfiguration(t *testing.T) {
	setRequiredRuntimeConfiguration(t)
	configuration, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if configuration.ListenAddress != ":8080" || configuration.SandboxNS != "tinyagent" || configuration.ClaimTimeout != 5*time.Minute {
		t.Fatalf("configuration = %#v, want injected runtime values", configuration)
	}
}

func TestLoadNamesInvalidClaimTimeout(t *testing.T) {
	setRequiredRuntimeConfiguration(t)
	t.Setenv("SANDBOX_CLAIM_TIMEOUT", "not-a-duration")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "SANDBOX_CLAIM_TIMEOUT") {
		t.Fatalf("Load() error = %v, want SANDBOX_CLAIM_TIMEOUT error", err)
	}
}

func TestLoadRejectsMalformedLocalACPEndpoint(t *testing.T) {
	setRequiredRuntimeConfiguration(t)
	t.Setenv("LOCAL_ACP_ENDPOINT", "not a websocket URL")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "LOCAL_ACP_ENDPOINT") {
		t.Fatalf("Load() error = %v, want LOCAL_ACP_ENDPOINT error", err)
	}
}

func setRequiredRuntimeConfiguration(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://tinyagent")
	t.Setenv("LISTEN_ADDRESS", ":8080")
	t.Setenv("SANDBOX_NAMESPACE", "tinyagent")
	t.Setenv("SANDBOX_POOL_NAME", "tinyagent-pool")
	t.Setenv("AGENTICFS_PV_NAME", "tinyagent-agenticfs")
	t.Setenv("SANDBOX_CLAIM_TIMEOUT", "5m")
	t.Setenv("IDLE_TIMEOUT", "10m")
	t.Setenv("MAX_LIFETIME", "30m")
}
