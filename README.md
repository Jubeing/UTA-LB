# UTA-LB — Longbridge Broker for OpenAlice

OpenAlice UTA (Unified Trading Account) 的 Longbridge 券商适配器，支持港股、美股、新加坡股、ETF、期权等品种。

## 功能特性

| 功能 | 状态 |
|------|------|
| 港股窝轮、牛熊证 | ✅ |
| 美股、ETF、期权（OPRA） | ✅ |
| A股通 | ✅ |
| 实时行情（批量） | ✅ |
| 下单（市价/限价/竞价/止损） | ✅ |
| 改单 / 撤单 | ✅ |
| 持仓管理（含实时盈亏） | ✅ |
| Token 自动刷新（90天） | ✅ |
| 多币种账户汇总（USD/HKD/SGD） | ✅ |

## 安装到已有 OpenAlice 项目

```bash
# 1. 克隆本仓库
git clone https://github.com/Jubeing/UTA-LB.git
cd UTA-LB

# 2. 设置 OpenAlice 根目录（你已有的 OpenAlice 项目路径）
export OPENALICE_ROOT=/path/to/OpenAlice

# 3. 应用补丁（复制 broker 源码 + 注册到 registry）
node apply-patch.ts

# 4. 安装依赖 + 构建
cd $OPENALICE_ROOT
pnpm install
pnpm build

# 5. 重载
sudo systemctl restart openalice
```

## 目录结构

```
UTA-LB/
├── src/
│   └── domain/trading/brokers/
│       ├── types.ts              ← IBroker 接口 + 共享类型
│       ├── registry.ts            ← 券商注册表（含 Longbridge 入口）
│       ├── factory.ts             ← Broker 工厂
│       ├── index.ts               ← 统一导出
│       └── longbridge/
│           ├── LongbridgeBroker.ts  ← 核心 Broker 实现
│           ├── longbridge-contracts.ts ← Contract ↔ symbol 映射
│           ├── longbridge-types.ts    ← API 原始类型
│           ├── longbridge-auth.ts    ← OAuth2 + Token 刷新
│           └── index.ts
├── packages/longbridge/           ← npm 包（可选独立使用）
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── apply-patch.ts                 ← 一键安装脚本
└── README.md
```

## 依赖

- `longbridge@^4.0.0` — Longbridge OpenAPI SDK
- `@traderalice/ibkr` — OpenAlice IBKR 类型包（来自 OpenAlice 工作区）
- `decimal.js@^10.6.0` — 精确算术
- `zod@^3.24.2` — 配置校验

## Longbridge 开发者配置

1. 注册 Longbridge 开发者账号：https://open.longbridge.com
2. 创建一个应用，获取 `App Key` 和 `App Secret`
3. 在 OpenAlice → Trading → 添加账户 → Longbridge，填入：
   - `LONGBRIDGE_APP_KEY`
   - `LONGBRIDGE_APP_SECRET`
   - `LONGBRIDGE_ACCESS_TOKEN`（从开发者门户获取）
   - `LONGBRIDGE_REFRESH_TOKEN`（用于自动续期）

## Token 刷新

Access Token 有效期约 90 天，系统会在**到期前 7 天**自动刷新（需配置 `LONGBRIDGE_REFRESH_TOKEN`）。

手动刷新：在 Trading → 编辑账户 → 点击 Token 字段旁的 ↻ 按钮。

## 参考

- [OpenAlice](https://github.com/TraderAlice/OpenAlice)
- [Longbridge OpenAPI 文档](https://open.longbridge.com/zh-CN/docs)
- [Longbridge OAuth2 接入指南](https://open.longbridge.com/zh-CN/docs/how-to-access-api)
