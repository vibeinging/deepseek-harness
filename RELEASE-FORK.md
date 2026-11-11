# DSH Desktop（新一代）发版规范

> 自 v0.2.2-rc.1.20261109.1（2026-11-11 转正）起，DSH Desktop 只维护本线（fork 仓库）。
> 版本号铁律：应用版本 = 上游 DSH 运行时版本（prepare-dsh 硬校验）；`--build-version` 只允许
> `<产品版本>.<日期>.<序号>` 延伸。旧自研壳线（vibeinging/dsh-desktop 仓库 0.1.x–0.2.5）已存档。

## 单线发版流程（mac 本地 + win CI + 双清单）

以 `0.2.2-rc.1.20261110.1` 为例（替换为实际日期序号）：

### 1. mac 构建（本机，签名 + 公证）

```bash
cd official-desktop-spike/fork020rc1        # fork-0.2.2-rc.1 分支，工作树必须干净
pnpm run --dir apps/desktop package:mac:arm64 -- --build-version 0.2.2-rc.1.20261110.1
# 产物：apps/desktop/.desktop-build/targets/mac-arm64/artifacts/
#   dsh-desktop-<v>-mac-arm64.{dmg,zip} + zip.blockmap + nightly-mac.yml
```

构建环境前提：`/opt/homebrew/bin/pnpm` 的 11.7+ shim、arm64 node ≥22.13（幽灵 pnpm 8 会重写
lockfile 致 extract-zip 挂死）；构建期间禁跑会杀应用的探针。

### 2. Windows 构建（CI，未签名）

```bash
gh workflow run -R vibeinging/deepseek-harness fork-windows-release.yml \
  --ref fork-0.2.2-rc.1 -f build_version=0.2.2-rc.1.20261110.1
# 产物 artifact: fork-win-x64-unsigned
#   dsh-desktop-<v>-win-x64-unsigned.exe + .blockmap（不产 nightly.yml，需手写，见步骤 3）
```

已知坑（2026-11-11 打通实录）：windows-2025 的 D: 卷不支持 reflink（禁 `--package-import-method=clone`）；
打包需 `.env.windows`（工作流已内置非机密配置，与 mac 同源同 release ID）；产物在
`.desktop-build/targets/win-x64/unsigned-artifacts/`，文件名带 `-unsigned` 后缀
（网站重定向器正则已放行该后缀）。

### 3. 组装 Release（vibeinging/dsh-desktop 仓库）

```bash
# nightly.yml 需按 mac 的 nightly-mac.yml schema 手写：sha512=exe 的 base64 摘要、size、url=exe 文件名
gh release create v<v> --latest --title "DSH Desktop v<v>（…）" --notes-file notes.md \
  <mac dmg> <mac zip> <mac zip.blockmap> <nightly-mac.yml> \
  <win exe> <win exe.blockmap> <nightly.yml>
```

7 资产清单：mac dmg/zip/zip.blockmap/nightly-mac.yml + win exe/exe.blockmap/nightly.yml。

### 4. 发版验收

- `releases/latest` 指向新 Release；非 prerelease（本线已转正，不再用预发布）
- 三条 feed 全 302：
  - `/dsh-desk/548def65905294bc5f1714aedb04867d/feeds/mac-arm64/nightly-mac.yml`
  - `/dsh-desk/…/feeds/win-x64/nightly.yml`
  - 任一二进制名（带 `-unsigned` 后缀也必须 302）
- 官网 `/api/downloads` 的 latest 切到新版本；下载页按钮资产解析正常
- （有更新器变更时）真机从上一版走一次应用内更新

### 5. 网站同步

版本叙事字符串、预装计数与钉版、社区卡墙（版本号）、FAQ（如涉及升级路径变化）。
当前预装 10 = 6 社区 + 4 自研，权威清单 = `apps/desktop/src/project-manager.ts` 的
`FORK_BUNDLE_VERSIONS`。

### 6. 上游 rebase（跟随 0.2.2+ 线时）

建分支先 `git merge-base --is-ancestor <上游tag> HEAD` 验证基线 + 查 root version，
再 cherry-pick fork 提交；生态包同步升 0.2.x 时代版本；`PREINSTALLED_BUNDLES_NOTICES.md`
与 `FORK_BUNDLE_VERSIONS` 保持一致；退役走 `FORK_RETIRED_BUNDLES` 双向清单。
