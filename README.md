# Whistle HTTP/2 loopback backlog reproduction

最小复现：HTTP/2 请求经过 Whistle 的 `toHttp1()` 转发到其自身监听端口时，高并发可能导致内部 TCP `connect ECONNRESET`。客户端收到的表现是 **HTTP/2 stream 在没有响应头时关闭，`rstCode=0`**。

这个仓库只有两个运行脚本，唯一第三方依赖是原版 `whistle`。没有 Vue、Vite、业务代码、登录态、浏览器自动化或人工 event-loop 阻塞。

## 运行

已验证环境：macOS 27.0.1 / Darwin 27.0.0、arm64、Node.js 22.19.0，`kern.ipc.somaxconn=128`。

```sh
nvm use                 # 可选；.nvmrc 固定为 22.19.0
npm ci --ignore-scripts
npm run repro
```

默认 Whistle **2.10.13**，200 并发、1000 个请求。程序只启动本机临时服务，结束后自动关闭并删除临时 Whistle 数据。

- `exit 0`：所有请求获得 HTTP 200 和正确响应体。
- `exit 1`：观测到请求失败；在受影响环境中，这是预期的复现结果。
- `exit 2`：运行环境/启动错误或超时，不应当作复现成功。
- JSON 输出同时写入 `results/latest.json`，每次覆盖。

不同操作系统、监听队列容量和 Node 版本可能不复现；失败数量不保证一致。

## 同样使用 HTTP/2 的低并发对照

```sh
npm run control
```

仍使用 TLS + HTTP/2，只把请求并发改为 6。不是关闭 HTTP/2。

可调整参数：

```sh
npm run repro -- --concurrency 200 --requests 1000
npm run repro -- --proxy-port 18898
npm run repro -- --trace
```

`--trace` 仅在 Whistle 子进程中观察发往自身监听端口、Host 为 `repro.test` 的 `http.request()` 错误，输出 `bridgeErrors`。它不更改 Agent、请求头、连接上限或超时；默认关闭，关闭时仍能复现。`bridgeStats.active` 是采样时尚未触发 `close` 的请求数。

## 怎么看运行结果

先运行高并发诊断，再运行低并发对照；两者都保持 HTTP/2：

```sh
npm run repro -- --trace
echo $?                              # 紧接上一条命令查看退出码
cp results/latest.json results/high-concurrency.json

npm run control
echo $?
cp results/latest.json results/low-concurrency.json
```

终端会打印 JSON，也会写入 `results/latest.json`；该文件每次覆盖，比较两次运行前请像上面一样另存。若启动失败而未生成新报告，旧的 `latest.json` 可能仍在，应以本次终端输出为准。

| 字段 | 如何理解 |
|---|---|
| `alpn: "h2"` | 确认客户端到 Whistle 实际使用 HTTP/2 |
| `concurrency` / `requests` | 并发上限 / 总请求数，默认分别为 200 / 1000 |
| `passed` / `failed` | 成功 / 失败数量；成功要求 HTTP 200、响应体完整正确且无请求错误 |
| `failureTypes.CLOSED_WITHOUT_HEADERS` | HTTP/2 stream 关闭时仍没有响应头，是本问题的关键客户端表现 |
| `firstFailures[].status: null` | 没收到 HTTP 状态码；不是 HTTP 500 |
| `firstFailures[].rstCode: 0` | stream 关闭码；不能单独据此判断请求成功 |
| `bridgeErrors["ECONNRESET:connect"]` | `--trace` 才有：Whistle 连接自身 HTTP/1.1 端口时被重置的次数 |
| `originRequests` | 本地源站收到的请求数；本复现中失败的内部连接不会到达源站 |
| `elapsedMs` | 发起这一批请求至全部结束的耗时；大量请求快速失败可能使它更小，不能直接当成加载性能提升 |

判断方式：

- **复现了同一故障**：高并发存在 `CLOSED_WITHOUT_HEADERS`，且 trace 同时记录 `ECONNRESET:connect`；低并发对照通常为 `passed: 1000, failed: 0`。
- **本轮未复现**：`failed: 0`；不代表所有环境都没有问题。
- **出现其他问题**：只有 `TIMEOUT`、`BAD_RESPONSE` 或启动错误时，需要另外排查，不能直接归为该内部建连故障。

`npm run repro` 以退出码 **1** 结束可能正是预期结果：脚本发现了故障，并非一定是脚本坏了。正常通过为 **0**，脚本捕获的启动/环境错误及整体超时为 **2**。

## 请求链路

```text
Node HTTP/2 client
  │ HTTP CONNECT → TLS，ALPN=h2
  ▼
隔离的原版 Whistle（127.0.0.1:18899）
  │ toHttp1(): http.request({ agent: false, port: 18899 })
  ▼
Whistle 自己的 HTTP/1.1 监听端口
  │ 规则：repro.test → http://127.0.0.1:<随机端口>
  ▼
本地 HTTP/1.1 服务（固定返回一行 JavaScript）
```

客户端仅信任本次临时 Whistle 实例生成的 CA；没有关闭 TLS 证书校验，不安装系统证书，不修改系统代理、hosts 或 sysctl，也不会连接已有的 8899 实例。域名 `repro.test` 仅用于本地路由，不需要外部 DNS。

`WHISTLE_PATH` 使用独立临时目录；插件关闭；Whistle 子进程不继承 `NODE_OPTIONS`，避免把本机其他实验补丁带进复现。脚本也不修改 `node_modules` 中的 Whistle 源码。

## 已记录的结果

全部结果均为 TLS + HTTP/2、1000 个请求、`somaxconn=128`。原始 JSON 在 [examples](./examples/) 中。

| Whistle | 并发 | 诊断钩子 | 成功 | 失败 |
|---|---:|---|---:|---:|
| 2.10.10 | 200 | 关闭 | 185 | 815 |
| 2.10.10 | 200 | 开启 | 182 | 818 |
| 2.10.10 | 6 | 开启 | 1000 | 0 |
| 2.10.13 | 200 | 关闭 | 185 | 815 |
| 2.10.13 | 200 | 开启 | 178 | 822 |
| 2.10.13 | 6 | 开启 | 1000 | 0 |

2.10.13 的诊断运行中：

```json
{
  "alpn": "h2",
  "concurrency": 200,
  "passed": 178,
  "failed": 822,
  "failureTypes": { "CLOSED_WITHOUT_HEADERS": 822 },
  "bridgeErrors": { "ECONNRESET:connect": 822 }
}
```

失败 stream 的 `status` 为 `null`，`rstCode` 为 `0`；对应请求没有到达本地源站。

## 验证其他 Whistle 版本

```sh
npm install --no-save --package-lock=false --ignore-scripts whistle@2.10.10
npm run repro
npm ci --ignore-scripts  # 恢复锁定的 2.10.13
```

## 与原始冷启动白屏的关系

原始场景是开发页面首次打开时并发加载大量 ES modules，Chromium 报 `ERR_HTTP2_PROTOCOL_ERROR`，刷新后可恢复。

本仓库剥离页面与缓存行为，只保留触发同一转发故障的并发条件。因此它验证的是 **内部建连失败 → 未发送响应头就关闭 HTTP/2 stream**，不声称复刻完整的“首次白屏、刷新成功”生命周期。

在原始应用中，保持 HTTP/2 和 `agent:false`、只将 `somaxconn` 从 128 提高到 512 后连续三轮无连接错误；恢复 128 并重启 Whistle 后再次白屏，记录到 278 次内部 `connect ECONNRESET`。这是额外的应用端证据，**不是本仓库在 512 下的测试结果**。本仓库不会自动修改全局内核设置。

如维护者自行对照 backlog，必须在修改系统值后重新运行本程序，让 Whistle 重新 `listen()`，测试后恢复修改前的值。Node 默认 `listen()` backlog 为 511，操作系统还会限制实际容量；`somaxconn=512` 不等于 Whistle 实际获得 512。

## 文件

- `repro.cjs`：本地源站、隔离子进程、TLS/HTTP2 客户端、结果统计及清理。
- `whistle-worker.cjs`：通过 Whistle 官方 npm API 启动；可选的只读诊断钩子。
- `examples/`：可公开的实测输出，不包含 Cookie、Token、用户名或业务 URL。
- `ISSUE.md`：已填写仓库 URL 的 issue 草稿。

参考：[Whistle npm API](https://wproxy.org/en/docs/extensions/npm.html)、[Node listen backlog](https://nodejs.org/api/net.html#serverlisten)、[Apple listen 实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_socket.c)。
