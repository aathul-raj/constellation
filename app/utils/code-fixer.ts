/**
 * Fixes common code generation issues, particularly variable reference mismatches
 */

export interface CodeFixContext {
  functionSignature: string; // e.g., "def task(replace_with_ones):"
  inputParamName: string;    // e.g., "replace_with_ones"
}

/**
 * Extracts the input parameter name from a function signature
 * e.g., "def task(input_data):" -> "input_data"
 */
export function extractInputParamName(signature: string): string {
  const match = signature.match(/def\s+task\s*\(\s*(\w+)\s*\)\s*:/);
  return match ? match[1] : 'input';
}

/**
 * Fixes variable references in generated code
 * Ensures that the actual parameter name is used instead of hardcoded 'in_df'
 */
export function fixVariableReferences(code: string, inputParamName: string): string {
  // If the code uses 'in_df' but the parameter is something else, replace it
  if (inputParamName !== 'input' && inputParamName !== 'in_df') {
    // Replace 'in_df' with the actual parameter name, but be careful with:
    // - Comments (don't replace)
    // - String literals (don't replace)
    // - Already correct references (don't double-replace)

    const lines = code.split('\n');
    const fixedLines = lines.map(line => {
      // Skip comments
      if (line.trim().startsWith('#')) {
        return line;
      }

      // Skip lines that are just strings or already use correct param
      if (line.includes(`${inputParamName}.`)) {
        return line;
      }

      // Replace in_df with the actual parameter name
      // This regex handles: in_df.method, in_df['col'], in_df[col], etc.
      const fixedLine = line.replace(/\bin_df\b/g, inputParamName);
      return fixedLine;
    });

    return fixedLines.join('\n');
  }

  return code;
}

/**
 * Ensures the code initializes output correctly
 * If the code modifies data but doesn't initialize out_df, add the initialization
 */
export function ensureOutputInitialization(code: string, inputParamName: string): string {
  // Check if out_df is initialized
  const hasOutDfInit = code.includes('out_df =');

  if (!hasOutDfInit) {
    // Find the first line after imports
    const lines = code.split('\n');
    let insertIndex = 0;
    let foundLastImport = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('import ') || lines[i].trim().startsWith('from ')) {
        insertIndex = i + 1;
        foundLastImport = true;
      } else if (foundLastImport && lines[i].trim() !== '') {
        // We've hit a non-import, non-empty line
        break;
      }
    }

    // Add initialization after imports if not already there
    if (insertIndex > 0 && !lines[insertIndex].includes('out_df =')) {
      lines.splice(insertIndex, 0, `    out_df = ${inputParamName}.copy()`);
    }

    return lines.join('\n');
  }

  return code;
}

/**
 * Ensures the code returns the output
 */
export function ensureReturnStatement(code: string): string {
  const lines = code.split('\n');

  // Check if the last non-empty line is a return statement
  let lastNonEmptyIndex = lines.length - 1;
  while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex].trim() === '') {
    lastNonEmptyIndex--;
  }

  if (lastNonEmptyIndex >= 0 && !lines[lastNonEmptyIndex].includes('return')) {
    lines.push('    return out_df');
  }

  return lines.join('\n');
}

/**
 * Comprehensive code fixing function
 */
export function fixGeneratedCode(code: string, inputParamName: string): string {
  let fixed = code;

  // Fix variable references first
  fixed = fixVariableReferences(fixed, inputParamName);

  // Ensure output is initialized
  fixed = ensureOutputInitialization(fixed, inputParamName);

  // Ensure return statement
  fixed = ensureReturnStatement(fixed);

  return fixed;
}
