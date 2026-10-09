/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import {
  initProfile, PROFILE_TEMPLATES, removeLinkProjections, sanitizeProfile, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
// DSH Desktop fork: 预装且默认启用的生态组合包（tarball 随签名包集提供，清单与
// prepare-package-set.ts 的 FORK_ROOT_PACKAGES 对齐；版本须与 apps/desktop/embedded/ 的
// tarball 保持同步）。恢复流程（disableAllPlugins）仍回退官方 WEB_PROFILE 基线，保证
// 最小可启动形态；dev 模式同样保持官方组合。
export const FORK_BUNDLE_VERSIONS = {
  'dsh-better-sidebar': '0.24.1',
  'dshmarket': '1.66.14',
  '@vibeinging/dsh-session-teams': '0.1.2',
  '@linxin666/dsh-client-ui-task-board': '0.4.5',
  'ds-harness-remote': '0.4.27',
  'dsh-multimedia-webui-input': '0.1.0',
  '@vibeinging/dsh-model-inheritance': '0.1.0',
  '@vibeinging/dsh-client-ui-worktree': '0.1.3',
  '@vibeinging/dsh-desktop-chrome': '0.1.0',
  '@vibeinging/dsh-desktop-shell': '0.1.1',
  'dsh-context': '0.66.1',
} as const
const FORK_PROFILE_BUNDLES = Object.keys(FORK_BUNDLE_VERSIONS).concat(['@deepseek-ai/dsh-experimental-schedule-bundle'])
const PROFILE_BUNDLES: readonly string[] = [...WEB_PROFILE.bundles, ...FORK_PROFILE_BUNDLES]

/**
 * DSH Desktop fork: 首启播种官方版本兼容豁免（profile 的 compatibility.json）。
 * 预装生态包的 peer 声明面向较旧的 DSH 线，boot 预检（compatibility-preflight）会拒绝其行；
 * 豁免等价于用户逐包 `dsh plugin allow-version --accept-risk` 的产品化预授权。
 * 合并式播种：文件不存在则全量写入；已存在则只补缺失的 fork 豁免键（fork bundle 升版本后
 * 键名随之变化，一次性播种会让升级安装被兼容预检拒绝）。既有键——包括用户经插件管理器
 * 手工授权的——原样保留；顶层结构非法则跳过，与官方 setter 的 rewritable 语义一致。
 * @param projectDir - Desktop profile 目录。
 * @param runtimeVersion - 精确 DSH 运行时版本（来自 desktop-runtime.json）。
 */
function seedForkProfileCompatibility(projectDir: string, runtimeVersion: string): void {
  const path = join(projectDir, 'compatibility.json')
  let exemptions: Record<string, string[]> = {}
  if (existsSync(path)) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return
      exemptions = value as Record<string, string[]>
    } catch {
      return
    }
  }
  let changed = false
  for (const [name, version] of Object.entries(FORK_BUNDLE_VERSIONS)) {
    const key = `${name}@${version}`
    if (exemptions[key] === undefined) {
      exemptions[key] = [runtimeVersion]
      changed = true
    }
  }
  if (changed) writeFileSync(path, `${JSON.stringify(exemptions, undefined, 2)}\n`, { mode: 0o600 })
}
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(() => {
      // Validation only: an unreadable or mismatched runtime descriptor stops preparation before the Host starts.
      const runtime = readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      createPluginProfile(this.paths.profile)
      seedForkProfileCompatibility(this.paths.profile, runtime.release.version)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, PROFILE_BUNDLES)
}
