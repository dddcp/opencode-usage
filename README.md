# opencode-usage

OpenCode TUI 侧边栏插件：在会话右侧面板实时查看当前模型所属 Coding 套餐的剩余额度。

![GLM Coding Plan](docs/screenshot.png)

![DeepSeek balance](docs/screenshot-deepseek.png)

面板跟随 TUI 中当前选中的模型：切换模型时自动切换到对应 provider 的额度；
每 5 分钟自动刷新，每轮对话结束后 3 秒也会刷新一次，点击 `↻` 手动刷新，
点击标题行可折叠。当前模型不属于下列三家时，面板显示 unsupported 提示。

## 支持的 Provider

| Provider         | 识别方式（baseURL）                      | 显示内容                                                               |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| GLM 国内（智谱） | `open.bigmodel.cn`                     | 5 小时窗口 / 周窗口的百分比、已用/总量（信用点）、重置倒计时、套餐等级 |
| GLM 国际（z.ai） | `api.z.ai`                             | 同上（两家共用同一套接口）                                             |
| Kimi Coding Plan | `api.kimi.com`（`*.moonshot.ai` 等） | 周 / 5 小时窗口百分比与重置倒计时；加油包（booster）开启时显示 ¥ 用量 |
| DeepSeek         | `api.deepseek.com`                     | 账户余额（¥ / $）；余额不足时红色警示                                 |

API Key 解析顺序：provider 配置里的 `options.apiKey` →
`~/.local/share/opencode/auth.json`（`opencode auth login` 的内置套餐登录）→
环境变量（`ZAI_API_KEY` / `ZHIPU_API_KEY`、`KIMI_API_KEY` / `KIMI_CODING_API_KEY`、`DEEPSEEK_API_KEY`）。

## 安装

要求 opencode v2（TUI 插件系统）。

### 方式一：npm 安装（推荐）

```bash
opencode plugin add opencode-coding-quota
```

（npm 包名是 `opencode-coding-quota`，`opencode-usage` 在 npm 上已被其他包占用。）

### 方式二：从源码安装（开发 / 不依赖 npm）

无需构建——opencode 直接加载 `tui.tsx` 源文件。

```bash
git clone https://github.com/dddcp/opencode-usage.git
cd opencode-usage
npm install
node scripts/install.mjs        # 建立 src/ → opencode 插件目录的链接（跨平台）
```

重启 opencode（刚跑过 `npm install`/动过 node_modules 时先 `opencode service restart`），
打开任意会话即可在右侧看到面板。卸载：`node scripts/install.mjs remove`。

安装脚本做的一切就是把本项目 `src/` 链接到 `~/.config/opencode/plugins/opencode-usage`
（Windows 用 NTFS junction，无需管理员权限；macOS/Linux 用符号链接）。
opencode 加载插件时会把链接解析为物理路径，插件里的 `solid-js` / `@opentui/*` /
`@opencode/plugin` 导入直接从本项目的 `node_modules` 解析，所以
**不需要**在 `~/.config/opencode` 下安装任何依赖；源码改动即时生效（TUI 热重载）。

## 项目结构

```
src/
├── tui.tsx              # 插件入口（Plugin.define + sidebar.content 插槽 + 面板组件）
├── types.ts             # UsageData / UsageRow 数据契约
└── providers/
    ├── glm.ts           # 智谱国内/国际 quota 接口适配
    ├── kimi.ts          # Kimi Coding Plan /usages 适配
    ├── deepseek.ts      # DeepSeek /user/balance 适配
    └── resolve.ts       # 当前模型 → provider 识别、key 解析、路由
scripts/
└── install.mjs          # 跨平台安装/卸载脚本（链接 src/ 到 opencode 插件目录）
test/
├── run.mjs              # 解析逻辑单元测试（mock payload）
└── verify-resolve.mjs   # 端到端验证（读本机 opencode 配置，真实调用三家接口）
```

## 开发

```bash
npm install          # 安装依赖（类型检查 + 插件运行依赖）
npm run setup        # 链接到 opencode（等价于 node scripts/install.mjs）
npm run typecheck    # tsc --noEmit
npm test             # 单元测试
node test/verify-resolve.mjs   # 真实接口端到端验证（读你本机的 opencode 配置）
```

修改 `src/` 后 TUI 会热重载；若报模块解析错误，重启 TUI 或执行
`opencode service restart`。

## 接口细节（2026-10 实测）

- **GLM**：`GET {base}/api/monitor/usage/quota/limit`，`Authorization` 头直接放
  key（无 `Bearer` 前缀）。响应 `data.limits[]` 中 `unit:3` 为 5 小时窗口、
  `unit:6` 为周窗口；旧套餐返回 `TOKENS_LIMIT`（仅百分比），新套餐返回
  `CREDIT_LIMIT`（含 `usage`/`currentValue`/`remaining` 绝对值），两者均兼容。
  注意业务错误可能伴随 HTTP 200 返回，需检查 body 的 `code`/`success`。
- **Kimi**：`GET {base}/usages`，`Authorization: Bearer`。兼容三种历史格式
  （`usage`+`limits[]`、`usages.limit_7d/limit_5h` 比例、`data[]`），`used_ratio`
  为 0–1 比例，`booster_wallet`（蛇形）/`boosterWallet`（驼峰）为加油包。
  个别新 key 无用量时服务端返回 `{}`，面板显示 "no usage data yet"。
- **DeepSeek**：`GET {base}/user/balance`，`Authorization: Bearer`，返回
  `balance_infos[].total_balance`（字符串金额，按货币符号展示）。

## License

[MIT](./LICENSE)
