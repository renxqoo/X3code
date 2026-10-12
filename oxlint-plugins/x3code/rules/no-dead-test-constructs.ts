import { defineRule } from '@oxlint/plugins'
import type { Context, ESTree } from '@oxlint/plugins'

// 装死的测试写法拦截。
//
// 这条规则存在的事实依据：一轮修复里，护栏测试用了 RNTL v14 已移除的
// UNSAFE_* 查询。断言从未执行，但测试仍能编译、运行即报 TypeError，被当作
// 「失败但原因不明」放过——门禁对真实缺陷完全失明，而报告里写着「已加回归用例」。
// 装死的护栏比没有护栏更危险：它给出的正是虚假安全感。

/** RNTL v14 起删除的 UNSAFE_* 查询（按 props / type 匹配的那批）。 */
const REMOVED_RNTL_QUERIES = new Set([
  'UNSAFE_getAllByProps',
  'UNSAFE_getByProps',
  'UNSAFE_queryAllByProps',
  'UNSAFE_queryByProps',
  'UNSAFE_getAllByType',
  'UNSAFE_getByType',
  'UNSAFE_queryAllByType',
  'UNSAFE_queryByType',
])

/** catch 绑定名里，这些被 void 掉即等于吞掉异常。 */
const CATCH_BINDINGS = new Set(['error', 'err', 'reason', 'cause'])

/** 渲染查询面的接收者。 */
const QUERY_RECEIVERS = new Set(['view', 'screen'])

/**
 * 静态成员访问的接收者名与方法名。
 *
 * oxlint 的 MemberExpression 是平铺形态：a.b 的 object 是 Identifier(a)、property 是
 * Identifier(b)，不带 ESTree 那种 object 自身是 MemberExpression 的嵌套。按嵌套去读
 * 会拿到 null 而静默漏报——这类「按标准 AST 假设写却静默不生效」的缺陷与本规则要拦的
 * 装死测试同性质，故在此注明。
 */
function memberParts(node: ESTree.Node | null | undefined): { receiver: string | null; method: string | null } {
  if (node === null || node === undefined || node.type !== 'MemberExpression') {
    return { receiver: null, method: null }
  }
  const method = node.property.type === 'Identifier' ? node.property.name : null
  const object = node.object
  return { receiver: object.type === 'Identifier' ? object.name : null, method }
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow silently-dead test constructs (RNTL queries removed in v14, swallowed catch bindings).',
    },
    messages: {
      removedQuery:
        "'{{name}}' was removed in @testing-library/react-native v14 — this assertion never runs. Use toJSON()/byTestId or a supported query.",
      swallowedCatch:
        "catch binding '{{name}}' is discarded by 'void {{name}}' — the failure is reported nowhere. Return an empty shape or surface it.",
    },
  },
  create(context: Context) {
    return {
      CallExpression(node: ESTree.CallExpression): void {
        const { receiver, method } = memberParts(node.callee)
        if (method === null || !REMOVED_RNTL_QUERIES.has(method)) return
        // 只认渲染查询面（view./screen.）：别的对象上的同名方法与本规则无关
        if (receiver === null || !QUERY_RECEIVERS.has(receiver)) return
        context.report({ node, messageId: 'removedQuery', data: { name: method } })
      },

      UnaryExpression(node: ESTree.UnaryExpression): void {
        if (node.operator !== 'void') return
        const argument = node.argument
        if (argument.type !== 'Identifier') return
        if (!CATCH_BINDINGS.has(argument.name)) return
        context.report({ node, messageId: 'swallowedCatch', data: { name: argument.name } })
      },
    }
  },
})