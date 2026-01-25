import { HPCNode, HPCGraph } from '@/app/store/hpc-store';

/**
 * Convert a node name to a valid Python parameter name in snake_case
 * Examples:
 *   "Raw Sales Data" -> "raw_sales_data"
 *   "CSV Input" -> "csv_input"
 *   "Inventory-Config" -> "inventory_config"
 */
export function nodeNameToParamName(nodeName: string): string {
  return nodeName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/[\s-]+/g, '_') // Replace spaces and hyphens with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
}

/**
 * Extract imports from code
 * Returns all lines that start with 'import' or 'from'
 */
export function extractImports(code: string): string {
  const lines = code.split('\n');
  const importLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      importLines.push(line);
    } else if (trimmed === '' && importLines.length > 0) {
      // Keep blank lines between imports
      importLines.push(line);
    } else if (importLines.length > 0 && trimmed !== '') {
      // Stop at first non-import, non-blank line after imports found
      break;
    }
  }

  return importLines.join('\n').trim();
}

/**
 * Extract body from code (everything after imports)
 */
export function extractBody(code: string): string {
  const imports = extractImports(code);
  if (!imports) {
    return code.trim();
  }

  const bodyStart = code.indexOf(imports) + imports.length;
  return code.substring(bodyStart).trim();
}

/**
 * Generate a Python function signature based on node dependencies
 *
 * Examples:
 *   Single input:  "def task(input_data):  # do not edit this method header"
 *   Multiple inputs: "def task(raw_sales, inventory_config):  # do not edit this method header"
 *   No inputs: "def task():  # do not edit this method header"
 */
export function generateFunctionSignature(
  node: HPCNode,
  graph: HPCGraph
): string {
  // Skip if not a compute node
  if (node.type !== 'compute') {
    return '';
  }

  // Get upstream nodes
  const upstreamNodes = graph.nodes.filter((n) => node.in.includes(n.id));

  // Convert node names to parameter names
  const paramNames = upstreamNodes.map((n) => nodeNameToParamName(n.name));

  // Generate function signature
  const params = paramNames.join(', ');
  return `def task(${params}):  # do not edit this method header`;
}

/**
 * Get the return type suggestion based on downstream nodes
 *
 * If a node has 1 output: just return the value
 * If a node has 2+ outputs: return as tuple
 *
 * Examples:
 *   1 downstream: "return result"
 *   2+ downstream: "return result1, result2"
 */
export function getReturnSuggestion(
  node: HPCNode,
  graph: HPCGraph
): string {
  // Get downstream nodes
  const downstreamNodes = graph.nodes.filter((n) => node.out.includes(n.id));

  if (downstreamNodes.length === 0) {
    return 'return in_df  # or your processed data';
  }

  if (downstreamNodes.length === 1) {
    return `return result  # for ${downstreamNodes[0].name}`;
  }

  // Multiple outputs - suggest tuple unpacking
  const resultNames = downstreamNodes
    .map((n) => nodeNameToParamName(n.name))
    .join(', ');
  return `return ${resultNames}  # tuple unpacking for downstream nodes`;
}

/**
 * Rebuild complete function code from body and current node inputs
 *
 * This ensures the signature is always up-to-date with current graph connections
 */
export function rebuildFunctionCode(
  codeBody: string,
  node: HPCNode,
  graph: HPCGraph
): string {
  const signature = generateFunctionSignature(node, graph);

  if (!signature) {
    return codeBody;
  }

  // Indent the body with 4 spaces (standard Python indentation)
  const indentedBody = codeBody
    .split('\n')
    .map((line) => (line.trim() ? '    ' + line : line))
    .join('\n');

  return `${signature}\n${indentedBody}`;
}
