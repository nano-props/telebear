# Telebear: Wrapper Package 分发计划

## 目标

用户执行 `bun install -g telebear` 后，frpc 二进制随包安装，无需手动配置系统依赖，直接可用。

SSH server 已改为使用 `ssh2` npm 包（纯 JS 实现），不再需要外部 dropbear 二进制。唯一需要平台特定二进制的外部依赖是 **frpc**。

---

## 架构概览

```
telebear (主包 - npm)
│
├── ssh2 (npm dependency, 纯 JS SSH server)
│
├── @telebear/frpc-darwin-arm64  (optionalDependency)
├── @telebear/frpc-darwin-x64    (optionalDependency)
├── @telebear/frpc-linux-arm64   (optionalDependency)
└── @telebear/frpc-linux-x64    (optionalDependency)
```

共 4 个平台子包 + 1 个主包 = 5 个 npm 包。

npm/bun 会根据 `os` + `cpu` 字段自动只安装匹配当前平台的 optionalDependencies，其余跳过。

---

## 1. 主包改动

### 1.1 package.json

```jsonc
{
  "name": "telebear",
  "version": "0.1.0",
  "bin": {
    "telebear": "./dist/telebear.js"
  },
  "dependencies": {
    "ssh2": "^1.17.0"
    // ... 其他现有依赖
  },
  "optionalDependencies": {
    "@telebear/frpc-darwin-arm64": "0.1.0",
    "@telebear/frpc-darwin-x64": "0.1.0",
    "@telebear/frpc-linux-arm64": "0.1.0",
    "@telebear/frpc-linux-x64": "0.1.0"
  }
}
```

### 1.2 新增 `src/bin-resolver.ts`

二进制查找模块，负责定位子包中的 frpc 二进制文件，找不到时回退到系统 PATH。

```ts
import { join, dirname } from 'node:path'

function resolvePackageBinary(name: string): string {
  const platform = process.platform   // 'darwin' | 'linux'
  const arch = process.arch           // 'arm64' | 'x64'
  const pkg = `@telebear/${name}-${platform}-${arch}`

  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`)
    return join(dirname(pkgJsonPath), 'bin', name)
  } catch {
    // 子包未安装（不支持的平台 or 用户手动排除），回退系统 PATH
    return name
  }
}

export const FRPC_BIN = process.env.TELEBEAR_FRPC_BIN ?? resolvePackageBinary('frpc')
```

### 1.3 修改 service 文件

- `src/services/frpc.ts`：将 `spawn('frpc', ...)` 改为 `spawn(FRPC_BIN, ...)`
- `src/services/sshd.ts`：无需改动（纯 JS，使用 `ssh2` npm 包）

### 1.4 构建

当前用 `bun build src/main.ts --compile --outfile dist/telebear` 会生成单个可执行文件。

改为发布 JS 模式后，需要：

```json
{
  "scripts": {
    "build": "bun build src/main.ts --outfile dist/telebear.js --target=node",
    "prepublishOnly": "bun run build"
  }
}
```

`bin` 入口 `dist/telebear.js` 开头需要 `#!/usr/bin/env bun`（或 `#!/usr/bin/env node`，取决于是否要求用户安装 bun）。

> **注意**：如果用 `--compile` 模式，二进制文件会被嵌入可执行文件，此时 `require.resolve` 可能无法工作。需要确认 bun compile 是否支持 resolve optionalDependencies 中的路径。若不支持，考虑不用 `--compile`，直接发布 JS + shebang。

---

## 2. frpc 平台子包结构

每个子包目录结构：

```
packages/@telebear/frpc-darwin-arm64/
├── package.json
└── bin/
    └── frpc
```

### 2.1 子包 package.json 示例

```json
{
  "name": "@telebear/frpc-darwin-arm64",
  "version": "0.61.1",
  "description": "frpc binary for macOS arm64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["bin/frpc"],
  "preferUnplugged": true
}
```

`preferUnplugged: true` 确保 Yarn PnP 等环境不会把二进制塞进 zip。

---

## 3. frpc 二进制获取

来源：[fatedier/frp GitHub Releases](https://github.com/fatedier/frp/releases)

官方提供所有平台的预编译 tar.gz，直接下载解压即可，无需自行编译。

| 子包 | 下载文件 |
|------|---------|
| frpc-darwin-arm64 | `frp_*_darwin_arm64.tar.gz` |
| frpc-darwin-x64 | `frp_*_darwin_amd64.tar.gz` |
| frpc-linux-arm64 | `frp_*_linux_arm64.tar.gz` |
| frpc-linux-x64 | `frp_*_linux_amd64.tar.gz` |

每个 tar.gz 中包含 `frpc` 和 `frps`，只需要 `frpc`。

---

## 4. CI/CD 自动化发布

使用 GitHub Actions：

```yaml
# .github/workflows/publish.yml
name: Publish

on:
  push:
    tags: ['v*']

jobs:
  publish-frpc:
    strategy:
      matrix:
        include:
          - platform: linux
            arch: x64
            frp_arch: amd64
          - platform: linux
            arch: arm64
            frp_arch: arm64
          - platform: darwin
            arch: arm64
            frp_arch: arm64
          - platform: darwin
            arch: x64
            frp_arch: amd64
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Download frpc
        run: |
          FRP_VERSION="0.61.1"
          wget "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${{ matrix.platform }}_${{ matrix.frp_arch }}.tar.gz"
          tar xzf frp_*.tar.gz
          mkdir -p packages/@telebear/frpc-${{ matrix.platform }}-${{ matrix.arch }}/bin
          cp frp_*/frpc packages/@telebear/frpc-${{ matrix.platform }}-${{ matrix.arch }}/bin/
          chmod +x packages/@telebear/frpc-${{ matrix.platform }}-${{ matrix.arch }}/bin/frpc
      - name: Publish
        run: cd packages/@telebear/frpc-${{ matrix.platform }}-${{ matrix.arch }} && npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  publish-main:
    needs: [publish-frpc]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install && bun run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 5. 版本管理策略

- 主包版本跟随 telebear 自身功能迭代
- frpc 子包版本号建议跟随 frpc 上游版本（如 `0.61.1`），方便追踪
- 主包 `optionalDependencies` 中用精确版本锁定或 `^` 范围语义

---

## 6. npm scope 注册

需要在 npm 上创建 `@telebear` organization（免费），才能发布 scoped 包。

步骤：
1. https://www.npmjs.com/org/create -> 创建 `telebear` org
2. scoped 包默认是 private，发布时需要 `npm publish --access public`

---

## 7. 本地开发体验

开发时不需要安装 frpc 子包，`bin-resolver.ts` 会自动回退到系统 PATH 中的 `frpc`。

可以通过环境变量覆盖路径：

```bash
TELEBEAR_FRPC_BIN=/usr/local/bin/frpc bun src/main.ts
```

---

## 8. 已完成

- [x] SSH server 从 dropbear（外部二进制）迁移到 ssh2（npm 包，纯 JS）
  - 不再需要 dropbear/dropbearkey 二进制
  - 不再需要 4 个 dropbear 平台子包
  - host key 使用 Node.js crypto 生成 ed25519 PEM 格式
  - 公钥认证通过 ssh2 utils.parseKey 在进程内完成

## 9. 待决事项

- [ ] 是否需要 Windows 支持？（frpc 支持 Windows，ssh2 也支持）
- [ ] 构建方式：`bun build --compile` vs JS + shebang？需要验证 compile 模式下 `require.resolve` 是否能找到 optionalDependencies
- [ ] npm org `@telebear` 是否可用
- [ ] 是否需要一个 `scripts/download-frpc.sh` 帮助本地快速打包测试
- [ ] frpc 锁定哪个上游版本
