# HTTP/2 高并发下 toHttp1 内部建连 ECONNRESET，stream 在无响应头时以 rstCode=0 关闭（含最小复现，2.10.13）

## 问题

在 macOS 上，HTTP/2 并发请求经过 Whistle 转发到本地 HTTP/1.1 源站时，部分请求在 `toHttp1()` 连接 Whistle 自己的监听端口时发生 `connect ECONNRESET`。

随后客户端的 HTTP/2 stream 在没有收到 response headers 的情况下关闭，`rstCode=0`。源站没有收到这些失败请求。

原始开发页面的表现是首次打开白屏、Chromium 报 `ERR_HTTP2_PROTOCOL_ERROR`，刷新可能恢复。下面的独立复现去除了业务、Vite 和浏览器，只复现触发断流的并发条件。

## 最小复现

仓库：[lxy32167/whistle-h2-backlog-repro](https://github.com/lxy32167/whistle-h2-backlog-repro)

```sh
npm ci --ignore-scripts
npm run repro
```

默认 200 并发、1000 请求；默认不开诊断钩子。程序使用独立 Whistle 数据目录及本机端口，不修改系统代理或证书信任。

低并发对照仍使用 HTTP/2：

```sh
npm run control
```

观察内部连接错误：

```sh
npm run repro -- --trace
```

复现错误时退出码为 1；环境错误为 2；全部成功为 0。

## 环境和结果

- macOS 27.0.1 / Darwin 27.0.0，arm64
- Node.js 22.19.0
- Whistle 2.10.13（2.10.10 同样复现）
- `kern.ipc.somaxconn=128`
- TLS ALPN 为 `h2`，本地源站固定返回 HTTP 200 和一行 JavaScript

| Whistle | 并发 | 诊断 | 成功 / 总数 | 失败 |
|---|---:|---|---:|---:|
| 2.10.13 | 200 | 关闭 | 185 / 1000 | 815 |
| 2.10.13 | 200 | 开启 | 178 / 1000 | 822 |
| 2.10.13 | 6 | 开启 | 1000 / 1000 | 0 |
| 2.10.10 | 200 | 关闭 | 185 / 1000 | 815 |

失败数量会波动。2.10.13 诊断运行记录到 822 次 `ECONNRESET:connect`，与 822 个 `CLOSED_WITHOUT_HEADERS` 对应；失败流均未收到状态码，`rstCode=0`。完整输出见复现仓库的 `examples/`。

## 预期与实际

预期：HTTP/2 请求能够正常转发；内部转发连接的突发压力应得到排队/限制，或失败时向客户端返回明确的失败响应。

实际：内部 connect 失败后，HTTP/2 流在没有响应头的情况下关闭，浏览器因此无法加载必需的模块。

## 定位线索

Whistle 2.10.13 的 `lib/https/index.js` 中，`toHttp1()` 对每个请求使用 `options.agent = false`，向 `config.port` 创建独立连接。内部连接错误进入 `handleAbort()` 后会销毁响应。

另在原始应用中做过单变量对照：保持 HTTP/2 和 `agent:false`，`somaxconn=512` 连续三轮无连接错误；恢复 `somaxconn=128` 并重启 Whistle 后，重新出现白屏和 278 次内部 connect ECONNRESET。这一结果支持监听队列容量不足的解释，但还没有直接抓到内核队列占用/溢出事件。该 sysctl 对照是在原始应用中完成，不能算作本最小仓库的测试结果。

原始应用中，仅为这段内部转发使用共享、有限并发的 Agent，也能在保留 HTTP/2 的情况下避免故障。这里希望讨论是否需要对该转发做连接管理，以及内部失败后的 HTTP/2 响应处理。

此前 #1081 的报错表现相似；本复现提供的是内部 `connect ECONNRESET` 证据，不将两次问题直接视为同一根因。
