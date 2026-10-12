import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// x3code 插件测试 harness：系统临时目录拼最小 workspace 树，
// 用真实 oxlint + 本插件 lint 指定文件，断言完即清理；仓库内不落违规样本。
// 经当前运行时（process.execPath）执行 oxlint 的 dist/cli.js——.bin shim 的
// shebang 是 node，直接调 shim 会引入「PATH 必须有 node」的隐藏环境依赖。
const pluginDir = join(import.meta.dirname, '..')
const oxlintCli = join(pluginDir, '../../node_modules/oxlint/dist/cli.js')

export interface LintResult {
  exitCode: number | null
  stdout: string
}

export function lintTree(files: Record<string, string>, lintTarget: string): LintResult {
  const root = mkdtempSync(join(tmpdir(), 'x3code-oxlint-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    for (const [dir, name] of [
      ['packages/contracts', '@x3code/contracts'],
      ['packages/core', '@x3code/core'],
      ['packages/infra', '@x3code/infra'],
      ['packages/api', '@x3code/api'],
      ['packages/ui', '@x3code/ui'],
      ['packages/ui-thread', '@x3code/ui-thread'],
      ['packages/testkit', '@x3code/testkit'],
      ['apps/electron', '@x3code/electron'],
    ] as const) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }))
    }
    writeFileSync(
      join(root, '.oxlintrc.json'),
      JSON.stringify({
        jsPlugins: [join(pluginDir, 'index.ts')],
        rules: {
          'x3code/no-dead-test-constructs': 'error',
          'x3code/no-electron-outside-host': 'error',
          'x3code/no-cross-package-imports': 'error',
          'x3code/no-node-in-browser-code': 'error',
        },
      }),
    )
    const proc = spawnSync(process.execPath, [oxlintCli, '-c', '.oxlintrc.json', lintTarget], {
      cwd: root,
      encoding: 'utf8',
    })
    return { exitCode: proc.status, stdout: proc.stdout }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export function ruleCount(stdout: string, rule: string): number {
  return stdout.split(`x3code(${rule})`).length - 1
}

/** 基础合规树：各分区各一个干净文件。 */
export const MINI_TREE: Record<string, string> = {
  'packages/contracts/src/a.ts': "import { z } from 'zod';\nexport const x = z;\n",
  'packages/core/src/a.ts': "import type {} from '@x3code/contracts';\nexport {};\n",
  'packages/ui/src/a.ts': "import type {} from '@x3code/contracts';\nexport {};\n",
  'apps/electron/src/main/a.ts': "import { join } from 'node:path';\nexport const j = join;\n",
  'apps/electron/src/renderer/src/a.tsx': "import type {} from '@x3code/ui';\nexport {};\n",
}
