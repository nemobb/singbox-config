const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const dns = require("node:dns/promises");
const net = require("node:net");
const { Buffer } = require("node:buffer");
const { generateOutbound, parseShareLink } = require("./node");
const defaultConfig = require("./defaults/config.json");
const versions = require("./defaults/versions.json");

/* 内置模版目录。sing-box 各版本的配置互不兼容，新版本的特性旧版本无法识别，
 * 因此每个版本对应一份模版，由 versions.json 建立版本到模版的映射。 */
const DEFAULT_DIR = path.join(__dirname, "defaults");

/* 用户数据目录：profiles 存放节点配置，templates 存放配置模版。
 *
 * 两者都是挂载点，内置文件一律放在 defaults/ 而不是这两个目录里：bind mount
 * 会覆盖整个目录，内置文件若放在挂载点内，用户一挂载就全部消失，服务启动即失败。 */
const PROFILE_DIR = path.resolve(
  process.env.PROFILE_DIR || path.join(__dirname, "profiles")
);
const TEMPLATE_DIR = path.resolve(
  process.env.TEMPLATE_DIR || path.join(__dirname, "templates")
);

/* 文件名白名单，不含 '.' 和 '/' */
const NAME_RE = /^[\w-]{1,64}$/;

/* 访问令牌。未设置时不校验，保持开箱即用；暴露到公网时务必设置。 */
const TOKEN = process.env.TOKEN || "";

/* 订阅请求的约束。/api/singbox/sub 会去请求调用方给出的任意 URL，没有这些
 * 限制时可被用来探测内网、或用慢响应和超大响应拖垮服务。 */
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 10000);
const MAX_SUBSCRIPTION_SIZE = Number(
  process.env.MAX_SUBSCRIPTION_SIZE || 2 * 1024 * 1024
);
const MAX_SUBSCRIPTIONS = Number(process.env.MAX_SUBSCRIPTIONS || 10);
const MAX_REDIRECTS = 3;

/* 许多机场按 User-Agent 返回不同格式：识别到 sing-box 会直接返回一份完整的
 * sing-box 配置，而本服务解析的是分享链接列表和 SIP008，拿到配置反而解析不出
 * 节点。因此默认伪装成 v2rayN 以取得分享链接格式，必要时可覆盖。 */
const SUBSCRIPTION_USER_AGENT =
  process.env.SUBSCRIPTION_USER_AGENT || "v2rayN/6.45";
/* 局域网内自建订阅是常见用法，因此留一个放行开关 */
const ALLOW_PRIVATE_NETWORK = process.env.ALLOW_PRIVATE_NETWORK === "1";

const ERROR_STATUS = {
  invalid_name: 400,
  not_found: 404,
  invalid_format: 500,
};

const ERROR_MESSAGE = {
  invalid_name: "invalid name",
  not_found: "not found",
  invalid_format: "invalid format",
};

/**
 * 将文件名解析为 baseDir 下的绝对路径，非法或越界时返回 null
 *
 * 第一道防线是 NAME_RE 白名单，'.' 和 '/' 进不来，'../' 无法构造，单独已足以
 * 杜绝路径穿越；第二道的 path.relative 校验是为将来放宽 NAME_RE（例如支持子
 * 目录）预留的兜底，届时它会成为唯一的防线。
 *
 * 不解析软链接（realpath）是有意为之：要往挂载目录里放软链接，前提是已经拥有
 * 宿主机对该目录的写权限，到那一步本服务已不是最短攻击路径。
 *
 * @param {string} baseDir 基准目录（绝对路径）
 * @param {string} name 不含扩展名的文件名
 */
function resolveIn(baseDir, name) {
  if (!NAME_RE.test(name)) {
    return null;
  }
  const file = path.join(baseDir, name + ".json");
  const rel = path.relative(baseDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return file;
}

/**
 * 从指定目录读取并解析 JSON 文件
 *
 * @param {string} baseDir 基准目录
 * @param {string} name 不含扩展名的文件名
 * @returns {{ok: true, data: Object}|{ok: false, reason: string}}
 */
function loadJson(baseDir, name) {
  const file = resolveIn(baseDir, name);
  if (!file) {
    console.error("invalid file name:", name);
    return { ok: false, reason: "invalid_name" };
  }
  let content;
  try {
    content = fs.readFileSync(file, { encoding: "utf-8" });
  } catch (e) {
    console.error("read file fail:", file, e.code);
    return { ok: false, reason: "not_found" };
  }
  try {
    return { ok: true, data: JSON.parse(content) };
  } catch (e) {
    console.error("parse file fail:", file, e.message);
    return { ok: false, reason: "invalid_format" };
  }
}

/**
 * 支持的 sing-box 版本列表
 */
function supportedVersions() {
  return Object.keys(versions.templates);
}

/**
 * 根据 sing-box 版本号找到对应的内置模版名
 *
 * 接受 1.14、v1.14、1.14.1 等写法，取主次版本号匹配。
 *
 * @param {string|null} input singbox 请求参数
 * @returns {string|null} 模版名，版本不受支持时返回 null
 */
function resolveVersion(input) {
  let version = versions.default;
  if (input) {
    const matched = String(input).match(/^v?(\d+)\.(\d+)/);
    if (!matched) {
      return null;
    }
    version = `${matched[1]}.${matched[2]}`;
  }
  const template = versions.templates[version];
  return template ? { version, template } : null;
}

/**
 * 比较两个主次版本号
 */
function compareVersion(a, b) {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/**
 * 按目标 sing-box 版本算出可用的协议能力
 *
 * versions.json 的 features 记录各协议的最低版本，低于该版本时对应节点会在
 * parseShareLink 阶段被跳过，避免生成目标版本无法加载的配置。
 *
 * @param {string} version 主次版本号
 */
function resolveFeatures(version) {
  const features = {};
  Object.entries(versions.features || {}).forEach(([name, since]) => {
    features[name] = compareVersion(version, since) >= 0;
  });
  return features;
}

/**
 * 返回错误响应，详细信息只写日志，不回显路径
 *
 * @param {ServerResponse} res
 * @param {string} kind 出错的文件类型
 * @param {string} reason loadJson 返回的错误原因
 */
function sendError(res, kind, reason) {
  return res
    .writeHead(ERROR_STATUS[reason], { "content-type": "text/plain" })
    .end(`${kind}: ${ERROR_MESSAGE[reason]}`);
}

/**
 * 将base64字符串解码
 *
 * @param {string} string
 */
function decodeBase64(string) {
  return Buffer.from(string, "base64").toString("utf-8");
}

/**
 * 判断是否为节点配置格式
 *
 * @param {string} node
 */
function isNode(node) {
  return /^[a-z0-9]{2,}:\/\//.test(node);
}

/**
 * 将节点配置转换为singbox支持的格式
 *
 * @param {string} node
 * @param {Object} features 目标 sing-box 版本支持的协议能力
 */
function getSingboxOutbound(node, features) {
  let outbound;
  try {
    outbound = generateOutbound(parseShareLink(node, features));
  } catch (e) {
    /* 畸形链接会让解析抛异常（如 atob 遇到非法 base64）。订阅里混入一条坏
     * 链接是常事，不能让整份配置生成失败，因此按单个节点隔离。 */
    console.warn("skip invalid node:", node.slice(0, 40), e.message);
    return null;
  }
  /* 解析失败或目标版本不支持该协议时跳过，由调用方过滤 */
  if (!outbound) {
    console.warn("skip unsupported node:", node.slice(0, 40));
    return null;
  }
  /* 对应上游的 removeBlankAttrs：null 和空字符串都表示“该字段不输出”。
   * sing-box 对未知或非法字段是致命错误，残留会让整份配置无法加载。 */
  return JSON.parse(
    JSON.stringify(
      outbound,
      (_, value) => {
        if (value === undefined || value === null || value === "") {
          return undefined;
        }
        return value;
      },
      2
    )
  );
}

/**
 * 判断 IP 是否属于私有或保留网段
 *
 * @param {string} ip
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10.0.0.0/8
      a === 127 || // 环回
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 运营商级 NAT
      (a === 169 && b === 254) || // 链路本地，云厂商元数据服务
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 0) || // 192.0.0.0/24 协议分配、192.0.2.0/24 文档
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 198 && b >= 18 && b <= 19) || // 198.18.0.0/15 基准测试，亦为 fakeip 常用段
      (a === 198 && b === 51) || // 198.51.100.0/24 文档
      (a === 203 && b === 0) || // 203.0.113.0/24 文档
      a >= 224 // 组播与保留
    );
  }
  if (net.isIPv6(ip)) {
    /* 补齐为 8 组，使前缀比较不受 :: 省略写法影响 */
    const groups = expandIPv6(ip);
    /* ::ffff:0:0/96 是 IPv4 映射地址，取出内嵌的 v4 按 v4 规则判断 */
    if (
      groups.slice(0, 5).every((g) => g === "0000") &&
      groups[5] === "ffff"
    ) {
      return isPrivateAddress(
        [
          parseInt(groups[6].slice(0, 2), 16),
          parseInt(groups[6].slice(2), 16),
          parseInt(groups[7].slice(0, 2), 16),
          parseInt(groups[7].slice(2), 16),
        ].join(".")
      );
    }
    const first = groups[0];
    return (
      /^0{4}$/.test(first) || // ::、::1 等 0000::/16 内的地址
      first === "0064" || // 64:ff9b::/96 NAT64
      (first === "2001" && groups[1] === "0db8") || // 文档前缀，docker 常被误用作内网段
      first === "2002" || // 2002::/16 6to4
      /^fe[89ab]/.test(first) || // fe80::/10 链路本地
      /^fe[cdef]/.test(first) || // fec0::/10 已废弃的站点本地
      /^f[cd]/.test(first) // fc00::/7 唯一本地
    );
  }
  return false;
}

/**
 * 将 IPv6 地址补齐为 8 组四位十六进制
 *
 * @param {string} ip
 */
function expandIPv6(ip) {
  let address = ip.toLowerCase();
  /* IPv4 映射写法先转成十六进制，避免末段被当作 IPv6 组 */
  const mapped = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const [a, b, c, d] = mapped[2].split(".").map(Number);
    address =
      mapped[1] +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = new Array(8 - left.length - right.length).fill("0");
  return [...left, ...(tail !== undefined ? fill : []), ...right].map((g) =>
    g.padStart(4, "0")
  );
}

/**
 * 校验订阅 URL 是否允许请求
 *
 * 解析主机名后逐个检查地址，拒绝私有与保留网段，避免本接口被用来探测内网。
 * 校验必须在每次重定向后重做，否则 302 到 169.254.169.254 就能绕过。
 *
 * @param {string} url
 * @returns {Promise<string|null>} 不允许时返回原因
 */
async function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return "invalid url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `unsupported protocol ${parsed.protocol}`;
  }
  if (ALLOW_PRIVATE_NETWORK) {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch (e) {
      return `dns lookup fail: ${e.code}`;
    }
  }
  const blocked = addresses.find((ip) => isPrivateAddress(ip));
  return blocked ? `private address ${blocked}` : null;
}

/**
 * 带超时、大小与重定向限制的订阅请求
 *
 * 手动跟随重定向，以便对每一跳都重新做地址校验。
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchSubscription(url) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const denied = await checkUrl(current);
    if (denied) {
      console.warn("reject subscription url:", current, denied);
      return null;
    }
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { "user-agent": SUBSCRIPTION_USER_AGENT },
      });
    } catch (e) {
      console.warn("fetch subscription fail:", current, e.message);
      return null;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    if (!res.ok) {
      console.warn("fetch subscription fail:", current, res.status);
      return null;
    }
    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX_SUBSCRIPTION_SIZE) {
      console.warn("subscription too large:", current, declared);
      return null;
    }
    /* content-length 可能缺失或撒谎，按实际读取量再限一次 */
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_SUBSCRIPTION_SIZE) {
        console.warn("subscription too large:", current, ">", size);
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  console.warn("too many redirects:", url);
  return null;
}

/**
 * 根据订阅链接将节点转换为singbox出站
 *
 * @param {string} url
 * @param {Object} features 目标 sing-box 版本支持的协议能力
 */
async function getSubscription(url, features) {
  if (!url) {
    return;
  }
  const res = await fetchSubscription(url);
  if (!res) {
    return;
  }
  let outbounds = [];
  try {
    const _res = JSON.parse(res);
    const nodes = _res.servers || _res;
    /* Shadowsocks SIP008 format */
    if (nodes[0].server && nodes[0].method) {
      /* https://shadowsocks.org/guide/sip008.html */
      outbounds = nodes.map((node) =>
        generateOutbound({
          label: node.remarks,
          type: "shadowsocks",
          address: node.server,
          port: node.server_port,
          shadowsocks_encrypt_method: node.method,
          password: node.password,
          shadowsocks_plugin: node.plugin,
          shadowsocks_plugin_opts: node.plugin_opts,
        })
      );
    }
  } catch (e) {
    const nodes = decodeBase64(res)
      .trim()
      .split("\n")
      .filter((node) => isNode(node));
    outbounds = nodes
      .map((node) => getSingboxOutbound(node, features))
      .filter(Boolean);
  }
  return outbounds;
}

/**
 * 更新singbox出站节点信息
 *
 * @param {Array} outbounds 一组singbox出站配置
 * @param {string} tag 自定义组名
 * @param {Object} template 自定义配置模版
 */
function updateOutbounds(outbounds, tag, template) {
  /* sing-box 要求出站标签全局唯一，重复会导致整份配置被拒绝加载。重名很常见：
   * 同一机场的同名节点、不同机场都叫“香港01”、节点名撞上模版里的 AUTO 等。
   * 这里对已占用的标签追加序号，已占用集合包含模版原有出站和先前加入的分组。 */
  const used = new Set(template.outbounds.map((item) => item.tag));
  const unique = (name) => {
    let result = name;
    let index = 2;
    while (used.has(result)) {
      result = `${name} ${index++}`;
    }
    if (result !== name) {
      console.warn(`duplicate outbound tag "${name}", renamed to "${result}"`);
    }
    used.add(result);
    return result;
  };
  outbounds.forEach((item) => {
    item.tag = unique(item.tag);
  });
  const _outbounds = outbounds.map((item) => item.tag);
  const groupTag = unique(tag);
  const result = [
    ...outbounds,
    {
      type: "selector",
      tag: groupTag,
      outbounds: _outbounds,
      default: _outbounds[0],
      interrupt_exist_connections: true,
    },
  ];
  template.outbounds
    .find((item) => item.tag === "GLOBAL")
    ?.outbounds.push(groupTag);
  template.outbounds
    .find((item) => item.tag === "AUTO")
    ?.outbounds.push(..._outbounds);
  template.outbounds.push(...result);
}

/**
 * 根据配置配置文件生成singbox配置文件
 * @param {Object} config 节点配置信息
 * @param {Object} template 自定义配置模版
 * @param {Object} features 目标 sing-box 版本支持的协议能力
 * @returns {Object|null} 配置，一个可用节点都没有时返回 null
 */
async function generateSingboxConfig(config, template, features) {
  const { custom } = config;
  let { subscriptions } = config;
  let count = 0;
  /* 空分组会生成 outbounds 为空的 selector，sing-box 拒绝加载，因此跳过 */
  const addGroup = (outbounds, tag) => {
    if (!outbounds || !outbounds.length) {
      console.warn("skip empty group:", tag);
      return;
    }
    updateOutbounds(outbounds, tag, template);
    count += outbounds.length;
  };
  if (custom && Array.isArray(custom.nodes) && custom.nodes.length) {
    const nodes = custom.nodes.filter((node) => isNode(node.trim()));
    addGroup(
      nodes.map((node) => getSingboxOutbound(node, features)).filter(Boolean),
      custom.name
    );
  }
  if (Array.isArray(subscriptions) && subscriptions.length) {
    /* 订阅是并发外呼，数量不设上限时一次请求就能放大成任意多次外部请求 */
    if (subscriptions.length > MAX_SUBSCRIPTIONS) {
      console.warn(
        `too many subscriptions: ${subscriptions.length}, only the first ${MAX_SUBSCRIPTIONS} are used`
      );
      subscriptions = subscriptions.slice(0, MAX_SUBSCRIPTIONS);
    }
    const res = await Promise.all(
      subscriptions.map((item) => getSubscription(item.url.trim(), features))
    );
    res.forEach((outbounds, index) =>
      addGroup(outbounds, subscriptions[index].name)
    );
  }
  return count ? template : null;
}

/**
 * 从searchParams中解析节点配置信息
 *
 * @param {searchParams} searchParams SearchParams对象
 */
function getConfigFromParams(searchParams) {
  const name = searchParams.getAll("name");
  const url = searchParams.getAll("url");
  const config = {};
  if (url.length < 1) {
    // 没有获取到参数
    config.subscriptions = [];
  } else {
    config.subscriptions = url.map((_, index) => ({
      name: name[index],
      url: url[index],
    }));
  }
  return config;
}

/**
 * 找出模版中缺失的、分组注入所必需的出站标签
 *
 * @param {Object} template 配置模版
 */
function getMissingTags(template) {
  const tags = Array.isArray(template.outbounds)
    ? template.outbounds.map((item) => item.tag)
    : [];
  return ["GLOBAL", "AUTO"].filter((tag) => !tags.includes(tag));
}

/**
 * 启动时校验 templates 目录下的模版
 *
 * updateOutbounds 依赖 GLOBAL 和 AUTO 两个出站来挂载节点分组，缺失时不会报错，
 * 只会静默地不分组，因此在启动阶段提前告警。
 */
function checkTemplate(baseDir, name, label) {
  const result = loadJson(baseDir, name);
  if (!result.ok) {
    console.warn(`template ${label} load fail: ${result.reason}`);
    return;
  }
  const missing = getMissingTags(result.data);
  if (missing.length) {
    console.warn(
      `template ${label} missing outbound tag: ${missing.join(
        ", "
      )}, node groups will not be injected`
    );
  }
}

function checkTemplates() {
  /* 内置模版：同时校验 versions.json 的映射是否都能取到文件 */
  if (!versions.templates[versions.default]) {
    console.warn(
      `versions.json default "${versions.default}" is not a supported version`
    );
  }
  new Set(Object.values(versions.templates)).forEach((name) =>
    checkTemplate(DEFAULT_DIR, name, `"${name}" (builtin)`)
  );
  let files;
  try {
    files = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.warn("read template dir fail:", TEMPLATE_DIR, e.code);
    return;
  }
  files.forEach((file) =>
    checkTemplate(TEMPLATE_DIR, path.basename(file, ".json"), `"${file}"`)
  );
}

const hostname = "0.0.0.0";
const port = 5300;
const server = http
  .createServer((req, res) => {
    if (req.method === "GET") {
      const url = new URL(`http://${hostname}:${port}${req.url}`);
      /* 客户端只能填一个 URL，无法自定义请求头，因此令牌走查询参数 */
      if (TOKEN && url.searchParams.get("token") !== TOKEN) {
        console.warn("forbidden:", url.pathname);
        return res
          .writeHead(403, { "content-type": "text/plain" })
          .end("Forbidden");
      }
      let _template = null;
      let _config = null;
      /* 自备模版时版本未知，不做协议裁剪，由使用者自行负责 */
      let _features = undefined;
      if (!url.pathname.startsWith("/api/singbox")) {
        return res.writeHead(404).end("Not Found");
      } else {
        const templateName = url.searchParams.get("template");
        if (templateName) {
          /* 用户自备模版，其与 sing-box 版本的对应关系由用户自己负责 */
          const result = loadJson(TEMPLATE_DIR, templateName);
          if (!result.ok) {
            return sendError(res, "template", result.reason);
          }
          _template = result.data;
        } else {
          /* 内置模版，按 sing-box 版本选取 */
          const singbox = url.searchParams.get("singbox");
          const resolved = resolveVersion(singbox);
          if (!resolved) {
            console.error("unsupported singbox version:", singbox);
            return res
              .writeHead(400, { "content-type": "text/plain" })
              .end(
                `unsupported sing-box version, supported: ${supportedVersions().join(
                  ", "
                )}`
              );
          }
          const result = loadJson(DEFAULT_DIR, resolved.template);
          if (!result.ok) {
            return sendError(res, "template", result.reason);
          }
          _template = result.data;
          _features = resolveFeatures(resolved.version);
        }
      }
      switch (url.pathname) {
        case "/api/singbox/sub": // 从参数中获取节点配置信息
          _config = getConfigFromParams(url.searchParams);
          break;
        case "/api/singbox": // 从本地配置文件中获取节点配置信息
          const profile = url.searchParams.get("profile");
          if (profile) {
            const result = loadJson(PROFILE_DIR, profile);
            if (!result.ok) {
              return sendError(res, "profile", result.reason);
            }
            _config = result.data;
          } else {
            _config = JSON.parse(JSON.stringify(defaultConfig));
          }
          break;
        default:
          return res.writeHead(404).end("Not Found");
      }
      generateSingboxConfig(_config, _template, _features)
        .then((data) => {
          if (!data) {
            console.error("no available node:", req.url);
            return res
              .writeHead(400, { "content-type": "text/plain" })
              .end("no available node");
          }
          console.log(new Date().toLocaleString(), "generate success", req.url);
          res
            .writeHead(200, { "content-type": "text/plain" })
            .end(JSON.stringify(data, undefined, 2));
        })
        .catch((error) => {
          console.error("generate singbox config error:", error);
          res
            .writeHead(500, { "content-type": "text/plain" })
            .end(`generate singbox config error: ${error}`);
        });
    } else {
      res
        .writeHead(405, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: "Method Not Allowed" }));
    }
  })
  .listen(port, hostname, () => {
    checkTemplates();
    console.log(`Server running at http://${hostname}:${port}`);
  });

/* 容器中进程位于 PID 1，内核不为其安装默认信号处理器，不显式处理 SIGTERM
 * 就等于忽略它，docker stop 只能等超时后 SIGKILL。 */
["SIGTERM", "SIGINT"].forEach((signal) =>
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  })
);
