# 更新日志

本文件记录本项目的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-09-22

### 变更

- 镜像改为同时发布 `linux/amd64` 与 `linux/arm64`，ARM 云主机与 64 位系统的树莓派可直接拉取。32 位 ARM 无现成镜像，Node 自 24 起不再发布该架构，需要的话可改用 `node:22-alpine` 自行构建。

## [1.0.0] - 2026-09-22

首个公开发布版本。

### 功能

- 将节点分享链接转换为 sing-box 出站配置，支持 vless、vmess、trojan、shadowsocks、hysteria、hysteria2、tuic、anytls、socks、http。
- 支持订阅链接，可识别 base64 编码的分享链接列表与 Shadowsocks SIP008 两种格式。拉取订阅使用的 User-Agent 可用 `SUBSCRIPTION_USER_AGENT` 指定，默认取值使机场返回分享链接格式。
- 出站字段严格遵循 sing-box 的类型与结构要求，生成的配置在对应版本上可直接加载。
- 按来源自动分组生成 selector，并挂载到模版的 `GLOBAL` 与 `AUTO` 出站。
- 内置模版按 sing-box 版本分别维护，通过 `singbox` 参数选取，当前覆盖 1.11 ~ 1.14。
- 按目标 sing-box 版本裁剪节点：目标版本不支持的协议（如 anytls 需要 1.12 及以上）会被跳过并记入日志，不会生成无法加载的配置。
- 节点标签自动去重。sing-box 要求出站标签全局唯一，重名节点、不同来源的同名节点、以及与模版内置出站同名的节点会被追加序号。
- 单个节点解析失败不影响其余节点，格式错误的链接会被跳过并记入日志，订阅中混入坏链接时仍能生成可用配置。
- 支持自定义配置模版，启动时校验模版是否包含 `GLOBAL` 与 `AUTO` 出站。
- 没有任何可用节点时返回 400，避免下发一份节点为空、导入后无法使用的配置。
- 节点配置放置于 `profiles/`、配置模版放置于 `templates/`，位置可用环境变量 `PROFILE_DIR`、`TEMPLATE_DIR` 覆盖。
- 配置文件名限定为字母、数字、下划线和连字符，不接受路径。
- 可选的访问令牌：设置环境变量 `TOKEN` 后，请求须带 `token` 参数，否则返回 403。默认不校验。
- 拉取订阅时限制超时、响应大小、订阅数量与重定向次数，并默认拒绝指向私有网段的地址，重定向的每一跳都重新校验。局域网自建订阅可用 `ALLOW_PRIVATE_NETWORK=1` 放行。

### 运行环境

- 镜像基于 `node:24-alpine`，以非 root 用户运行，处理 `SIGTERM` / `SIGINT`。
- 零运行时依赖，仅需 Node.js 24 及以上。

### 安全

- 配置文件名经白名单校验，不接受路径，无法读取目录外的文件。
- 镜像不包含 `profiles/`、`templates/` 中的任何内容。
