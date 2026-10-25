// tinyAgent 的云端施工图
//
// 这不是“启动一个程序”的脚本，而是 Pulumi 的资源清单：每个 new 语句都在描述一个
// 云资源或 Kubernetes 对象。Pulumi 会根据对象之间的引用和 dependsOn，决定创建顺序。
//
// Kubernetes（下面简称 K8s）可以先用一句大白话理解：它是一个负责运行容器的调度员。
// - Cluster：整座 K8s 集群。
// - Namespace：集群里的“文件夹”，把 tinyAgent 和系统组件隔开。
// - Deployment：声明“要一直运行几个 Pod”。Pod 可以理解为一组一起运行的容器。
// - Service：给一组 Pod 提供稳定的集群内地址，Pod 重建后地址仍不变。
// - Ingress：把外部 HTTP/HTTPS 请求按域名和路径转给 Service。
// - ServiceAccount + Role + RoleBinding：给 Pod 一张“只能做指定事情”的工作证。
// - PV（PersistentVolume）：集群里的持久化存储入口；这里连接外部 AgenticFS。
// - CRD：K8s 的扩展对象类型，例如 SandboxSet 和 SandboxClaim。
//
// 这张图只让 ALB 暴露到公网，沙箱、数据库和 AgenticFS 都留在 VPC/集群内部。
//
// 浏览器 ──公网 ALB──> 网页 / API ──> 预热沙箱 ──> Codex ──> 模型服务
//                         │
//                         ├── RDS：用户看得见的聊天记录
//                         └── AgenticFS：Codex 恢复上下文的工作记忆
//
// 创建（pulumi up）大致从下往上：网络 → ACK → ACK 扩展 → 存储/权限 → 应用 → 公网入口 → 沙箱预热池。
// 删除（pulumi destroy）则反过来：先停止应用和沙箱，再删权限/扩展，最后才拆集群和网络。
// 这不是人工操作顺序，而是 Pulumi 根据资源引用自动计算出来的依赖顺序。
// 请不要用 kubectl 手工删除本文件管理的对象，否则 Pulumi 的记录会与真实环境不一致。
// AgenticFS AccessPoint 是部署前已准备好的外部资源；本图不会删除它。
// 先建阿里云底座，再用刚建 ACK 的 kubeconfig 部署应用，绝不误用操作者本机的 kubectl 上下文。
import * as pulumi from "@pulumi/pulumi";
import * as alicloud from "@pulumi/alicloud";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
// Pulumi 的 TypeScript 运行器会在运行时加载下面两个很小的 ESM 辅助文件。
// @ts-ignore 它们故意保持普通 ESM，方便 node:test 直接测试。
import { rdsServiceLinkedRoleWaitOptions } from "./rds-service-linked-role.mjs";
// @ts-ignore 它们故意保持普通 ESM，方便 node:test 直接测试。
import { pinImageToRelease, resolveReleaseTag } from "./image-release.mjs";

// ============================================================================
// 1. 配置与密钥
// ============================================================================
// 这些是施工图的输入。部署参数统一从 Pulumi 配置读取；require 表示缺失时拒绝施工。
// 这样比“给一个猜出来的默认值然后部署失败”更安全，也更容易排查。
const configuration = new pulumi.Config();
const alicloudConfiguration = new pulumi.Config("alicloud");
const name = configuration.require("name");
const region = alicloudConfiguration.require("region");
// 演示入口是固定域名，不允许用临时 IP 绕开 HTTPS；这样页面和 WebSocket 天然同源。
const domain = configuration.require("domain");
// 证书由证书管理服务签发并完成 DNS 归属校验后填入。没有证书时只创建 HTTP 入口，避免谎称 HTTPS 已可用。
const certificateID = configuration.get("certificateID");
const zoneID = configuration.require("zoneId");
// ACK 节点在 VPC 内拉取私有 ACR 镜像，必须使用 ACR 的 VPC endpoint；公网 endpoint
// 会把节点带到公网地址，实际部署中会因 NAT/ACL 路径超时。镜像配置仍接受部署手册里的
// 公网域名，施工图统一改成同一实例的 VPC 域名，避免忘记改其中一个 Deployment。
const acrInstanceID = "cri-9pihnmrsbuwalcex";
const acrPublicRegistryDomain = "tinyagent-registry.cn-shanghai.cr.aliyuncs.com";
const acrVpcRegistryDomain = "tinyagent-registry-vpc.cn-shanghai.cr.aliyuncs.com";
const useAcrVpcEndpoint = (image: string) =>
  image.replace(acrPublicRegistryDomain, acrVpcRegistryDomain);
// 镜像配置保留仓库和兼容 tag，但实际部署固定到当前提交，避免 ACR 重新推送 :demo
// 后 Kubernetes 继续运行旧 Pod。需要临时部署其他版本时可设置 releaseTag 覆盖它。
const releaseTag = configuration.get("releaseTag") ?? resolveReleaseTag();
const pinConfiguredImage = (image: string) =>
  pinImageToRelease(useAcrVpcEndpoint(image), releaseTag);
const agentImage = pinConfiguredImage(configuration.require("agentImage"));
const apiImage = pinConfiguredImage(configuration.require("apiImage"));
const webImage = pinConfiguredImage(configuration.require("webImage"));
const listenAddress = configuration.require("listenAddress");
const sandboxNamespace = configuration.require("sandboxNamespace");
const sandboxPoolName = configuration.require("sandboxPoolName");
const persistentVolumeName = configuration.require("persistentVolumeName");
const sandboxClaimTimeout = configuration.require("sandboxClaimTimeout");
const idleTimeout = configuration.require("idleTimeout");
const maxLifetime = configuration.require("maxLifetime");
// 模型服务与部署权限刻意分开：Pulumi 使用 alicloud:profile 的 RAM 凭据建云资源；
// modelApiKey 仅由沙箱里的 Codex 用来请求模型；provider、地址和模型由 Pulumi 配置提供。
const modelAPIKey = configuration.requireSecret("modelApiKey");
const modelProvider = configuration.require("modelProvider");
const modelProviderName = configuration.require("modelProviderName");
const modelBaseURL = configuration.require("modelBaseURL");
const model = configuration.require("model");
// 统一使用内部变量名，避免 Kubernetes Secret 的键随厂商改变；百炼和 DeepSeek 都接受 Bearer API Key。
const modelAPIKeyEnvironment = "MODEL_API_KEY";
// codex-acp 启动后会先询问 ACP 客户端“是否需要登录”。浏览器页面只是把对话转给
// 后端，并不会参与这次认证；因此由沙箱声明使用已注入的 CODEX_API_KEY 完成 API Key
// 登录。没有这项时密钥虽然存在，首个会话仍会被适配器拒绝为 Authentication required。
const defaultCodexAuthentication = JSON.stringify({ methodId: "api-key" });
// 不把 JSON 手写成固定字符串，避免用户只改了模型名，却让恢复会话仍连接旧服务。
const codexConfiguration = pulumi
  .all([
    modelProvider,
    modelProviderName,
    modelBaseURL,
    model,
    modelAPIKeyEnvironment,
  ])
  .apply(
    ([providerID, providerName, baseURL, selectedModel, apiKeyEnvironment]) =>
      JSON.stringify({
        model_provider: providerID,
        model: selectedModel,
        model_providers: {
          [providerID]: {
            name: providerName,
            base_url: baseURL,
            wire_api: "responses",
            env_key: apiKeyEnvironment,
          },
        },
      }),
  );
const warmPoolSize = Number(configuration.require("warmPoolSize"));
// Sandbox Manager 是 ACK 提供的沙箱控制面，不是用户任务本身。它的默认规格较高，
// 不能调度到带有 virtual-kubelet 污点的托管弹性节点；因此演示环境保留一台普通 ECS
// 节点专门承载它和网关。真正的 API、网页与 SandboxSet 仍保持弹性、无状态。
const managerNodeCount = configuration.require("managerNodeCount");
const managerNodeInstanceType = configuration.require("managerNodeInstanceType");
// AgenticFS 的 AccessPoint 是部署前在阿里云侧准备并核验的外部资源；这里读取它的域名和 ID，
// 再由 Pulumi 创建静态 PV，之后每张 Claim 只允许挂该入口的 session 子目录。
const agenticFSAccessPointDomain = configuration.require(
  "agenticFSAccessPointDomain",
);
const agenticFSAccessPointID = configuration.require("agenticFSAccessPointID");

// ============================================================================
// 2. 云端底座：VPC、交换机、ACK 集群和管理节点
// ============================================================================
// VPC 是服务、数据库和沙箱共用的私有网络；只有 ALB 入口对公网开放。
// 后面的 RDS、节点和 Kubernetes 对象都依赖这里，因此 destroy 时它们最后才会被拆除。
const network = new alicloud.vpc.Network("tinyagent-vpc", {
  vpcName: name,
  cidrBlock: "10.60.0.0/16",
});
const applicationSwitch = new alicloud.vpc.Switch("tinyagent-switch", {
  vswitchName: `${name}-application`,
  vpcId: network.id,
  cidrBlock: "10.60.1.0/24",
  zoneId: zoneID,
});
// ALB 是跨两个可用区工作的公网入口。它只承接网页流量，不承载 AgenticFS 数据；
// 因此额外准备 B 区交换机满足入口高可用，节点与沙箱仍只使用上海 F。
const ingressSwitch = new alicloud.vpc.Switch("tinyagent-ingress-switch", {
  vswitchName: `${name}-ingress`,
  vpcId: network.id,
  cidrBlock: "10.60.2.0/24",
  zoneId: "cn-shanghai-b",
});
// ACR 的 VPC endpoint 是账号外部已存在的企业版实例能力；只把当前部署 VPC 绑定进去，
// destroy 时由 Pulumi 解除绑定，不删除 ACR 实例和镜像。PrivateZone 记录让上面的 VPC 域名
// 在 ACK 节点内解析到私网地址，而不是解析到公网 47.x 地址。
const acrVpcEndpoint = new alicloud.cr.VpcEndpointLinkedVpc(
  "tinyagent-acr-vpc-endpoint",
  {
    instanceId: acrInstanceID,
    moduleName: "Registry",
    vpcId: network.id,
    vswitchId: ingressSwitch.id,
    enableCreateDnsRecordInPvzt: true,
  },
);
const cluster = new alicloud.cs.ManagedKubernetes("tinyagent-ack", {
  name,
  clusterSpec: configuration.require("clusterSpec"),
  vswitchIds: [applicationSwitch.id, ingressSwitch.id],
  podVswitchIds: [applicationSwitch.id, ingressSwitch.id],
  // RRSA 让集群组件换取短期 STS 凭据；沙箱镜像和 Secret 中都不保存 RAM 长期密钥。
  enableRrsa: true,
  newNatGateway: true,
  serviceCidr: "172.20.0.0/16",
  addons: [
    { name: "terway-eniip" },
    { name: "csi-plugin" },
    { name: "csi-provisioner" },
    // 由 ACK 创建公网 ALB 和 alb IngressClass；无需手工创建负载均衡实例。
    {
      name: "alb-ingress-controller",
      config: JSON.stringify({
        albIngress: { AddressType: "Internet", CreateDefaultALBConfig: true },
      }),
    },
    // 下面三个是 Agent Sandbox 和 Agent Identity 的控制面。版本和高级开关由 ACK 维护，
    // 实际部署后仍会在验收阶段核对 identityProvider 与 agentTokenDelegation 是否已启用。
    // 沙箱控制器依赖虚拟节点：它把沙箱调度到阿里云托管算力，而不占用业务 ECS 节点。
    { name: "ack-virtual-node" },
    { name: "ack-agent-identity" },
    { name: "ack-agent-sandbox-controller" },
    { name: "ack-sandbox-manager" },
  ],
});
// Agent Sandbox 的 AgenticFS 挂载通过本地 TLS 代理转发到 AccessPoint 的 12049 端口。
// AccessPoint 的内网地址会在同一 vSwitch 内动态分配，因此放行应用 vSwitch 的该端口，
// 避免沙箱领取后因安全组缺少出方向规则而无法完成动态挂载。
const agenticFSTLSEgressRule = new alicloud.ecs.SecurityGroupRule(
  "tinyagent-agenticfs-tls-egress",
  {
    type: "egress",
    securityGroupId: cluster.securityGroupId,
    cidrIp: "10.60.1.0/24",
    ipProtocol: "tcp",
    portRange: "12049/12049",
    policy: "accept",
    priority: 5,
    nicType: "intranet",
    description: "tinyAgent AgenticFS TLS mount",
  },
);
// ACR helper 单独管理，确保它安装完成后再写入 acr-configuration。若把它嵌在
// ManagedKubernetes.addons 里，ACK.RC 可能在 ConfigMapPatch 之后恢复默认配置，导致
// 私有镜像 Pod 没有 imagePullSecret。
const acrCredentialHelperAddon = new alicloud.cs.KubernetesAddon(
  "tinyagent-acr-credential-helper",
  {
    clusterId: cluster.id,
    name: "aliyun-acr-credential-helper",
    config: JSON.stringify({ tokenMode: "managedRole" }),
  },
  { dependsOn: [cluster] },
);
// 这是账户第一次使用 ACK 节点池时缺失的官方服务角色。OOS（云上运维编排服务）用它处理
// 节点的创建与生命周期钩子；写进图纸后，新账号部署不会再卡在控制台的一次性“快速授权”页。
const oosLifecycleRole = new alicloud.ram.Role("ack-oos-lifecycle", {
  roleName: "AliyunOOSLifecycleHook4CSRole",
  description: "ACK 节点池生命周期钩子使用的 OOS 服务角色",
  assumeRolePolicyDocument: JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: { Service: ["oos.aliyuncs.com"] },
      },
    ],
  }),
});
const oosLifecycleRolePolicy = new alicloud.ram.RolePolicyAttachment(
  "ack-oos-lifecycle",
  {
    policyName: "AliyunOOSLifecycleHook4CSRolePolicy",
    policyType: "System",
    roleName: oosLifecycleRole.roleName,
  },
);
// 节点登录密码不是人工使用的入口，只是 ACK 创建节点池时要求提供的初始化凭据。
// 使用随机 Secret 让图纸可重复执行，又不会把可登录密码写进 Git 或命令历史。
const managerNodePassword = new random.RandomPassword(
  "tinyagent-manager-node",
  {
    length: 24,
    special: true,
    minLower: 1,
    minUpper: 1,
    minNumeric: 1,
    minSpecial: 1,
  },
);
// ACK 的 Manager 即使关闭 E2B 鉴权也强制要求这两个字段。密钥仅用于满足组件初始化，
// 不会出现在 Git、日志或 tinyAgent 的业务请求里；Pulumi 将其作为加密 Secret 保存。
const sandboxManagerE2BAdminKey = new random.RandomPassword(
  "tinyagent-sandbox-manager-e2b-key",
  {
    length: 32,
    special: false,
    minLower: 1,
    minUpper: 1,
    minNumeric: 1,
  },
);
const sandboxManagerDomain = configuration.require("sandboxManagerDomain");
const managerNodePool = new alicloud.cs.NodePool(
  "tinyagent-sandbox-manager",
  {
    clusterId: cluster.id,
    nodePoolName: `${name}-sandbox-manager`,
    // AgenticFS 的 AccessPoint 固定在上海 F；控制面也放在相同可用区，避免跨区网络依赖。
    vswitchIds: [applicationSwitch.id],
    instanceTypes: [managerNodeInstanceType],
    instanceChargeType: "PostPaid",
    desiredSize: managerNodeCount,
    // 该 ACK 集群使用 cgroup v2。节点池必须使用与控制面相同的容器优化镜像；
    // 普通 AliyunLinux3/4 会被 ACK 降级成旧镜像，随后在创建时被拒绝。
    imageType: "AliyunLinux3ContainerOptimized",
    systemDiskCategory: "cloud_essd",
    systemDiskPerformanceLevel: "PL0",
    systemDiskSize: 40,
    password: managerNodePassword.result,
    labels: [{ key: "tinyagent.dev/workload", value: "sandbox-manager" }],
    tags: { Project: name, Purpose: "sandbox-manager" },
  },
  { dependsOn: [oosLifecycleRolePolicy] },
);

// ============================================================================
// 3. ACK 集群能力：让沙箱能使用短期身份和托管算力
// ============================================================================
// ACK 在建集群时会安装组件，但不等于启用了 AgenticFS 所需的安全开关。把三个扩展的
// 最小配置作为独立 Pulumi 资源接管：短期令牌由 Identity 签发，Controller 与 Manager
// 都使用该身份链。Manager 默认是 3+3 个高规格副本；演示只保留 1+1，并将单副本
// 控制面降至 4 核/4Gi。这样一台 16 核节点在滚动替换旧副本时仍有余量，不会出现
// “新副本需要先启动、旧副本又不能先退出”的调度死锁。
const agentIdentityAddon = new alicloud.cs.KubernetesAddon(
  "tinyagent-agent-identity",
  {
    clusterId: cluster.id,
    name: "ack-agent-identity",
    version: "0.5.1",
    config: JSON.stringify({ agentTokenDelegation: { enabled: true } }),
  },
  { dependsOn: [managerNodePool] },
);
const sandboxControllerAddon = new alicloud.cs.KubernetesAddon(
  "tinyagent-sandbox-controller",
  {
    clusterId: cluster.id,
    name: "ack-agent-sandbox-controller",
    version: "v0.6.6-release.5",
    config: JSON.stringify({ identityProvider: { enabled: true } }),
  },
  { dependsOn: [agentIdentityAddon] },
);
const sandboxManagerAddon = new alicloud.cs.KubernetesAddon(
  "tinyagent-sandbox-manager-addon",
  {
    clusterId: cluster.id,
    name: "ack-sandbox-manager",
    version: "v0.6.13-release.1",
    // tinyAgent 直接通过集群内网桥接已领取的沙箱，不依赖 Manager 的公网 E2B 入口。
    // 关闭其 TLS 入口，避免它在业务证书签发前向同一 ALB 额外声明一个无证书的 443 监听。
    config: sandboxManagerE2BAdminKey.result.apply((adminAPIKey) =>
      JSON.stringify({
        identityProvider: { enabled: true },
        ingress: {
          className: "alb",
          dataplaneService: "sandbox-gateway",
          tls: false,
        },
        sandboxManager: {
          replicaCount: 1,
          controller: { resources: { cpu: "4", memory: "4Gi" } },
          // tinyAgent 不暴露 E2B 管理 API；对话桥只在集群内访问已领取的沙箱。
          // 关闭未使用的 E2B API Key 鉴权，但保留 ACK 强制要求的域名和随机初始化密钥。
          e2b: {
            domain: sandboxManagerDomain,
            adminApiKey: adminAPIKey,
            enableAuth: false,
          },
        },
        sandboxGateway: { replicaCount: 1 },
      }),
    ),
  },
  { dependsOn: [sandboxControllerAddon] },
);

// ============================================================================
// 4. 数据库、AgenticFS 输入和 Kubernetes Provider
// ============================================================================
// RDS 保存用户在网页上看到的聊天记录；AgenticFS 保存 Codex 恢复会话需要的工作文件。
// 两者用途不同，不能用数据库代替 AgenticFS，也不能把展示消息只放在 AgenticFS。
// RDS、数据库、账号和密码由同一张图纸创建，避免把连接串当成另一个人工前置条件。
// 密码由 Pulumi 的随机资源生成并作为 Secret 保存；密码本身不会显示在 preview、日志或 Git 中。
const databasePassword = new random.RandomPassword("tinyagent-database", {
  length: 24,
  special: false,
  minLower: 1,
  minUpper: 1,
  minNumeric: 1,
});
// RDS PostgreSQL 首次使用也要求两项由服务托管的角色：实例角色负责创建数据库网卡，
// Proxy 角色由 Serverless 的代理能力使用。它们都不是应用账号，也不含数据库密码；Provider
// 有专用资源，因此不应靠控制台手工点一次后让图纸失去可复现性。
const rdsPostgreSQLServiceRole = new alicloud.rds.RdsServiceLinkedRole(
  "tinyagent-rds-postgresql",
  { serviceName: "AliyunServiceRoleForRdsPgsqlOnEcs" },
  // RDS may auto-remove this account-level role after a failed instance create;
  // retaining it in the provider avoids a destroy-time 404 and lets RDS reuse it.
  { retainOnDelete: true },
);
const rdsPostgreSQLProxyServiceRole = new alicloud.rds.RdsServiceLinkedRole(
  "tinyagent-rds-postgresql-proxy",
  { serviceName: "AliyunServiceRoleForRDSProxyOnEcs" },
  { retainOnDelete: true },
);
// 阿里云会先返回服务角色创建成功，再异步把角色传播到 RDS 控制面。
// 让实例的一个无害输入依赖这个等待，避免 CreateDBInstance 过早看到 Role.NotExist。
const rdsServiceLinkedRoleWait = pulumi
  .all([rdsPostgreSQLServiceRole, rdsPostgreSQLProxyServiceRole])
  .apply(async () => {
    const { createDuration } = rdsServiceLinkedRoleWaitOptions();
    const milliseconds = Number.parseInt(createDuration, 10) * 1000;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return 20;
  });
const databaseInstance = new alicloud.rds.Instance(
  "tinyagent-postgresql",
  {
    engine: "PostgreSQL",
    engineVersion: "14.0",
    instanceChargeType: "Serverless",
    category: "serverless_basic",
    instanceType: "pg.n2.serverless.1c",
    instanceStorage: rdsServiceLinkedRoleWait,
    dbInstanceStorageType: "cloud_essd",
    serverlessConfigs: [{ minCapacity: 0.5, maxCapacity: 1, autoPause: false }],
    instanceName: `${name}-postgresql`,
    zoneId: zoneID,
    vswitchId: applicationSwitch.id,
    securityGroupIds: [cluster.securityGroupId],
    deletionProtection: false,
  },
  {
    dependsOn: [rdsPostgreSQLServiceRole, rdsPostgreSQLProxyServiceRole],
  },
);
const database = new alicloud.rds.Database("tinyagent", {
  instanceId: databaseInstance.id,
  dataBaseName: "tinyagent",
  description: "tinyAgent 对话记录",
});
const databaseAccount = new alicloud.rds.Account("tinyagent", {
  dbInstanceId: databaseInstance.id,
  accountName: "tinyagent",
  accountPassword: databasePassword.result,
  accountType: "Normal",
  accountDescription: "tinyAgent 应用账号",
});
const databasePrivilege = new alicloud.rds.AccountPrivilege("tinyagent", {
  instanceId: databaseInstance.id,
  accountName: databaseAccount.accountName,
  dbNames: [database.dataBaseName],
  privilege: "DBOwner",
});
// RDS 位于同一 VPC 内，连接不经过公网；当前演示实例也没有启用 PostgreSQL TLS，
// 因此必须明确关闭客户端 TLS 协商，否则驱动会在应用启动前被服务端拒绝。
const databaseURL = pulumi.interpolate`postgresql://${databaseAccount.accountName}:${databasePassword.result}@${databaseInstance.connectionString}:${databaseInstance.port}/${database.dataBaseName}?sslmode=disable`;

// AgenticFS 是长对话能恢复的第二条腿：数据库保存展示文本和 ACP ID，文件系统保存 Codex rollout。
// 官方 Alibaba Cloud Pulumi provider 目前只接受普通 NAS 的存储类型，不能安全地冒充为
// Agentic；因此此处接收由 AgenticFS 控制台/API 创建并核验过的文件系统 ID，而不是在 plan
// 中塞一个必然被 provider 拒绝的假资源。其余云资源和全部 K8s 资源仍由本图纸统一管理。
const agenticFileSystemID = configuration.require("agenticFileSystemID");
const currentAccount = alicloud.getAccountOutput({});

const credential = alicloud.cs.getClusterCredentialOutput({
  clusterId: cluster.id,
  temporaryDurationMinutes: 60,
});
const kubernetesProvider = new k8s.Provider("tinyagent-ack-provider", {
  kubeconfig: credential.kubeConfig,
  clusterIdentifier: cluster.id,
});
const kubernetesOptions: pulumi.CustomResourceOptions = {
  provider: kubernetesProvider,
  dependsOn: [sandboxManagerAddon],
};
// Kubernetes Provider 是 Pulumi 连接新建 ACK 集群的“遥控器”。这里使用刚创建集群返回的
// 临时 kubeconfig，而不是操作者本机的 kubectl 上下文，避免把资源误部署到别的集群。
//
// ALB 的 HTTP 监听器默认 60 秒没有上下行数据便断开连接。首次领取沙箱要创建动态挂载、
// 拉取镜像并启动 Codex，实测会超过这一分钟；浏览器的 WebSocket 因而会在 Agent 回答前被断开。
// 这里只接管已有默认 AlbConfig 的监听时间，保留 ACK 创建并维护的公网地址和可用区映射。
// 600 秒是当前 ALB 空闲连接时长的最大值，亦低于 API 单个 prompt 15 分钟的业务上限；若用户静默
// 超过十分钟，前端应重连而不是永久占用一条入口连接。
new k8s.apiextensions.CustomResourcePatch(
  "tinyagent-alb-websocket-timeout",
  {
    apiVersion: "alibabacloud.com/v1",
    kind: "AlbConfig",
    metadata: {
      name: "alb",
      // 默认 AlbConfig 的 listeners 字段由 ACK 创建。这里刻意接管同一字段，
      // 否则 Kubernetes 的服务端合并会拒绝写入 idleTimeout，修复无法真正落地。
      annotations: { "pulumi.com/patchForce": "true" },
    },
    spec: {
      config: {
        addressAllocatedMode: "Fixed",
        addressType: "Internet",
        zoneMappings: [
          { vSwitchId: ingressSwitch.id },
          { vSwitchId: applicationSwitch.id },
        ],
      },
      // AlbConfig 一旦声明 listeners，就成为这台 ALB 的监听器唯一事实来源。不能只配置
      // 80 再指望 Ingress 补出 443；有证书时两者必须在这里一起声明，HTTPS 才能落地。
      listeners: [
        { port: 80, protocol: "HTTP", idleTimeout: 600, requestTimeout: 600 },
        ...(certificateID
          ? [
              {
                port: 443,
                protocol: "HTTPS",
                caEnabled: false,
                certificates: [
                  { CertificateId: certificateID, IsDefault: true },
                ],
              },
            ]
          : []),
      ],
    },
  },
  { provider: kubernetesProvider, dependsOn: [cluster] },
);
// Namespace：给 tinyAgent 单独划出的“文件夹”。不把业务对象直接放进 default，
// 是为了让权限、排障和清理范围都更清楚。
const namespace = new k8s.core.v1.Namespace(
  "tinyagent",
  { metadata: { name: sandboxNamespace } },
  kubernetesOptions,
);
// ServiceAccount：Pod 使用的身份。API Pod 会用它向 Kubernetes 创建/回收沙箱对象。
const serviceAccount = new k8s.core.v1.ServiceAccount(
  "tinyagent-api",
  { metadata: { namespace: namespace.metadata.name, name: "tinyagent-api" } },
  { provider: kubernetesProvider },
);

// 免密拉取组件自己的 ConfigMap 在 kube-system。只补上 tinyAgent 这个业务命名空间和
// 当前 ACR 实例，既不会影响集群系统组件，也让新建的 API ServiceAccount 立即得到临时凭据。
const acrPullConfiguration = new k8s.core.v1.ConfigMapPatch(
  "tinyagent-acr-pull-configuration-v2",
  {
    metadata: {
      namespace: "kube-system",
      name: "acr-configuration",
      annotations: { "pulumi.com/patchForce": "true" },
    },
    data: {
      "service-account": "*",
      "watch-namespace": sandboxNamespace,
      "expiring-threshold": "15m",
      "acr-registry-info": `- instanceId: "${acrInstanceID}"
  regionId: "cn-shanghai"
  domains: "${acrVpcRegistryDomain}"`,
    },
  },
  {
    provider: kubernetesProvider,
    dependsOn: [cluster, acrVpcEndpoint, acrCredentialHelperAddon],
  },
);

// ACK Sandbox Manager 的内部入口由 Addon 自己通过 Helm 异步创建。它默认同时声明 80/443，
// 但 demo 的共享 ALB 在证书签发前只有 80；因此上面的 Addon 配置已经关闭 TLS。
// 不要再用 IngressPatch 抢先修改这个 Helm 对象：Addon “创建完成”不代表 Ingress 已存在，
// 空 Patch 可能被 Kubernetes 当成新建空 Ingress，触发“必须有 rules/defaultBackend”的校验。
// tinyAgent 直接通过集群内网连接已领取沙箱的桥，这个内部管理入口不在对话数据路径上。

// ============================================================================
// 5. Kubernetes 基础对象、存储身份和最小权限
// ============================================================================
// 这一层必须在应用前创建；destroy 时则会在应用退出后才删除。
//
// 先记住两层权限：
// 1. RAM Role/Policy 规定“这个项目最多能访问哪块 AgenticFS”。
// 2. AgentIdentity/CredentialProvider 再规定“某张 SandboxClaim 这次只能拿哪个 AccessPoint”。
//
// 这比把长期 RAM AccessKey 放进镜像或 Kubernetes Secret 安全得多：RRSA 会换取短期凭据。
const agenticFSRAMRole = new alicloud.ram.Role("tinyagent-agenticfs", {
  roleName: `${name}-agenticfs`,
  maxSessionDuration: 43200,
  description: "tinyAgent 沙箱通过 RRSA 取得 AgenticFS 短期凭据",
  assumeRolePolicyDocument: cluster.rrsaMetadata.apply((metadata) =>
    JSON.stringify({
      Version: "1",
      Statement: [
        {
          Effect: "Allow",
          Action: "sts:AssumeRole",
          Principal: { Federated: [metadata.ramOidcProviderArn] },
          Condition: {
            StringEquals: {
              "oidc:aud": "sts.aliyuncs.com",
              "oidc:iss": metadata.rrsaOidcIssuerUrl,
              "oidc:sub": [
                "system:serviceaccount:ack-agent-identity:credential-provider",
              ],
            },
          },
        },
      ],
    }),
  ),
});
const agenticFSRAMPolicy = new alicloud.ram.Policy("tinyagent-agenticfs", {
  policyName: `${name}-agenticfs`,
  description: "tinyAgent AgenticFS 最大权限边界",
  policyDocument: pulumi
    .all([currentAccount.id, agenticFileSystemID])
    .apply(([accountID, fileSystemID]) =>
      JSON.stringify({
        Version: "1",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "nas:ClientMount",
              "nas:ClientWrite",
              "nas:ClientRootAccess",
            ],
            Resource: `acs:nas:${region}:${accountID}:filesystem/${fileSystemID}`,
          },
        ],
      }),
    ),
});
const agenticFSRAMPolicyAttachment = new alicloud.ram.RolePolicyAttachment(
  persistentVolumeName,
  {
    policyName: agenticFSRAMPolicy.policyName,
    policyType: "Custom",
    roleName: agenticFSRAMRole.roleName,
  },
);

// PV 是“存储插座”，它本身不复制数据，只把 Kubernetes 的挂载请求接到外部 AgenticFS。
// `Retain` 表示删掉 PV 后不自动清空外部文件，避免销毁演示环境时顺手抹掉 Codex 会话。
new k8s.core.v1.PersistentVolume(
  "tinyagent-agenticfs",
  {
    metadata: {
      name: persistentVolumeName,
      labels: { "alicloud-pvname": persistentVolumeName },
      annotations: {
        "storage.tinyagent.dev/file-system-id": agenticFileSystemID,
        "storage.tinyagent.dev/access-point-id": agenticFSAccessPointID,
      },
    },
    spec: {
      capacity: { storage: "10Gi" },
      accessModes: ["ReadWriteMany"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: persistentVolumeName,
      volumeMode: "Filesystem",
      csi: {
        driver: "nasplugin.csi.alibabacloud.com",
        volumeHandle: persistentVolumeName,
        volumeAttributes: {
          authType: "agent-identity",
          mountProtocol: "alinas",
          server: agenticFSAccessPointDomain,
          path: "/",
          options: "nolock,tcp,noresvport,tls,ram,vers=3",
        },
      },
    },
  },
  { provider: kubernetesProvider },
);

// 这四个对象把“哪种沙箱”与“能取哪种短期凭据”连成一条链。它们由 ACK 的
// ack-agent-identity 扩展提供；扩展未安装时 Pulumi 会明确失败，而不是降级回长期密钥。
const agentIdentity = new k8s.apiextensions.CustomResource(
  "tinyagent-storage-agent",
  {
    apiVersion: "agentidentity.alibabacloud.com/v1alpha1",
    kind: "AgentIdentity",
    metadata: {
      namespace: namespace.metadata.name,
      name: "tinyagent-storage-agent",
    },
    spec: { description: "tinyAgent AgenticFS 存储挂载身份" },
  },
  { provider: kubernetesProvider },
);
// CredentialProvider 的有效权限必须是上面 RAM 角色最大权限的子集。不能写 filesystem/*：
// 虽有 AccessPoint 条件，看上去仍像“任意文件系统”，STS 会拒绝下发比角色边界更宽的令牌。
const credentialProvider = new k8s.apiextensions.CustomResource(
  "agenticfs-read-write",
  {
    apiVersion: "agentidentity.alibabacloud.com/v1alpha1",
    kind: "CredentialProvider",
    metadata: {
      namespace: namespace.metadata.name,
      name: "agenticfs-read-write",
    },
    spec: {
      type: "RAM",
      ram: {
        source: {
          provider: "RRSA",
          rrsa: {
            roleName: agenticFSRAMRole.roleName,
            tokenValidity: "1h",
            policy: pulumi
              .all([currentAccount.id, agenticFileSystemID])
              .apply(([accountID, fileSystemID]) =>
                JSON.stringify({
                  Version: "1",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: [
                        "nas:ClientMount",
                        "nas:ClientWrite",
                        "nas:ClientRootAccess",
                      ],
                      Resource: `acs:nas:${region}:${accountID}:filesystem/${fileSystemID}`,
                      Condition: {
                        StringEquals: {
                          "nas:AccessPointArn": [
                            `acs:nas:${region}:${accountID}:accesspoint/\${ack:agent-identity/storage-auth/nas-ap-id}`,
                          ],
                        },
                      },
                    },
                  ],
                }),
              ),
          },
        },
      },
    },
  },
  { provider: kubernetesProvider, dependsOn: [agenticFSRAMPolicyAttachment] },
);
const agentRole = new k8s.apiextensions.CustomResource(
  "tinyagent-agenticfs-storage-role",
  {
    apiVersion: "agentidentity.alibabacloud.com/v1alpha1",
    kind: "AgentRole",
    metadata: {
      namespace: namespace.metadata.name,
      name: "tinyagent-agenticfs-storage-role",
    },
    spec: {
      rules: [
        {
          effect: "Allow",
          action: "GetResourceCredential",
          resource: "CredentialProvider/agenticfs-read-write",
        },
      ],
    },
  },
  { provider: kubernetesProvider, dependsOn: [credentialProvider] },
);
new k8s.apiextensions.CustomResource(
  "tinyagent-agenticfs-storage-binding",
  {
    apiVersion: "agentidentity.alibabacloud.com/v1alpha1",
    kind: "AgentRoleBinding",
    metadata: {
      namespace: namespace.metadata.name,
      name: "tinyagent-agenticfs-storage-binding",
    },
    spec: {
      agentRoleRef: {
        apiGroup: "agentidentity.alibabacloud.com",
        kind: "AgentRole",
        name: "tinyagent-agenticfs-storage-role",
      },
      subjects: [
        {
          authorizationType: "Agent",
          agentAuthorizationConfiguration: {
            agentName: "tinyagent-storage-agent",
          },
        },
      ],
    },
  },
  { provider: kubernetesProvider, dependsOn: [agentIdentity, agentRole] },
);
const secret = new k8s.core.v1.Secret(
  "tinyagent-secrets",
  {
    metadata: { namespace: namespace.metadata.name },
    stringData: {
      DATABASE_URL: databaseURL,
      MODEL_API_KEY: modelAPIKey,
      CODEX_API_KEY: modelAPIKey,
      CODEX_CONFIG: codexConfiguration,
    },
  },
  { provider: kubernetesProvider, dependsOn: [databasePrivilege] },
);

// 下面这组 RBAC 对象是 API Pod 的最小工作权限：它只能查看、创建和删除沙箱相关对象，
// 不能任意读取集群 Secret、修改 Deployment 或操作其他命名空间的资源。
// RoleBinding 的 roleRef 必须和真实 Role 名逐字一致。不给 Role 固定名称时 Pulumi 会
// 自动附加随机后缀，手写 "tinyagent-sandbox" 会生成一个指向不存在对象的绑定，API Pod
// 看似有 ServiceAccount、实际却无法创建 SandboxClaim。显式命名并引用资源输出可同时避免
// 首次部署和后续替换时的名称漂移。
const sandboxRole = new k8s.rbac.v1.Role(
  "tinyagent-sandbox",
  {
    metadata: { namespace: namespace.metadata.name, name: "tinyagent-sandbox" },
    rules: [
      {
        apiGroups: ["agents.kruise.io"],
        resources: ["sandboxclaims", "sandboxes", "sandboxsets"],
        verbs: ["get", "list", "create", "delete"],
      },
    ],
  },
  { provider: kubernetesProvider },
);
new k8s.rbac.v1.RoleBinding(
  "tinyagent-sandbox",
  {
    metadata: { namespace: namespace.metadata.name },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: sandboxRole.metadata.name,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: serviceAccount.metadata.name,
        namespace: namespace.metadata.name,
      },
    ],
  },
  { provider: kubernetesProvider, dependsOn: [sandboxRole] },
);

// ============================================================================
// 6. 业务应用与公网入口：网页、API 和唯一的 ALB 路由
// ============================================================================
// Deployment 负责让容器持续运行；Service 给 Deployment 提供稳定的集群内地址；
// Ingress 再把公网域名和路径映射到 Service。浏览器永远只访问 ALB，不直接访问 Pod IP。
const apiLabels = { app: "tinyagent-api" };
const acrCredentialConfigVersion = "v2";
const virtualNodeLabels = {
  "alibabacloud.com/acs": "true",
  "alibabacloud.com/compute-class": "general-purpose",
  "alibabacloud.com/compute-qos": "default",
};
// API：接收网页请求、保存消息、领取沙箱并转发 ACP 对话。
new k8s.apps.v1.Deployment(
  "tinyagent-api",
  {
    metadata: { namespace: namespace.metadata.name },
    spec: {
      replicas: 1,
      selector: { matchLabels: apiLabels },
      template: {
        metadata: {
          annotations: {
            "tinyagent.dev/acr-credential-config": acrCredentialConfigVersion,
            "tinyagent.dev/release": releaseTag,
          },
          labels: { ...apiLabels, ...virtualNodeLabels },
        },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          dnsPolicy: "Default",
          containers: [
            {
              name: "api",
              image: apiImage,
              imagePullPolicy: "Always",
              ports: [{ containerPort: 8080 }],
              envFrom: [{ secretRef: { name: secret.metadata.name } }],
              env: [
                { name: "LISTEN_ADDRESS", value: listenAddress },
                { name: "SANDBOX_NAMESPACE", value: sandboxNamespace },
                { name: "SANDBOX_POOL_NAME", value: sandboxPoolName },
                { name: "AGENTICFS_PV_NAME", value: persistentVolumeName },
                { name: "SANDBOX_CLAIM_TIMEOUT", value: sandboxClaimTimeout },
                { name: "IDLE_TIMEOUT", value: idleTimeout },
                { name: "MAX_LIFETIME", value: maxLifetime },
              ],
              readinessProbe: { httpGet: { path: "/healthz", port: 8080 } },
            },
          ],
        },
      },
    },
  },
  { provider: kubernetesProvider, dependsOn: [acrPullConfiguration] },
);
// Service 的 80 端口只是在集群内提供稳定入口，真正的容器端口仍是 8080。
const apiService = new k8s.core.v1.Service(
  "tinyagent-api",
  {
    metadata: { namespace: namespace.metadata.name },
    spec: { selector: apiLabels, ports: [{ port: 80, targetPort: 8080 }] },
  },
  { provider: kubernetesProvider },
);
const webLabels = { app: "tinyagent-web" };
// Web：只负责提供聊天页面静态资源。
new k8s.apps.v1.Deployment(
  "tinyagent-web",
  {
    metadata: { namespace: namespace.metadata.name },
    spec: {
      replicas: 1,
      selector: { matchLabels: webLabels },
      template: {
        metadata: {
          annotations: {
            "tinyagent.dev/acr-credential-config": acrCredentialConfigVersion,
            "tinyagent.dev/release": releaseTag,
          },
          labels: { ...webLabels, ...virtualNodeLabels },
        },
        spec: {
          dnsPolicy: "Default",
          containers: [
            {
              name: "web",
              image: webImage,
              imagePullPolicy: "Always",
              ports: [{ containerPort: 8080 }],
              readinessProbe: { httpGet: { path: "/", port: 8080 } },
            },
          ],
        },
      },
    },
  },
  { provider: kubernetesProvider, dependsOn: [acrPullConfiguration] },
);
const webService = new k8s.core.v1.Service(
  "tinyagent-web",
  {
    metadata: { namespace: namespace.metadata.name },
    spec: { selector: webLabels, ports: [{ port: 80, targetPort: 8080 }] },
  },
  { provider: kubernetesProvider },
);
// Ingress：ALB 根据域名和路径转发请求：
// - /api、/ws → API Service；
// - / → Web Service。
// ALB 根据 tls.hosts 在证书管理服务中匹配这个域名的证书。证书尚未签发时保留 HTTP，
// 使 Pulumi 首次建底座不被证书流程卡住；一旦填入 certificateID，入口立即只允许 HTTPS。
const ingressAnnotations: Record<string, string> = {
  // 沙箱管理组件也共用这台 ALB，并会在尚无证书时反复尝试创建自己的 443 监听器。
  // 它的重试不应让已提交的 tinyAgent Ingress 永远停在 Pulumi 的“等待就绪”阶段；
  // 发布完成后由部署手册中的 HTTP/HTTPS 探针验收真实可达性，而不是把等待关掉后当作成功。
  "pulumi.com/skipAwait": "true",
  ...(certificateID
    ? {
        "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP":80},{"HTTPS":443}]',
        "alb.ingress.kubernetes.io/ssl-redirect": "true",
        "alb.ingress.kubernetes.io/certificate-id": certificateID,
      }
    : { "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP":80}]' }),
};
const ingress = new k8s.networking.v1.Ingress(
  "tinyagent",
  {
    metadata: {
      namespace: namespace.metadata.name,
      annotations: ingressAnnotations,
    },
    spec: {
      ingressClassName: "alb",
      rules: [
        {
          host: domain,
          http: {
            paths: [
              {
                path: "/api",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: apiService.metadata.name,
                    port: { number: 80 },
                  },
                },
              },
              {
                path: "/ws",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: apiService.metadata.name,
                    port: { number: 80 },
                  },
                },
              },
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: webService.metadata.name,
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: certificateID ? [{ hosts: [domain] }] : undefined,
    },
  },
  { provider: kubernetesProvider },
);

// ============================================================================
// 7. 沙箱预热池：应用最后依赖的工作负载，也是 destroy 最先回收的一层
// ============================================================================
// SandboxSet 是“沙箱池”的声明：保持 warmPoolSize 台空闲沙箱。
// API 收到请求时创建 SandboxClaim，控制器把一台空闲沙箱分配给它；领取后池子自动补货。
//
// 沙箱跑在 ACK 的虚拟节点/托管算力上，不跑在承载 Sandbox Manager 的普通 ECS 节点上。
// Sandbox Pod 关闭 ServiceAccount Token，因为它不需要调用 Kubernetes API。
new k8s.apiextensions.CustomResource(
  sandboxPoolName,
  {
    apiVersion: "agents.kruise.io/v1alpha1",
    kind: "SandboxSet",
    metadata: { namespace: namespace.metadata.name, name: sandboxPoolName },
    spec: {
      replicas: warmPoolSize,
      // `scaleStrategy` 保持为空，使用 ACK 对预热池扩缩容的默认语义。
      // `maxUnavailable` 是滚动升级专用字段，放在这里会让领取期间的池子反复重建，
      // 反而拿不到已预热的实例。
      scaleStrategy: {},
      runtimes: [{ name: "csi" }, { name: "agent-runtime" }],
      template: {
        metadata: {
          annotations: {
            "network.alibabacloud.com/wait-clusterip-ready": "*",
            "tinyagent.dev/acr-credential-config": acrCredentialConfigVersion,
            "tinyagent.dev/release": releaseTag,
          },
          labels: {
            "alibabacloud.com/acs": "true",
            "alibabacloud.com/compute-class": "agent-sandbox",
            "compute-qos": "default",
          },
        },
        spec: {
          automountServiceAccountToken: false,
          dnsPolicy: "ClusterFirst",
          containers: [
            {
              name: "agent",
              image: agentImage,
              // 不用 mutable 标签的强制重拉策略拖慢每次预热；发布镜像时应改为不可变 tag，更新 SandboxSet。
              // 演示镜像使用 :demo 这个可变标签。预热池每次补货都必须检查仓库，
              // 否则虚拟节点会复用旧缓存，代码已经发布但新沙箱仍在运行旧版桥和入口脚本。
              imagePullPolicy: "Always",
              env: [
                { name: "AGENT_CMD", value: "codex-acp" },
                // 预热沙箱尚未领取时没有动态卷；桥接程序会在每次连接时等待
                // Claim 完成并确认两个 AgenticFS 挂载点可见，再启动 ACP。
                { name: "REQUIRE_AGENTICFS_MOUNTS", value: "1" },
                {
                  name: "MODEL_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: "MODEL_API_KEY",
                    },
                  },
                },
                {
                  name: "CODEX_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: "CODEX_API_KEY",
                    },
                  },
                },
                {
                  name: "CODEX_CONFIG",
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: "CODEX_CONFIG",
                    },
                  },
                },
                {
                  name: "DEFAULT_AUTH_REQUEST",
                  value: defaultCodexAuthentication,
                },
                { name: "MODEL_PROVIDER", value: modelProvider },
                { name: "NO_BROWSER", value: "1" },
              ],
            },
          ],
        },
      },
    },
  },
  {
    provider: kubernetesProvider,
    dependsOn: [secret, credentialProvider, acrPullConfiguration],
  },
);

// ============================================================================
// 8. 输出：供部署者和其他自动化工具读取，不要随意改名
// ============================================================================
export const clusterID = cluster.id;
export const kubernetesNamespace = namespace.metadata.name;
export { agenticFileSystemID };
export const apiServiceName = apiService.metadata.name;
export const applicationDomain = domain;
export const applicationIngressName = ingress.metadata.name;
export const databaseInstanceID = databaseInstance.id;
