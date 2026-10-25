// 本文件负责云端沙箱的一整套生命周期：创建 Claim、等待控制器分配实例、连接桥，
// 以及 prompt 结束后删除 Claim 和已经领用的 Sandbox。
package sandbox

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/example/tinyagent/internal/acpproxy"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

func kubernetesProgressPhases() []acpproxy.SandboxProgress {
	return []acpproxy.SandboxProgress{
		{Phase: acpproxy.StatusPhaseSandboxClaiming, Label: "领取沙箱", Source: acpproxy.SandboxSourceWarmPool},
		{Phase: acpproxy.StatusPhaseSandboxWaiting, Label: "等待沙箱就绪", Source: acpproxy.SandboxSourceProvisioning},
		{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接 Agent", Source: acpproxy.SandboxSourceProvisioning},
		{Phase: acpproxy.StatusPhaseAgentReady, Label: "Agent 已连接", Source: acpproxy.SandboxSourceProvisioning},
	}
}

// Manager 把“领取、连接、归还”收成一个操作。上层拿到的只有 ACP 可用的字节流，
// 不需要知道 Claim、Sandbox 或 Kubernetes 自定义资源怎样配合。
type Manager struct {
	client               dynamic.Interface
	namespace            string
	poolName             string
	persistentVolumeName string
	claimTimeout         string
	maxLifetime          time.Duration
	pollInterval         time.Duration
}

const sandboxPollInterval = 250 * time.Millisecond

// NewManager 创建阿里云 Sandbox 的领取器。
//
// Manager 不缓存任何 Sandbox。每次 Acquire 都新建一张 Claim，从预热池领取新的实例，
// 这样上一轮提问留下的文件、进程和网络连接不会被下一轮误用。
func NewManager(client dynamic.Interface, namespace, poolName, persistentVolumeName, claimTimeout string, maxLifetime time.Duration) *Manager {
	return &Manager{client: client, namespace: namespace, poolName: poolName, persistentVolumeName: persistentVolumeName, claimTimeout: claimTimeout, maxLifetime: maxLifetime, pollInterval: sandboxPollInterval}
}

// Acquire 保留最简单的调用方式：调用方只拿到一条流和一个释放函数，
// 不需要关心沙箱中间经历了哪些状态。
func (m *Manager) Acquire(ctx context.Context, sessionID string) (io.ReadWriteCloser, func(context.Context) error, error) {
	return m.AcquireWithProgress(ctx, sessionID, nil)
}

// AcquireWithProgress 在领取过程中报告可以展示给用户的阶段，
// 但资源清理规则和 Acquire 完全一样：成功或失败都必须回收 Claim 和 Sandbox。
func (m *Manager) AcquireWithProgress(ctx context.Context, sessionID string, report func(acpproxy.SandboxProgress)) (io.ReadWriteCloser, func(context.Context) error, error) {
	claimName := "tinyagent-" + sessionID
	claim, err := BuildClaim(m.namespace, m.poolName, sessionID, m.persistentVolumeName, m.claimTimeout, m.maxLifetime)
	if err != nil {
		return nil, nil, err
	}
	source := m.sandboxSource(ctx)
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseSandboxClaiming, Label: "领取沙箱", Source: source})
	if _, err := m.client.Resource(claimGVR).Namespace(m.namespace).Create(ctx, claim, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return nil, nil, fmt.Errorf("create sandboxclaim: %w", err)
	}
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseSandboxWaiting, Label: "等待沙箱就绪", Source: source})
	release := func(releaseContext context.Context) error {
		return DeleteClaimAndSandboxes(releaseContext, m.client, m.namespace, claimName)
	}
	ip, err := WaitReadyEndpoint(ctx, m.client, m.namespace, claimName, m.pollInterval)
	if err != nil {
		_ = release(context.Background())
		return nil, nil, err
	}
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接 Agent", Source: source})
	stream, err := DialBridge(ctx, ip)
	if err != nil {
		_ = release(context.Background())
		return nil, nil, err
	}
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentReady, Label: "Agent 已连接", Source: source})
	return stream, release, nil
}

func reportProgress(report func(acpproxy.SandboxProgress), progress acpproxy.SandboxProgress) {
	if report != nil {
		report(progress)
	}
}

func (m *Manager) sandboxSource(ctx context.Context) acpproxy.SandboxSource {
	pool, err := m.client.Resource(poolGVR).Namespace(m.namespace).Get(ctx, m.poolName, metav1.GetOptions{})
	if err != nil {
		return acpproxy.SandboxSourceProvisioning
	}
	available, found, err := unstructured.NestedInt64(pool.Object, "status", "availableReplicas")
	return sandboxSourceFromAvailable(available, err == nil && found)
}

func sandboxSourceFromAvailable(available int64, found bool) acpproxy.SandboxSource {
	if !found || available <= 0 {
		return acpproxy.SandboxSourceProvisioning
	}
	return acpproxy.SandboxSourceWarmPool
}

// NewDynamicClient 创建可以访问不同 Kubernetes 资源类型的客户端。
// 优先级是显式 kubeconfig、KUBECONFIG 环境变量、集群内 ServiceAccount；线上不需要
// 把 kubeconfig 文件放进镜像，依靠 Pod 身份访问 Sandbox 自定义资源。
func NewDynamicClient(kubeconfig string) (dynamic.Interface, error) {
	var configuration *rest.Config
	var err error
	if kubeconfig != "" {
		configuration, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
	} else if fromEnvironment := os.Getenv("KUBECONFIG"); fromEnvironment != "" {
		configuration, err = clientcmd.BuildConfigFromFlags("", fromEnvironment)
	} else {
		configuration, err = rest.InClusterConfig()
	}
	if err != nil {
		return nil, fmt.Errorf("load kubernetes configuration: %w", err)
	}
	client, err := dynamic.NewForConfig(configuration)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes dynamic client: %w", err)
	}
	return client, nil
}

// Acquire 从常驻预热池领取一台沙箱，并等待它真正能连接后再返回。
//
// 返回值依次是 ACP 双向流、释放函数和错误。只要拿到非 nil 的 release，调用方就要
// 立刻安排 defer release。创建 Claim、等待实例就绪、连接桥中的任何一步失败，
// 都要删除已经创建的资源；因为删除 Claim 不会自动删除已领走的 Sandbox，
// 所以 release 必须同时清理两类资源。
var (
	sandboxGVR = schema.GroupVersionResource{Group: "agents.kruise.io", Version: "v1alpha1", Resource: "sandboxes"}
	claimGVR   = schema.GroupVersionResource{Group: "agents.kruise.io", Version: "v1alpha1", Resource: "sandboxclaims"}
	poolGVR    = schema.GroupVersionResource{Group: "agents.kruise.io", Version: "v1alpha1", Resource: "sandboxsets"}
)

// DeleteClaimAndSandboxes 删除 Claim 以及这张 Claim 已经领走的全部 Sandbox。
//
// 先删 Claim，再按 claim-name label 找到 Sandbox 并删除。删除操作对 NotFound
// 幂等，允许请求超时或控制器提前清理后再次执行 release。
func DeleteClaimAndSandboxes(ctx context.Context, client dynamic.Interface, namespace, claimName string) error {
	claims := client.Resource(claimGVR).Namespace(namespace)
	if err := claims.Delete(ctx, claimName, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete sandboxclaim: %w", err)
	}
	sandboxes, err := client.Resource(sandboxGVR).Namespace(namespace).List(ctx, metav1.ListOptions{LabelSelector: "agents.kruise.io/claim-name=" + claimName})
	if err != nil {
		return fmt.Errorf("list claimed sandboxes: %w", err)
	}
	for _, item := range sandboxes.Items {
		if err := client.Resource(sandboxGVR).Namespace(namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete sandbox %s: %w", item.GetName(), err)
		}
	}
	return nil
}

// WaitReadyEndpoint 反复查看 Claim 和 Sandbox，直到拿到真正可连接的内网地址。
// ACK 的 claimedReplicas 状态字段可能晚于 Sandbox 的 claim-name 标签更新，因此不能
// 用它作为门槛；只要找到属于这张 Claim、正在运行、Ready=True 且有 IP 的 Sandbox，
// 就可以连接。
func WaitReadyEndpoint(ctx context.Context, client dynamic.Interface, namespace, claimName string, interval time.Duration) (string, error) {
	for {
		_, err := client.Resource(claimGVR).Namespace(namespace).Get(ctx, claimName, metav1.GetOptions{})
		if err != nil {
			return "", fmt.Errorf("get sandboxclaim: %w", err)
		}
		items, err := client.Resource(sandboxGVR).Namespace(namespace).List(ctx, metav1.ListOptions{LabelSelector: "agents.kruise.io/claim-name=" + claimName})
		if err != nil {
			return "", fmt.Errorf("list claimed sandboxes: %w", err)
		}
		if ip, ready := readySandboxEndpoint(items.Items); ready {
			return ip, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
	}
}

func readySandboxEndpoint(items []unstructured.Unstructured) (string, bool) {
	for _, item := range items {
		if ip, ready := readyEndpoint(&item); ready {
			return ip, true
		}
	}
	return "", false
}

// readyEndpoint 只判断一台 Sandbox 是否可连接，不做等待和资源操作。
// 把判断单独放在这里，既方便看清三个条件，也方便单元测试覆盖边界情况。
func readyEndpoint(sandbox *unstructured.Unstructured) (string, bool) {
	phase, found, err := unstructured.NestedString(sandbox.Object, "status", "phase")
	if err != nil || !found || phase != "Running" {
		return "", false
	}
	conditions, found, err := unstructured.NestedSlice(sandbox.Object, "status", "conditions")
	if err != nil || !found {
		return "", false
	}
	ready := false
	for _, item := range conditions {
		condition, ok := item.(map[string]any)
		if ok && condition["type"] == "Ready" && condition["status"] == "True" {
			ready = true
			break
		}
	}
	if !ready {
		return "", false
	}
	ip, found, err := unstructured.NestedString(sandbox.Object, "status", "sandboxIp")
	return ip, err == nil && found && ip != ""
}
