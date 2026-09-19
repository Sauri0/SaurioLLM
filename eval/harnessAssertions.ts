import ts from 'typescript';

export interface ExportedSumCheck {
  ok: boolean;
  reason: string;
  examples: string[];
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isNumberType(node: ts.TypeNode | undefined): boolean {
  return node?.kind === ts.SyntaxKind.NumberKeyword;
}

/**
 * Comprueba la corrección de la función mínima del fixture sin ejecutar código generado por el
 * modelo. La prueba estructural `return a + b` (o `b + a`) demuestra el mismo resultado para todo
 * par numérico, incluidos positivos y negativos; los ejemplos quedan como evidencia legible.
 */
export function checkExportedSumFunction(source: string): ExportedSumCheck {
  const sourceFile = ts.createSourceFile('math.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    return { ok: false, reason: 'src/math.ts no parsea como TypeScript válido', examples: [] };
  }

  const namedDeclarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement)
      && statement.name?.text === 'suma',
  );
  if (namedDeclarations.length !== 1) {
    return {
      ok: false,
      reason: `se esperó una única función suma y se encontraron ${namedDeclarations.length}`,
      examples: [],
    };
  }

  const declaration = namedDeclarations[0];
  const exported = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  if (!exported) return { ok: false, reason: 'la función suma dejó de estar exportada', examples: [] };
  if (!declaration.body) return { ok: false, reason: 'la función suma no tiene implementación', examples: [] };
  if (declaration.parameters.length !== 2
    || declaration.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || !isNumberType(parameter.type))
    || !isNumberType(declaration.type)) {
    return { ok: false, reason: 'la firma original suma(number, number): number no se conservó', examples: [] };
  }

  const parameterNames = declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text);
  if (new Set(parameterNames).size !== 2) {
    return { ok: false, reason: 'los parámetros de suma no son dos identificadores distintos', examples: [] };
  }
  const returns = declaration.body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || declaration.body.statements.length !== 1 || !returns[0]?.expression) {
    return { ok: false, reason: 'suma debe conservar una implementación directa con un único return', examples: [] };
  }

  const expression = unwrapParentheses(returns[0].expression);
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
    return { ok: false, reason: 'el return de suma no usa la operación de suma', examples: [] };
  }
  const left = unwrapParentheses(expression.left);
  const right = unwrapParentheses(expression.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right)
    || new Set([left.text, right.text]).size !== 2
    || !parameterNames.includes(left.text) || !parameterNames.includes(right.text)) {
    return { ok: false, reason: 'el return no suma exactamente los dos parámetros originales', examples: [] };
  }

  return {
    ok: true,
    reason: 'única exportación suma(number, number): number con return de ambos parámetros',
    examples: ['suma(2, 3) = 5', 'suma(-4, 7) = 3', 'suma(-4, -6) = -10'],
  };
}
