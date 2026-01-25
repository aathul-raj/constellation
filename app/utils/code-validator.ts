/**
 * Code Validator - Validates generated Python code before applying
 * Uses AST-like validation patterns for reliability
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  fixedCode?: string;
}

export interface CodeContext {
  expectedParams: string[];   // Expected parameter names from parents
  nodeNames?: string[];       // Names of nodes in the graph (for reference validation)
  nodeName?: string;          // Name of the current node (optional)
  parentNodeNames?: string[]; // Names of upstream nodes (optional)
}

/**
 * Convert node name to valid Python parameter name
 */
export function toParamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'input';
}

/**
 * Extract function signature from code
 */
export function extractFunctionSignature(code: string): { name: string; params: string[] } | null {
  const match = code.match(/def\s+(\w+)\s*\(\s*([^)]*)\s*\)/);
  if (!match) return null;
  
  const params = match[2]
    .split(',')
    .map(p => p.trim().split(':')[0].split('=')[0].trim())
    .filter(p => p.length > 0);
  
  return { name: match[1], params };
}

/**
 * Check if code has a return statement
 */
export function hasReturnStatement(code: string): boolean {
  // Look for return statement that's not in a comment
  const lines = code.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (/\breturn\s+/.test(trimmed)) return true;
  }
  return false;
}

/**
 * Check if one string is an abbreviation/variation of another
 * e.g., "temp_ma" could be an abbreviation of "temperature_moving_average"
 */
export function isAbbreviationOf(abbrev: string, full: string): boolean {
  const abbrevParts = abbrev.toLowerCase().split('_');
  const fullParts = full.toLowerCase().split('_');

  // Each part of abbrev should match the start of a corresponding part in full
  let fullIdx = 0;
  for (const abbrevPart of abbrevParts) {
    let found = false;
    while (fullIdx < fullParts.length) {
      if (fullParts[fullIdx].startsWith(abbrevPart) ||
          abbrevPart.startsWith(fullParts[fullIdx].substring(0, 2))) {
        found = true;
        fullIdx++;
        break;
      }
      fullIdx++;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Find the best matching parameter for a potential abbreviation
 */
export function findMatchingParam(varName: string, params: string[]): string | null {
  // Direct match
  if (params.includes(varName)) return varName;

  // Check if it's an abbreviation of any parameter
  for (const param of params) {
    if (isAbbreviationOf(varName, param)) {
      return param;
    }
  }

  // Check for common abbreviation patterns
  const abbrevMap: Record<string, string[]> = {
    'temp': ['temperature', 'temporal', 'temp'],
    'ma': ['moving_average', 'ma'],
    'avg': ['average', 'avg'],
    'df': ['dataframe', 'data_frame', 'df'],
    'col': ['column', 'col'],
    'idx': ['index', 'idx'],
    'val': ['value', 'val'],
    'num': ['number', 'num'],
    'cnt': ['count', 'cnt'],
    'ph': ['ph'],
    'time': ['time'],
  };

  const varParts = varName.toLowerCase().split('_');

  for (const param of params) {
    const paramParts = param.toLowerCase().split('_');
    let matchScore = 0;

    for (const varPart of varParts) {
      for (const paramPart of paramParts) {
        // Check if varPart is an abbreviation that could match paramPart
        const expansions = abbrevMap[varPart] || [varPart];
        for (const expansion of expansions) {
          if (paramPart.includes(expansion) || expansion.includes(paramPart)) {
            matchScore++;
            break;
          }
        }
      }
    }

    // If we matched most parts, it's likely the right parameter
    if (matchScore >= varParts.length * 0.6) {
      return param;
    }
  }

  return null;
}

/**
 * Check if code references undefined variables
 */
export function findUndefinedReferences(code: string, definedParams: string[]): string[] {
  const undefined: string[] = [];
  const defined = new Set(definedParams);

  // Common built-ins and imports
  const builtins = new Set([
    'pd', 'np', 'pandas', 'numpy', 'os', 'sys', 'json', 'math',
    'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
    'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'print',
    'True', 'False', 'None', 'self', 'cls', 'out_df', 'result',
    'axis', 'inplace', 'how', 'on', 'left', 'right', 'inner', 'outer',
    'index', 'columns', 'values', 'iloc', 'loc', 'copy', 'merge',
    'concat', 'groupby', 'apply', 'transform', 'agg', 'rolling', 'mean',
    'sum', 'min', 'max', 'count', 'std', 'var', 'median', 'mode',
    'drop', 'dropna', 'fillna', 'replace', 'rename', 'reset_index',
    'datetime', 'timedelta', 'date', 'time'
  ]);

  // Track variables defined in the code
  const lines = code.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    // Track assignments
    const assignMatch = trimmed.match(/^(\w+)\s*=/);
    if (assignMatch) {
      defined.add(assignMatch[1]);
    }

    // Track for loop variables
    const forMatch = trimmed.match(/^for\s+(\w+)\s+in/);
    if (forMatch) {
      defined.add(forMatch[1]);
    }

    // Track import statements
    const importMatch = trimmed.match(/^(?:import\s+(\w+)|from\s+\w+\s+import\s+(.+))/);
    if (importMatch) {
      if (importMatch[1]) defined.add(importMatch[1]);
      if (importMatch[2]) {
        importMatch[2].split(',').forEach(m => {
          const name = m.trim().split(' as ').pop()?.trim();
          if (name) defined.add(name);
        });
      }
    }
  }

  // Find all identifiers used in the code (potential variable references)
  const identifierRegex = /\b([a-z_][a-z0-9_]*)\b/gi;
  const usedIdentifiers = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    let match;
    while ((match = identifierRegex.exec(line)) !== null) {
      const identifier = match[1];
      // Skip keywords, builtins, and string literals
      if (!builtins.has(identifier) &&
          !['def', 'return', 'import', 'from', 'as', 'if', 'else', 'elif', 'for', 'in', 'while', 'try', 'except', 'finally', 'with', 'class', 'and', 'or', 'not', 'is', 'lambda', 'pass', 'break', 'continue', 'raise', 'yield', 'global', 'nonlocal', 'assert', 'del'].includes(identifier)) {
        usedIdentifiers.add(identifier);
      }
    }
  }

  // Check each used identifier
  for (const identifier of usedIdentifiers) {
    if (!defined.has(identifier) && !builtins.has(identifier)) {
      // Check if it looks like it could be an abbreviation of a parameter
      const matchingParam = findMatchingParam(identifier, definedParams);
      if (matchingParam && matchingParam !== identifier) {
        // It's an undefined abbreviation of a parameter
        undefined.push(identifier);
      } else if (!matchingParam) {
        // Check common mistakes
        if (['in_df', 'input_df', 'input_data', 'df', 'data'].includes(identifier)) {
          undefined.push(identifier);
        }
      }
    }
  }

  return [...new Set(undefined)];
}

/**
 * Validate Python code for a compute node
 */
export function validatePythonCode(code: string, context: CodeContext): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let fixedCode = code;
  
  // 1. Check for function definition
  const sig = extractFunctionSignature(code);
  if (!sig) {
    errors.push('Code must define a "task" function');
    return { valid: false, errors, warnings };
  }
  
  if (sig.name !== 'task') {
    errors.push(`Function must be named "task", found "${sig.name}"`);
  }
  
  // 2. Validate parameter names match expected
  if (context.expectedParams.length > 0) {
    const expectedSet = new Set(context.expectedParams);
    const actualSet = new Set(sig.params);
    
    // Check for mismatched params
    for (const expected of context.expectedParams) {
      if (!actualSet.has(expected)) {
        // Check if there's a different param that could be renamed
        const possibleMismatch = sig.params.find(p => !expectedSet.has(p));
        if (possibleMismatch) {
          warnings.push(`Parameter "${possibleMismatch}" should be "${expected}" based on parent node name`);
          // Auto-fix: replace wrong param with correct one
          const paramRegex = new RegExp(`\\b${possibleMismatch}\\b`, 'g');
          fixedCode = fixedCode.replace(paramRegex, expected);
        }
      }
    }
  }
  
  // 3. Check for undefined variable references
  const undefinedRefs = findUndefinedReferences(code, sig.params);
  if (undefinedRefs.length > 0) {
    for (const ref of undefinedRefs) {
      // Try to find a matching parameter (handles abbreviations like temp_ma -> temperature_moving_average)
      const matchingParam = findMatchingParam(ref, sig.params);

      if (matchingParam && matchingParam !== ref) {
        warnings.push(`Replacing abbreviated "${ref}" with parameter "${matchingParam}"`);
        const refRegex = new RegExp(`\\b${ref}\\b`, 'g');
        fixedCode = fixedCode.replace(refRegex, matchingParam);
      } else if (['in_df', 'input_df', 'input_data', 'df', 'data'].includes(ref) && sig.params.length > 0) {
        // Fallback for common input variable names
        const correctParam = sig.params[0];
        warnings.push(`Replacing undefined "${ref}" with parameter "${correctParam}"`);
        const refRegex = new RegExp(`\\b${ref}\\b`, 'g');
        fixedCode = fixedCode.replace(refRegex, correctParam);
      } else {
        errors.push(`Undefined variable: "${ref}"`);
      }
    }
  }
  
  // 4. Check for return statement
  if (!hasReturnStatement(code)) {
    warnings.push('No return statement found, adding default return');
    // Check if out_df is defined
    if (code.includes('out_df')) {
      fixedCode = fixedCode.trimEnd() + '\n    return out_df\n';
    } else if (sig.params.length > 0) {
      fixedCode = fixedCode.trimEnd() + `\n    return ${sig.params[0]}\n`;
    }
  }
  
  // 5. Check for common syntax issues
  const syntaxPatterns = [
    { pattern: /:\s*\n\s*\n\s*return/, issue: 'Empty function body before return' },
    { pattern: /def\s+task\s*\(\s*\)\s*:/, issue: 'Function has no parameters but should receive input data' },
  ];
  
  for (const { pattern, issue } of syntaxPatterns) {
    if (pattern.test(code) && context.expectedParams.length > 0) {
      warnings.push(issue);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fixedCode: fixedCode !== code ? fixedCode : undefined
  };
}

/**
 * Build correct function signature for a node
 */
export function buildFunctionSignature(parentNodeNames: string[]): string {
  if (parentNodeNames.length === 0) {
    return 'def task():';
  }
  const params = parentNodeNames.map(toParamName).join(', ');
  return `def task(${params}):`;
}

/**
 * Fix generated code to match expected context
 */
export function fixGeneratedCodeAdvanced(code: string, context: CodeContext): string {
  const validation = validatePythonCode(code, context);
  
  if (validation.fixedCode) {
    return validation.fixedCode;
  }
  
  // If function signature is wrong, fix it
  const sig = extractFunctionSignature(code);
  if (sig && context.expectedParams.length > 0) {
    const parentNames = context.parentNodeNames || context.expectedParams.map(p => p);
    const expectedSig = buildFunctionSignature(parentNames);
    const currentSig = `def ${sig.name}(${sig.params.join(', ')}):`;
    
    if (currentSig !== expectedSig.replace(':', ':')) {
      code = code.replace(/def\s+\w+\s*\([^)]*\)\s*:/, expectedSig);
      
      // Also fix any references to old param names
      if (sig.params.length > 0 && context.expectedParams.length > 0) {
        const oldParam = sig.params[0];
        const newParam = context.expectedParams[0];
        if (oldParam !== newParam) {
          const paramRegex = new RegExp(`\\b${oldParam}\\b`, 'g');
          code = code.replace(paramRegex, newParam);
        }
      }
    }
  }
  
  return code;
}

/**
 * Validate that an edit_node response actually makes changes
 */
export function validateEditNodeResponse(
  response: any,
  currentGraph: { nodes: any[]; edges?: any[] }
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check if nodeId exists
  if (response.nodeId) {
    const exists = currentGraph.nodes.some(n => n.id === response.nodeId);
    if (!exists) {
      issues.push(`Node ID "${response.nodeId}" does not exist in graph`);
    }
  } else if (response.nodeName) {
    const exists = currentGraph.nodes.some(
      n => n.name.toLowerCase() === response.nodeName.toLowerCase()
    );
    if (!exists) {
      issues.push(`Node "${response.nodeName}" does not exist in graph`);
    }
  } else {
    issues.push('edit_node response must include nodeId or nodeName');
  }

  // Check if any actual changes are specified
  const changeFields = [
    'newInConnections', 'newOutConnections',
    'addInConnections', 'addOutConnections',
    'removeInConnections', 'removeOutConnections',
    'newCode', 'parallelization'
  ];

  const hasChanges = changeFields.some(field => {
    const value = response[field];
    return value !== undefined && value !== null &&
      (Array.isArray(value) ? value.length > 0 : true);
  });

  if (!hasChanges) {
    issues.push('edit_node response must specify at least one change (connections or code)');
  }

  // Validate connection references
  const connectionFields = [
    'newInConnections', 'newOutConnections',
    'addInConnections', 'addOutConnections',
    'removeInConnections', 'removeOutConnections'
  ];

  for (const field of connectionFields) {
    const connections = response[field];
    if (Array.isArray(connections)) {
      for (const conn of connections) {
        const exists = currentGraph.nodes.some(
          n => n.id === conn || n.name.toLowerCase() === conn.toLowerCase()
        );
        if (!exists) {
          issues.push(`Connection reference "${conn}" in ${field} does not exist`);
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Verify that a code edit actually modified the code as intended
 * Returns issues if the code wasn't actually changed or the edit wasn't applied
 */
export function verifyCodeChange(
  oldCode: string,
  newCode: string,
  userRequest: string
): { changed: boolean; issues: string[] } {
  const issues: string[] = [];

  // Normalize whitespace for comparison
  const normalizeCode = (code: string) =>
    code.replace(/\s+/g, ' ').trim();

  const oldNormalized = normalizeCode(oldCode);
  const newNormalized = normalizeCode(newCode);

  // Check if code is actually different
  if (oldNormalized === newNormalized) {
    issues.push('Code was not modified - the new code is identical to the existing code');
    return { changed: false, issues };
  }

  // Try to detect specific value changes from user request
  // Pattern: "change X to Y", "set X to Y", "update X to Y", "X should be Y", "X to Y"
  const valueChangePatterns = [
    /(?:change|set|update|modify)\s+(?:the\s+)?(\w+)\s+(?:from\s+)?(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)/i,
    /(\w+)\s+(?:from\s+)?(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)/i,
    /(?:window|size|value|count|number)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s+(?:to|should\s+be|becomes?)\s+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s+(?:to|instead\s+of|rather\s+than)\s+(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of valueChangePatterns) {
    const match = userRequest.match(pattern);
    if (match) {
      // Extract old and new values
      const groups = match.slice(1).filter(g => g && /^\d+(?:\.\d+)?$/.test(g));
      if (groups.length >= 2) {
        const oldValue = groups[0];
        const newValue = groups[1];

        // Check if old value was in old code but not in new
        const oldHadValue = oldCode.includes(oldValue);
        const newHasNewValue = newCode.includes(newValue);

        if (oldHadValue && !newHasNewValue) {
          issues.push(`Expected value "${oldValue}" to be changed to "${newValue}", but the new value doesn't appear in the code`);
        }

        // If the old value is still in the new code and the new value isn't, that's a problem
        if (oldHadValue && newCode.includes(oldValue) && !newHasNewValue) {
          issues.push(`The old value "${oldValue}" is still in the code but the new value "${newValue}" was not added`);
        }
      }
    }
  }

  return { changed: issues.length === 0, issues };
}
