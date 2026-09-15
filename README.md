# Reelax 辅助控制台

「奥术摸鱼大师（Arcane Reelax）」的多账号辅助控制台：在浏览器之外按游戏协议直连服务端，
自动维持**在线钓鱼模式**，并内置可扩展的插件系统。提供 React 控制台（简洁白风格），
支持本地运行与云端（Docker / VPS）部署。

> 仅供个人学习与自动化研究，请遵守游戏用户协议、控制频率、自担风险。

## 功能

- **保持在线引擎**（核心）：自动开始/续期钓鱼，按服务器节拍（6 秒/杆）同步渔获，
  次数耗尽自动补杆，签名密钥自动续期，掉线自动重连、Cookie 失效自动用账号密码重登
- **多账号会话管理**：每个账号一个会话，独立启停、独立统计；支持账号密码或浏览器 Cookie 两种凭证
- **插件系统**：一切能力皆插件。所有插件**默认关闭**，在「会话详情 → 插件」中按会话启用。
  控制台支持在线**导入**插件（粘贴代码热加载）与**卸载**外部插件；也可把 JS 文件放进
  `server/data/plugins/` 后重启。开发指南见 `docs/EXTENDING.md`
- **实时控制台**：React 单页应用（苹果风格，支持**日间/夜间模式**切换，跟随系统偏好），实时状态推送（WebSocket）、运行日志、分页式会话设置
- **内置插件**：`保持在线` · `自动切图`（比赛/金风/经验优先）· `自动卖鱼`（分级直卖/市场委托，需已验证邮箱；挂单价优先按市场在售卖单的**近期均价**定价，官方参考价兜底）· `自动卖装备`（保留同部位最优/品质阈值）· `自动专精献祭` · `自动报名赛事` · `渊潮围猎报名`（弱点/最大属性）· `自动加点` · `每日签到`（参考实现）
- **官方航线助手冲突检测**：自动读取 `/api/convenience` 的助手状态；助手开启并启用了「自动换图 / 渊潮围猎自动报名 / 自动签到」时，对应插件拒绝启动并在运行中自动停手（每 8 分钟复查），赛事插件只让出进图、报名照常。详见 `docs/PROTOCOL.md §4.1`

## 快速开始（本地）

要求 Node.js ≥ 18（建议 20+）。

```bash
npm install          # 安装依赖（server + web）
npm run build        # 构建前端（产物 web/dist，由后端直接托管）
npm start            # 启动服务，默认 http://localhost:8580
```

打开 `http://localhost:8580`：

1. 「会话管理」→ 添加会话 → 选「账号密码」，填游戏邮箱密码
2. 引擎自动启动，总览页可看到在线状态与渔获统计
3. 想改端口/地址：`PORT=9000 npm start`；游戏测试服：`REELAX_BASE_URL=https://test.reelax.cn npm start`

开发模式（前端热更新）：`npm run dev`，访问 Vite 端口 `http://localhost:5173`。

## 凭证方式说明

| 方式 | 自动重登 | 适用 |
| --- | --- | --- |
| 账号密码 | ✅ 凭证失效自动重登 | 本机 / 私有部署（密码明文存于 `server/data/config.json`） |
| Cookie 导入 | ❌ 失效后需重新导入 | 不想在服务端存密码的场景 |

> Cookie 获取：登录游戏 → F12 → Network → 任意 `/api/` 请求 → Request Headers → 复制 `Cookie` 整行。

## 云端部署

### Docker（推荐）

```bash
AUTH_TOKEN="换一个长随机串" docker compose up -d --build  # Linux/macOS
# PowerShell: $env:AUTH_TOKEN="换一个长随机串"; docker compose up -d --build
```

或手动：

```bash
docker build -t reelax-assistant .
docker run -d --name reelax-assistant \
  -p 8580:8580 \
  -e AUTH_TOKEN="换一个长随机串" \
  -v reelax-data:/app/server/data \
  reelax-assistant
```

### 任意 VPS（无 Docker）

```bash
git clone https://github.com/Creator2K/reelax-assistant.git && cd reelax-assistant
npm install && npm run build
AUTH_TOKEN="换一个长随机串" PORT=8580 node server/src/index.js
# 建议用 systemd / pm2 托管，Nginx 反代 + HTTPS
```

**云端安全清单**：

- 务必设置 `AUTH_TOKEN`（控制台右上角「访问令牌」填同一值）
- 不要把 8580 直接暴露公网，用 Nginx/Caddy 反代 + HTTPS +（可选）Basic Auth
- `server/data/` 含账号密码与 Cookie，注意备份策略与磁盘加密
- Docker 部署时 HOST 默认 `0.0.0.0`；本地裸跑时建议 `HOST=127.0.0.1 npm start`

## 配置

`server/data/config.json`（首次启动自动生成），环境变量优先：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8580` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（Docker 已显式设为 0.0.0.0） |
| `AUTH_TOKEN` | 空 | 控制台访问令牌（建议云端必设） |
| `REELAX_BASE_URL` | `https://reelax.cn` | 游戏地址（测试服 `https://test.reelax.cn`） |

## 项目结构

```
reelax-assistant/
├── server/                  # Node.js 后端（仅依赖 ws）
│   ├── src/
│   │   ├── core/
│   │   │   ├── client.js    #   签名客户端（登录/proof/重试）
│   │   │   ├── session.js   #   会话运行时
│   │   │   ├── session-manager.js
│   │   │   ├── plugin-host.js  # 插件宿主
│   │   │   └── bus.js       #   事件总线
│   │   ├── plugins/
│   │   │   ├── keep-online.js  # ★ 保持在线引擎
│   │   │   └── daily-checkin.js#   每日签到（示例）
│   │   ├── api/
│   │   │   ├── http.js      #   REST + 静态托管
│   │   │   └── ws.js        #   WebSocket 推送
│   │   └── index.js
│   └── data/                # 运行时数据（config.json / 外部插件），记得备份
├── web/                     # React 控制台（Vite）
├── docs/
│   ├── EXTENDING.md         # ★ 扩展开发文档
│   └── PROTOCOL.md          #   游戏协议备忘
├── Dockerfile
└── docker-compose.yml
```

## 文档

- [扩展开发文档](docs/EXTENDING.md) —— 如何给辅助加新功能
- [游戏协议备忘](docs/PROTOCOL.md) —— 签名算法、钓鱼循环、常用端点

## 常见问题

- **状态一直「重连中」？** 看「运行日志」：`会话已失效且无法自动重登` = Cookie 过期（更新凭证）；
  网络错误 = 检查服务器到 `reelax.cn` 的连通性。
- **结算模式不是 online？** 同步不及时（宿主机休眠/断网）。云端部署最稳定；引擎恢复后会自动回到在线模式。
- **游戏更新后失效？** 对照 `docs/PROTOCOL.md` 检查端点/签名变化，通常只需改 `client.js`。
