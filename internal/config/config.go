// config 包集中读取 tinyAgent 的运行参数，避免每个模块自行解释环境变量。
package config

import (
	"fmt"
	"net/url"
	"os"
	"time"
)

// Config 是启动服务所需的运行配置。它只保存连接地址、超时时间和资源名称，
// 不保存用户对话内容。
type Config struct {
	// ListenAddress 是网页 API 监听的本地地址。
	ListenAddress string
	// DatabaseURL 是必须由部署环境提供的 PostgreSQL 地址。
	DatabaseURL string
	// SandboxNS 是 SandboxClaim 和 Sandbox 所在的 Kubernetes 命名空间。
	SandboxNS string
	// PoolName 是从中领取实例的 SandboxSet 预热池名称。
	PoolName string
	// PersistentVolumeName 是两个 AgenticFS 动态挂载使用的 Kubernetes PV 名称。
	PersistentVolumeName string
	// KubeconfigPath 只用于本地调试；线上为空时使用 Pod 内的 ServiceAccount。
	KubeconfigPath string
	// LocalACPEndpoint 非空时走本地 Docker Compose ACP 桥，否则走 Kubernetes Sandbox。
	LocalACPEndpoint string
	// ClaimTimeout 是等待 SandboxClaim 变为可用的最长时间。
	ClaimTimeout time.Duration
	// IdleTimeout 是 ACP 连接空闲时长；超过后代理会关闭连接并回收沙箱。
	IdleTimeout time.Duration
	// MaxLifetime 写入 Claim 的 shutdownTime，限制一次借用最多能持续多久。
	MaxLifetime time.Duration
}

// Load 从环境变量读取配置，并在服务启动前检查必须项和时间格式。
// 数据库地址没有安全默认值，必须由部署环境明确提供。
func Load() (Config, error) {
	// DATABASE_URL 故意没有默认值：连错数据库比启动失败更危险，部署环境必须明确提供它。
	databaseURL, err := requiredEnvironmentValue("DATABASE_URL")
	if err != nil {
		return Config{}, err
	}
	listenAddress, err := requiredEnvironmentValue("LISTEN_ADDRESS")
	if err != nil {
		return Config{}, err
	}
	sandboxNamespace, err := requiredEnvironmentValue("SANDBOX_NAMESPACE")
	if err != nil {
		return Config{}, err
	}
	sandboxPoolName, err := requiredEnvironmentValue("SANDBOX_POOL_NAME")
	if err != nil {
		return Config{}, err
	}
	persistentVolumeName, err := requiredEnvironmentValue("AGENTICFS_PV_NAME")
	if err != nil {
		return Config{}, err
	}
	idleTimeout, err := durationFromEnvironment("IDLE_TIMEOUT")
	if err != nil {
		return Config{}, err
	}
	maxLifetime, err := durationFromEnvironment("MAX_LIFETIME")
	if err != nil {
		return Config{}, err
	}
	// 首个沙箱需要拉取业务镜像、挂载 AgenticFS，偶发镜像仓库重试时可能超过两分钟。
	// 五分钟只影响用户愿意等待多久，不会改变空闲回收和最大存活时间这两道资源边界。
	claimTimeout, err := durationFromEnvironment("SANDBOX_CLAIM_TIMEOUT")
	if err != nil {
		return Config{}, err
	}
	localACPEndpoint := os.Getenv("LOCAL_ACP_ENDPOINT")
	if localACPEndpoint != "" {
		parsed, err := url.Parse(localACPEndpoint)
		if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
			return Config{}, fmt.Errorf("LOCAL_ACP_ENDPOINT must be a ws:// or wss:// URL")
		}
	}
	return Config{
		ListenAddress:        listenAddress,
		DatabaseURL:          databaseURL,
		SandboxNS:            sandboxNamespace,
		PoolName:             sandboxPoolName,
		PersistentVolumeName: persistentVolumeName,
		KubeconfigPath:       os.Getenv("KUBECONFIG_PATH"),
		LocalACPEndpoint:     localACPEndpoint,
		ClaimTimeout:         claimTimeout,
		IdleTimeout:          idleTimeout,
		MaxLifetime:          maxLifetime,
	}, nil
}

func requiredEnvironmentValue(key string) (string, error) {
	if value := os.Getenv(key); value != "" {
		return value, nil
	}
	return "", fmt.Errorf("%s is required", key)
}

func durationFromEnvironment(key string) (time.Duration, error) {
	// 所有时长都在启动时解析。格式写错时立即启动失败，避免服务运行到一半
	// 才因为无法理解超时配置而出问题。
	value, err := requiredEnvironmentValue(key)
	if err != nil {
		return 0, err
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", key, err)
	}
	return parsed, nil
}
