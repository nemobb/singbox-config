# singbox-config

[![GitHub](https://img.shields.io/badge/GitHub-nemobb%2Fsingbox--config-181717?logo=github)](https://github.com/nemobb/singbox-config)
[![Docker Pulls](https://img.shields.io/docker/pulls/nemobb/singbox-config?logo=docker)](https://hub.docker.com/r/nemobb/singbox-config)
[![License](https://img.shields.io/github/license/nemobb/singbox-config)](https://github.com/nemobb/singbox-config/blob/main/LICENSE)

singbox config generate

将机场订阅链接、节点分享链接转换成完整的 sing-box 客户端配置。零依赖，仅需 Node.js。

源码与问题反馈：<https://github.com/nemobb/singbox-config>

### 目录结构

```
defaults/     内置的默认节点配置与配置模版，属于程序的一部分
profiles/     节点配置，对应 ?profile= 参数
templates/    配置模版，对应 ?template= 参数
```

`profiles/` 和 `templates/` 是挂载点，与 `defaults/` 物理隔离，挂载不会覆盖内置文件。
文件名只允许字母、数字、下划线和连字符，长度不超过 64。

两个目录的位置可以用环境变量 `PROFILE_DIR`、`TEMPLATE_DIR` 覆盖。

### 节点配置

在 `profiles/` 下放置配置文件，例如 `profiles/hello.json`：

```json
{
  "custom": {
    "name": "CustomName",
    "nodes": [
      "vless://uuid@host:port?encryption=none&flow=xtls-rprx-vision&security=tls&sni=sni&fp=chrome&type=tcp&headerType=none#Remark"
    ]
  },
  "subscriptions": [
    {
      "name": "GroupName",
      "url": "https://domain/path"
    }
  ]
}
```

- `custom.name` 和 `subscriptions[].name` 用于节点分组，会成为配置中的 selector 名称
- `custom.nodes` 填写节点分享链接
- `subscriptions[].url` 填写订阅链接

支持的协议：`vless`、`vmess`、`trojan`、`shadowsocks`、`hysteria`、`hysteria2`、`tuic`、`anytls`、`socks`、`http`。其中 `anytls` 需要 sing-box 1.12 及以上，指定更低版本时该类节点会被跳过。

订阅链接需返回以下两种格式之一：

- **base64 编码的分享链接列表**，每行一条，最常见
- **Shadowsocks SIP008** 的 JSON 格式

节点标签（链接 `#` 后的备注）会自动去重，重名节点、以及与模版内置出站同名的节点会被追加序号——sing-box 要求出站标签全局唯一，否则整份配置无法加载。

### sing-box 版本

sing-box 各版本的配置互不兼容，新版本的特性旧版本无法识别。因此内置模版按版本分别维护，请求时用 `singbox` 参数指定自己使用的版本：

```bash
curl "http://localhost:5300/api/singbox?profile=hello&singbox=1.14"
```

| `singbox` 参数 | 使用的内置模版 |
| --- | --- |
| `1.11` | `defaults/template-v111.json` |
| `1.12` | `defaults/template-v113.json` |
| `1.13` | `defaults/template-v113.json` |
| `1.14` | `defaults/template-v114.json` |

参数接受 `1.14`、`v1.14`、`1.14.1` 等写法，按主次版本号匹配。不传时使用 `defaults/versions.json` 中 `default` 指定的版本，**建议始终显式指定**，否则可能拿到当前 sing-box 无法加载的配置。传入不支持的版本会返回 400 并列出支持的版本。

### 配置模版

模版就是一份**不含节点的 sing-box 配置**，节点在请求时才被注入进去。

**从内置模版复制一份开始改**，选与自己 sing-box 版本对应的那个（见上表）：

```bash
cp defaults/template-v114.json templates/mytpl.json
```

之后用 `?template=mytpl` 指定。注意此时 `singbox` 参数不再生效——模版与 sing-box 版本的对应关系由你自己负责。

#### outbounds 必须保留这三项

内置模版的 `outbounds` 只有三个条目，**它们是注入机制的挂载点，不要删除或改名**：

```json
"outbounds": [
  { "type": "direct", "tag": "direct-out" },
  { "type": "selector", "tag": "GLOBAL", "outbounds": ["AUTO"], "default": "AUTO" },
  { "type": "urltest", "tag": "AUTO", "outbounds": [] }
]
```

| tag | 作用 |
| --- | --- |
| `GLOBAL` | 总出口，`route.final` 指向它。每个节点分组的名字会被追加进它的 `outbounds` |
| `AUTO` | 自动测速组，**`outbounds` 必须留空**。所有节点的 tag 会被追加进来 |
| `direct-out` | 直连出口，路由规则里的分流目标。改名的话，`route.rules` 里所有引用都要跟着改 |

这两个出站缺失时**不会报错**，请求照常返回 200：

- 缺 `AUTO`：节点不会进入自动测速组
- 缺 `GLOBAL`：分组不会挂载到总出口，而 `route.final` 仍指向 `GLOBAL`，配置能通过 `sing-box check`、也能导入客户端，但实际运行时流量无处可去

服务**启动时**会扫描 `templates/` 并对缺少这两个出站的模版打出告警：

```
template "mytpl.json" missing outbound tag: AUTO, node groups will not be injected
```

注意这个扫描只在启动时执行一次，启动之后新放进 `templates/` 的模版不会被检查。改完模版重启一次容器，看一眼启动日志最稳妥。

#### 注入后的样子

假设配置里有一个名为「我的机场」的分组，含两个节点，生成的 `outbounds` 是：

```json
[
  { "type": "direct",   "tag": "direct-out" },
  { "type": "selector", "tag": "GLOBAL", "outbounds": ["AUTO", "我的机场"], "default": "AUTO" },
  { "type": "urltest",  "tag": "AUTO",   "outbounds": ["香港01", "日本01"] },
  { "type": "shadowsocks", "tag": "香港01" },
  { "type": "shadowsocks", "tag": "日本01" },
  { "type": "selector", "tag": "我的机场", "outbounds": ["香港01", "日本01"], "default": "香港01" }
]
```

即：每个分组生成一个同名 selector，分组名进 `GLOBAL`，所有节点进 `AUTO`。多个分组就重复这个过程。

#### 其余部分可以自由修改

`dns`、`inbounds`、`route`、`experimental` 等都可以按需改动，常见的定制有：

- `route.rules` 调整分流策略，`route.rule_set` 增删规则集
- `inbounds` 调整 tun 的网段、MTU、`stack` 等参数，或增加 `mixed` 入站以提供本地代理端口
- `experimental.clash_api` 改面板端口

只要保证路由规则引用的出站 tag 确实存在即可。可以先用 sing-box 自带的命令验证：

```bash
sing-box check -c <生成的配置>
```

### 在 docker 中运行

镜像提供 `linux/amd64` 和 `linux/arm64` 两种架构，`docker pull` 会自动选取匹配的一份，x86 服务器、ARM 云主机、64 位系统的树莓派都可直接使用。

32 位 ARM（armv6 / armv7，例如装了 32 位系统的树莓派）没有现成镜像——Node 自 24 起不再发布这两个架构。这类设备可以把 [Dockerfile](Dockerfile) 的基础镜像改成 `node:22-alpine` 后自行构建。

```bash
# 不挂载任何文件，通过 /api/singbox/sub 的请求参数传入订阅链接
docker run -d -p 5300:5300 nemobb/singbox-config:latest

# 挂载本地节点配置与模版，建议以只读方式挂载
docker run -d -p 5300:5300 \
  -v ~/singbox/profiles:/app/profiles:ro \
  -v ~/singbox/templates:/app/templates:ro \
  nemobb/singbox-config:latest

# 只挂载单个配置文件
docker run -d -p 5300:5300 \
  -v ~/hello.json:/app/profiles/hello.json:ro \
  nemobb/singbox-config:latest

# 通过 -e 传入环境变量，FETCH_TIMEOUT 单位是毫秒，20000 即 20 秒
docker run -d -p 5300:5300 \
  -v ~/singbox/profiles:/app/profiles:ro \
  -e TOKEN=your-secret \
  -e FETCH_TIMEOUT=20000 \
  nemobb/singbox-config:latest
```

### 在 docker compose 中运行

```yaml
services:
  singbox-config:
    image: nemobb/singbox-config:latest
    container_name: singbox-config
    restart: unless-stopped
    ports:
      - "5300:5300"
    volumes:
      - ./profiles:/app/profiles:ro
      - ./templates:/app/templates:ro
    environment:
      # 暴露到公网时务必设置
      - TOKEN=your-secret
      # 机场按 User-Agent 返回的不是分享链接时，改成机场支持的取值
      # - SUBSCRIPTION_USER_AGENT=v2rayNG/1.9.16
      # 仅在服务只对可信内网开放、且订阅托管在局域网时才开启
      # - ALLOW_PRIVATE_NETWORK=1
```

上面只列了常用的几项，其余变量都有合理默认值，通常不需要设置。完整清单见下文[环境变量](#环境变量)。

### 获取配置文件

服务启动后通过 `http://localhost:5300` 访问。

节点来源有两种，二选一：

| 请求 | 节点来源 |
| --- | --- |
| `/api/singbox/sub?name=${groupName}&url=${sub}` | 参数中的订阅链接。`name` 和 `url` 按顺序配对，可重复传入多组，值需要用 `encodeURIComponent` 编码 |
| `/api/singbox?profile=hello` | `profiles/hello.json` |

在此基础上可附加：

| 参数 | 说明 |
| --- | --- |
| `singbox=1.14` | 选用对应 sing-box 版本的内置模版，不传则用 `defaults/versions.json` 里 `default` 指定的版本 |
| `template=mytpl` | 改用 `templates/mytpl.json`，此时 `singbox` 不再生效 |
| `token=xxx` | 设置了 `TOKEN` 环境变量时必传 |

```bash
# 直接用订阅链接生成，无需任何配置文件
curl "http://localhost:5300/api/singbox/sub?name=MyAirport&url=https%3A%2F%2Fdomain%2Fpath&singbox=1.14"

# 使用 profiles/hello.json
curl "http://localhost:5300/api/singbox?profile=hello&singbox=1.14"

# 使用自定义模版
curl "http://localhost:5300/api/singbox?profile=hello&template=mytpl"

# 设置了 TOKEN 时
curl "http://localhost:5300/api/singbox?profile=hello&singbox=1.14&token=your-secret"
```

把其中一条地址填进 sing-box 客户端的远程配置即可。

> [!NOTE]
> 不带 `profile` 参数访问 `/api/singbox` 会使用 `defaults/config.json`。那份文件是构建时的校验用例，节点全部指向 `example.com`，**导入客户端不会有任何可用节点**。节点配置的写法见上文[节点配置](#节点配置)。
>
> 当所有节点都不可用时（订阅拉取失败、节点全部解析失败、或协议不被目标 sing-box 版本支持）会返回 400 `no available node`，具体原因见服务端日志。

### 更新到新版本

镜像在本地是缓存的，`docker compose up -d` 不会自动拉取新版本，需要显式拉取后重建容器。

```bash
# docker compose
docker compose pull && docker compose up -d

# docker run
docker pull nemobb/singbox-config:latest
docker rm -f <容器名>   # 再用原来的参数重新 run
```

各版本的变更见 [CHANGELOG](https://github.com/nemobb/singbox-config/blob/main/CHANGELOG.md)。如果希望固定在某个版本，把 `latest` 换成具体的版本号即可，例如 `nemobb/singbox-config:1.0.0`。

### 访问控制

设置环境变量 `TOKEN` 后，所有请求都必须带上 `token` 参数才会被受理，否则返回 403。

```bash
docker run -d -p 5300:5300 -e TOKEN=your-secret nemobb/singbox-config:latest
curl "http://localhost:5300/api/singbox?profile=hello&token=your-secret"
```

不设置 `TOKEN` 时不做校验。**将服务暴露到公网时请务必设置**，否则任何能访问该端口的人都可以取得配置中的节点信息。

### 环境变量

| 变量 | 默认值 | 单位 | 说明 |
| --- | --- | --- | --- |
| `TOKEN` | 空 | | 访问令牌，为空时不校验 |
| `PROFILE_DIR` | `./profiles` | | 节点配置目录，docker 中请改用挂载 |
| `TEMPLATE_DIR` | `./templates` | | 配置模版目录，docker 中请改用挂载 |
| `FETCH_TIMEOUT` | `10000`，即 10 秒 | 毫秒 | 拉取单个订阅的超时时间 |
| `MAX_SUBSCRIPTION_SIZE` | `2097152`，即 2 MiB | 字节 | 单个订阅响应的大小上限 |
| `MAX_SUBSCRIPTIONS` | `10` | 个 | 单次请求处理的订阅数量上限，超出部分忽略 |
| `SUBSCRIPTION_USER_AGENT` | `v2rayN/6.45` | | 拉取订阅时使用的 User-Agent，见下 |
| `ALLOW_PRIVATE_NETWORK` | 未设置 | | 设为 `1` 时允许订阅地址指向私有网段，**公网暴露时不要开启**，见下 |

常用换算：

| 想设置 | `FETCH_TIMEOUT` | | 想设置 | `MAX_SUBSCRIPTION_SIZE` |
| --- | --- | --- | --- | --- |
| 5 秒 | `5000` | | 512 KiB | `524288` |
| 10 秒 | `10000` | | 1 MiB | `1048576` |
| 30 秒 | `30000` | | 2 MiB | `2097152` |
| 60 秒 | `60000` | | 5 MiB | `5242880` |

### 订阅的 User-Agent

不少机场会按 User-Agent 返回不同格式：识别到 `clash` 返回 YAML，识别到 `sing-box` 直接返回一份完整的 sing-box 配置。而本服务需要的是**分享链接列表**（base64）或 Shadowsocks SIP008，拿到前两种格式反而解析不出节点。

因此默认使用 `v2rayN/6.45`。如果你的机场对这个 UA 返回的不是分享链接，用 `SUBSCRIPTION_USER_AGENT` 改成机场支持的取值即可。

### 关于订阅地址的限制

`/api/singbox/sub` 会由服务端去请求调用方给出的 URL。若不加限制，这个接口可被用来探测服务所在的内网，即 SSRF。因此默认有以下约束：

- 只接受 `http` 和 `https`
- 解析出 IP 后拒绝私有与保留网段，IPv4 覆盖 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`100.64.0.0/10`、`198.18.0.0/15` 等，IPv6 覆盖 `::1`、`fe80::/10`、`fc00::/7`、`2001:db8::/32` 等
- 重定向的每一跳都重新校验，并限制跳转次数
- 超时、响应大小、订阅数量均有上限

> [!WARNING]
> `ALLOW_PRIVATE_NETWORK=1` 会关闭上述网段校验。**服务暴露到公网时绝对不要开启**——容器通常能访问宿主机、同网络的其它容器以及整个局域网，一旦放行，任何人都可以借这个接口访问你的路由器、NAS、其它容器的管理界面，以及云厂商的元数据服务（可能泄露云账号凭据）。
>
> 这个开关只适用于服务仅在可信内网可达、且订阅确实托管在局域网内（例如同机或家中 NAS）的情况。如果只是偶尔需要局域网里的订阅，更稳妥的做法是把订阅内容手动放进 `profiles/` 的 `custom.nodes` 里。

Docker 中用 `2001:db8::/32` 作为内网段的教程很多，但该前缀是 RFC 3849 规定的文档专用前缀，IANA 登记为不可全球路由。内网用 IPv6 建议改用 ULA（`fd00::/8`）。两者本服务都会拦截。
