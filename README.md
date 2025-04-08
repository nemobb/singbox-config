# singbox-config
singbox config generate

### Usage

##### 本地节点配置模版`custom.json`

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
};
```
 `custom.name`和`subscriptions[].name`不可以重复，用于节点分组
 `custom.nodes`填写节点配置信息
 `subscriptions[].url`填写订阅链接

##### 获取配置文件

启动服务`npm run start`后会监听0.0.0.0:5300
访问`/api/singbox`会根据根目录下`config.json`中的节点配置生成
访问`/api/singbox?profile=hello`会根据根目录下的`hello.json`中节点配置生成
访问`/api/singbox/sub?name=${groupName}&url=${sub}&name=${groupName2}&url=${sub2}`会根据参数中的订阅链接生成
`groupName`和`sub`需要用`encodeURIComponent`进行编码
