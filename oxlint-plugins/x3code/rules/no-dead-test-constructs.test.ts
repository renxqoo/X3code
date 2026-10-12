import { describe, expect, test } from 'bun:test'

import { lintTree, MINI_TREE, ruleCount } from '../test/utils.ts'

const RULE = 'no-dead-test-constructs'

const source = (body: string, path = 'packages/ui/src/a.ts'): ReturnType<typeof lintTree> =>
  lintTree({ ...MINI_TREE, [path]: body }, path)

describe('x3code/no-dead-test-constructs', () => {
  // 规则存在的事实依据：一轮修复的护栏用了 RNTL v14 已删除的查询，断言从未执行，
  // 但测试仍能编译并被当作「加了回归用例」——门禁对真实缺陷失明。
  test.each([
    ['view.UNSAFE_getAllByProps', 'view.UNSAFE_getAllByProps({ children: "x" })'],
    ['view.UNSAFE_getByProps', 'view.UNSAFE_getByProps({ children: "x" })'],
    ['view.UNSAFE_queryAllByProps', 'view.UNSAFE_queryAllByProps({ children: "x" })'],
    ['screen.UNSAFE_getAllByType', 'screen.UNSAFE_getAllByType(Text)'],
  ])('%s：报（断言永不执行）', (name, call) => {
    const result = source(`${call};\n`)
    expect(result.exitCode).toBe(1)
    expect(ruleCount(result.stdout, RULE)).toBe(1)
  })

  test.each([
    ['getByText（受支持查询）', 'view.getByText("发送失败")'],
    ['queryByLabelText', 'view.queryByLabelText("发送消息")'],
    ['toJSON（v14 推荐替代）', 'view.toJSON()'],
    ['UNSAFE_* 挂在非渲染面上不归本规则管', 'helper.UNSAFE_getAllByProps({})'],
  ])('%s：不报', (name, call) => {
    const result = source(`${call};\n`)
    expect(ruleCount(result.stdout, RULE)).toBe(0)
  })

  test.each(['error', 'err', 'reason', 'cause'])('catch (%s) 被 void 吞掉：报', (binding) => {
    const result = source(`try {\n  run();\n} catch (${binding}) {\n  void ${binding};\n}\n`)
    expect(result.exitCode).toBe(1)
    expect(ruleCount(result.stdout, RULE)).toBe(1)
  })

  test.each([
    ['空形态降级（AGENTS.md 允许的垃圾输入降级）', 'try {\n  run();\n} catch (error) {\n  return null;\n}\n'],
    ['catch 里用了错误（可见化）', 'try {\n  run();\n} catch (error) {\n  report(error);\n}\n'],
    ['void 的不是 catch 绑定', 'void somePromise;\n'],
    ['非 error 名的普通标识符', 'void taskId;\n'],
  ])('%s：不报', (name, body) => {
    const result = source(body)
    expect(ruleCount(result.stdout, RULE)).toBe(0)
  })
})