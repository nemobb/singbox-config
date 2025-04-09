const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { Buffer } = require("node:buffer");
const { generateOutbound, parseShareLink } = require("./node");
const template = require("./template.json");
const config = require("./config.json");

/**
 * 根据给出的文件名解析成路径
 *
 * @param {string} fileName
 */
function pathResolve(fileName) {
  return path.resolve(__dirname, fileName);
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
 */
function getSingboxOutbound(node) {
  const outbound = generateOutbound(parseShareLink(node));
  return JSON.parse(
    JSON.stringify(
      outbound,
      (_, value) => {
        if (value === undefined || value === null) {
          return undefined;
        }
        return value;
      },
      2
    )
  );
}

/**
 * 根据订阅链接将节点转换为singbox出站
 *
 * @param {string} url
 */
async function getSubscription(url) {
  if (!url) {
    return;
  }
  const res = await fetch(url)
    .then((res) => res.text())
    .catch((err) => {
      console.log("---error start---");
      console.log("request url:", url);
      console.log(err);
      console.log("---error end---");
    });
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
    outbounds = nodes.map((node) => getSingboxOutbound(node));
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
  const _outbounds = outbounds.map((item) => item.tag);
  const result = [
    ...outbounds,
    {
      type: "selector",
      tag: tag,
      outbounds: _outbounds,
      default: _outbounds[0],
      interrupt_exist_connections: true,
    },
  ];
  template.outbounds.find((item) => item.tag === "GLOBAL")?.outbounds.push(tag);
  template.outbounds
    .find((item) => item.tag === "AUTO")
    ?.outbounds.push(..._outbounds);
  template.outbounds.push(...result);
}

/**
 * 根据配置配置文件生成singbox配置文件
 * @param {Object} config 节点配置信息
 * @param {Object} template 自定义配置模版
 */
async function generateSingboxConfig(config, template) {
  const { custom, subscriptions } = config;
  if (custom && Array.isArray(custom.nodes) && custom.nodes.length) {
    const nodes = custom.nodes.filter((node) => isNode(node.trim()));
    nodes.length &&
      updateOutbounds(
        nodes.map((node) => getSingboxOutbound(node)),
        custom.name,
        template
      );
  }
  if (Array.isArray(subscriptions) && subscriptions.length) {
    const res = await Promise.all(
      subscriptions.map((item) => getSubscription(item.url.trim()))
    );
    res.forEach((outbounds, index) => {
      if (outbounds) {
        updateOutbounds(outbounds, subscriptions[index].name, template);
      }
    });
  }
  return template;
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

const hostname = "0.0.0.0";
const port = 5300;
http
  .createServer((req, res) => {
    if (req.method === "GET") {
      const url = new URL(`http://${hostname}:${port}${req.url}`);
      let _template = null;
      let _config = null;
      if (!url.pathname.startsWith("/api/singbox")) {
        return res.writeHead(404).end("Not Found");
      } else {
        const templateName = url.searchParams.get("template");
        if (templateName) {
          const fileName = templateName + ".json";
          try {
            const content = fs.readFileSync(pathResolve(fileName), {
              encoding: "utf-8",
            });
            _template = JSON.parse(content);
          } catch (e) {
            console.error("read template file fail:", fileName);
            return res
              .writeHead(500, { "content-type": "text/plain" })
              .end(`read template file fail: ${fileName}`);
          }
        } else {
          _template = JSON.parse(JSON.stringify(template));
        }
      }
      switch (url.pathname) {
        case "/api/singbox/sub": // 从参数中获取节点配置信息
          _config = getConfigFromParams(url.searchParams);
          break;
        case "/api/singbox": // 从本地配置文件中获取节点配置信息
          const profile = url.searchParams.get("profile");
          if (profile) {
            const fileName = profile + ".json";
            try {
              const content = fs.readFileSync(pathResolve(fileName), {
                encoding: "utf-8",
              });
              _config = JSON.parse(content);
            } catch (e) {
              console.error("read profile file fail:", fileName);
              return res
                .writeHead(500, { "content-type": "text/plain" })
                .end(`read profile file fail: ${fileName}`);
            }
          } else {
            _config = JSON.parse(JSON.stringify(config));
          }
          break;
        default:
          return res.writeHead(404).end("Not Found");
      }
      generateSingboxConfig(_config, _template)
        .then((data) => {
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
    console.log(`Server running at http://${hostname}:${port}`);
  });
