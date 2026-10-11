/**
 * Project-specific lint rules for security (see docs/secure-development.md).
 *
 * gmemo/no-sql-interpolation
 *   SQL text must not have values spliced in: pass them as `?` parameters.
 *   Allowed without comment:
 *   - placeholder lists like `${ids.map(() => '?').join(',')}`
 *   - SQL fragments whose name ends in `Sql` (`${whereSql}`, `${colSql(0)}`): by
 *     convention such a value is fixed SQL text built in code, never input
 *   Anything else needs
 *     // eslint-disable-next-line gmemo/no-sql-interpolation -- <why it is not user input>
 *   so that every exception is visible in review.
 */
const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE|DROP|ALTER|WHERE|VALUES)\b/;

/** `xs.map(() => '?').join(…)` */
function isPlaceholderList(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
  if (node.callee.property.name !== 'join') return false;
  const map = node.callee.object;
  if (map.type !== 'CallExpression' || map.callee.type !== 'MemberExpression') return false;
  if (map.callee.property.name !== 'map') return false;
  const fn = map.arguments[0];
  return (
    !!fn &&
    (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') &&
    fn.body.type === 'Literal' &&
    fn.body.value === '?'
  );
}

/** `fooSql` or `fooSql(…)` / `x.fooSql`: a value named as SQL text. */
function isSqlFragment(node) {
  const name = (n) =>
    n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' ? name(n.property) : '';
  if (node.type === 'CallExpression') return /Sql$/.test(name(node.callee));
  return /Sql$/.test(name(node));
}

const noSqlInterpolation = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow values interpolated into SQL text' },
    messages: {
      interpolated:
        'SQLに値を埋め込まないでください。値は ? で渡します。コードで組み立てた固定のSQL断片なら、名前を …Sql にしてください。',
    },
    schema: [],
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        if (node.expressions.length === 0) return;
        if (node.parent?.type === 'TaggedTemplateExpression') return;
        const text = node.quasis.map((q) => q.value.cooked ?? '').join(' ');
        if (!SQL.test(text)) return;
        if (node.expressions.every((e) => isPlaceholderList(e) || isSqlFragment(e))) return;
        context.report({ node, messageId: 'interpolated' });
      },
    };
  },
};

export default { rules: { 'no-sql-interpolation': noSqlInterpolation } };
