import { NextRequest, NextResponse } from "next/server";
import { toParamName, buildFunctionSignature, validatePythonCode, fixGeneratedCodeAdvanced } from "@/app/utils/code-validator";
import { translateLineNumber } from "@/app/utils/code-wrapper";
import { getModel } from "@/app/lib/ai-client";

/**
 * Normalize whitespace in Python code:
 * - Convert all tabs to 4 spaces
 * - Remove trailing whitespace
 * - Ensure consistent line endings
 * - Fix mixed indentation
 */
function normalizeWhitespace(code: string): string {
  return code
    .split('\n')
    .map(line => {
      // Replace all tabs with 4 spaces
      let normalized = line.replace(/\t/g, '    ');
      // Remove trailing whitespace
      normalized = normalized.trimEnd();
      return normalized;
    })
    .join('\n');
}

/**
 * Sanitize error messages and translate line numbers from wrapped script to user code
 */
function sanitizeAndTranslateError(errorMessage: string): { 
  cleanMessage: string; 
  userLineNumber: number | null;
  errorType: string | null;
} {
  let cleanMessage = errorMessage;
  let userLineNumber: number | null = null;
  let errorType: string | null = null;

  // Extract line number and error type
  const lineMatch = errorMessage.match(/[Ll]ine\s+(\d+)/);
  const errorTypeMatch = errorMessage.match(/(IndentationError|SyntaxError|TabError|NameError|TypeError|ValueError|KeyError|AttributeError)/i);
  
  if (lineMatch) {
    const wrappedLineNum = parseInt(lineMatch[1], 10);
    userLineNumber = translateLineNumber(wrappedLineNum);
    
    // Replace the wrapped line number with user code line number in the message
    if (userLineNumber !== null) {
      cleanMessage = cleanMessage.replace(/[Ll]ine\s+\d+/, `Line ${userLineNumber}`);
    }
  }
  
  if (errorTypeMatch) {
    errorType = errorTypeMatch[1];
  }

  // Remove S3/AWS paths
  cleanMessage = cleanMessage.replace(/s3:\/\/[^\s"']+/gi, '<file>');
  cleanMessage = cleanMessage.replace(/\/tmp\/[a-f0-9-]+\/[^\s"']+/gi, '<file>');
  cleanMessage = cleanMessage.replace(/\/var\/task\/[^\s"']+/gi, '<file>');
  cleanMessage = cleanMessage.replace(/File "\/var\/[^"]+"/g, 'File "<script>"');
  cleanMessage = cleanMessage.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<id>');

  return { cleanMessage, userLineNumber, errorType };
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "API key not configured" }, { status: 500 });
    }

    const { graph, failedNodeId, errorMessage } = await request.json();

    if (!graph || !failedNodeId || !errorMessage) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
    }

    // Use singleton AI client for better resource management
    const model = getModel("gemini-2.5-flash");

    const failedNode = graph.nodes.find((n: any) => n.id === failedNodeId);
    if (!failedNode) {
      return NextResponse.json({ error: "Failed node not found" }, { status: 404 });
    }

    // Sanitize and translate the error message
    const { cleanMessage, userLineNumber, errorType } = sanitizeAndTranslateError(errorMessage);

    // Build context from the graph
    const upstreamNodes = graph.nodes.filter((n: any) => failedNode.in?.includes(n.id));
    const parentNodeNames = upstreamNodes.map((n: any) => n.name);
    const expectedParams = parentNodeNames.map((name: string) => toParamName(name));
    const correctSignature = buildFunctionSignature(parentNodeNames);
    
    // Get user's code - normalize it first to see what we're working with
    const rawUserCode = failedNode.code || '';
    const userCode = normalizeWhitespace(rawUserCode);
    
    // Log for debugging
    console.log('[Autopilot] Original code length:', rawUserCode.length);
    console.log('[Autopilot] Normalized code length:', userCode.length);
    console.log('[Autopilot] Code differs after normalization:', rawUserCode !== userCode);
    
    const codeLines = userCode.split('\n');
    
    // Build context around the problematic line
    let problemLineContext = '';
    if (userLineNumber !== null && userLineNumber > 0 && userLineNumber <= codeLines.length) {
      const startLine = Math.max(0, userLineNumber - 3);
      const endLine = Math.min(codeLines.length, userLineNumber + 2);
      const contextLines = codeLines.slice(startLine, endLine).map((line: string, idx: number) => {
        const actualLineNum = startLine + idx + 1;
        const marker = actualLineNum === userLineNumber ? ' >>> ' : '     ';
        return `${marker}${actualLineNum}: ${line}`;
      });
      problemLineContext = `\n**ERROR IS ON LINE ${userLineNumber}:**\n\`\`\`\n${contextLines.join('\n')}\n\`\`\`\n`;
    }

    // Build simple upstream context
    const upstreamContext = upstreamNodes.map((n: any) => {
      const paramName = toParamName(n.name);
      const meta = n.files?.[0]?.metadata || n.fileMetadata;
      if (meta?.columns) {
        return `- "${n.name}" → param: \`${paramName}\` (columns: ${meta.columns.slice(0, 5).join(', ')}${meta.columns.length > 5 ? '...' : ''})`;
      }
      return `- "${n.name}" → param: \`${paramName}\``;
    }).join('\n');

    // Determine error type and build appropriate prompt
    const isIndentationError = errorType === 'IndentationError' || errorType === 'TabError';
    const isSyntaxError = errorType === 'SyntaxError' || isIndentationError;

    let prompt: string;
    
    if (isIndentationError) {
      prompt = `Fix the INDENTATION ERROR in this Python code.

**ERROR:** ${cleanMessage}
${problemLineContext}

**CODE:**
\`\`\`python
${userCode}
\`\`\`

**RULES:**
1. ONLY fix indentation - do NOT change logic or variable names
2. Use exactly 4 spaces per indent level (NO tabs)
3. Keep signature: ${correctSignature}

Return ONLY the fixed code. No explanations.`;

    } else if (isSyntaxError) {
      prompt = `Fix the SYNTAX ERROR in this Python code.

**ERROR:** ${cleanMessage}
${problemLineContext}

**CODE:**
\`\`\`python
${userCode}
\`\`\`

**RULES:**
1. ONLY fix the syntax error - do NOT rewrite logic
2. Keep signature: ${correctSignature}
3. Use 4 spaces for indentation

Return ONLY the fixed code. No explanations.`;

    } else if (errorType === 'KeyError') {
      // KeyError usually means trying to access a column that doesn't exist
      // Common in merge operations where the AI assumed wrong column names
      prompt = `Fix this KeyError. The code is trying to access a column that doesn't exist.

**ERROR:** ${cleanMessage}
${problemLineContext}

**SIGNATURE:** ${correctSignature}
**PARAMETERS:** ${upstreamContext || '(none)'}

**CODE:**
\`\`\`python
${userCode}
\`\`\`

**THE PROBLEM:** The code assumes specific column names that don't exist in the input dataframes.
This often happens in merge/combiner nodes where upstream nodes computed new columns with different names than expected.

**FIX STRATEGY - Use this safe merge pattern that doesn't assume column names:**
\`\`\`python
def task(df1, df2):  # or however many inputs
    # Find common columns to use as merge keys (ID columns, timestamps, etc.)
    common_cols = list(set(df1.columns) & set(df2.columns))
    key_patterns = ['id', 'time', 'date', 'batch', 'sample', 'experiment', 'index']
    merge_keys = [c for c in common_cols if any(p in c.lower() for p in key_patterns)]

    if not merge_keys:
        # Fallback: use index
        return df1.join(df2.drop(columns=common_cols, errors='ignore'), how='outer')

    # Merge brings in ALL columns from both dataframes
    result = df1.merge(df2, on=merge_keys, how='outer', suffixes=('', '_dup'))

    # Remove duplicate columns
    dup_cols = [c for c in result.columns if c.endswith('_dup')]
    result = result.drop(columns=dup_cols, errors='ignore')

    return result
\`\`\`

**RULES:**
1. DO NOT assume what columns the upstream nodes created
2. DO NOT hardcode column names like 'temperature_moving_average' or 'ph_ma_30min'
3. Use the safe merge pattern above that works regardless of column names
4. Keep signature: ${correctSignature}

Return ONLY the fixed code. No explanations.`;

    } else {
      prompt = `Fix this Python error. Make MINIMAL changes only.

**ERROR:** ${cleanMessage}
${problemLineContext}

**SIGNATURE:** ${correctSignature}
**PARAMETERS:** ${upstreamContext || '(none)'}

**CODE:**
\`\`\`python
${userCode}
\`\`\`

**RULES:**
1. Make the SMALLEST fix possible
2. Do NOT rewrite the function
3. Keep signature: ${correctSignature}
4. Use only these params: ${expectedParams.join(', ') || '(none)'}

Return ONLY the fixed code. No explanations.`;
    }

    console.log('[Autopilot] Sending prompt for', errorType || 'runtime error');
    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    
    // Extract code from response
    let fixedCode = responseText
      .replace(/```python\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();
    
    // CRITICAL: Normalize whitespace to fix invisible indentation issues
    // Convert tabs to 4 spaces and ensure consistent indentation
    fixedCode = normalizeWhitespace(fixedCode);
    
    // Find the def task line and keep only from there
    const defTaskMatch = fixedCode.match(/def\s+task\s*\([^)]*\)\s*:/);
    if (defTaskMatch) {
      const defTaskIndex = fixedCode.indexOf(defTaskMatch[0]);
      if (defTaskIndex > 0) {
        fixedCode = fixedCode.substring(defTaskIndex);
      }
    }

    // Apply post-processing fixes
    fixedCode = fixGeneratedCodeAdvanced(fixedCode, {
      expectedParams,
      parentNodeNames,
      nodeName: failedNode.name
    });

    // Validate the result
    const validation = validatePythonCode(fixedCode, {
      expectedParams,
      parentNodeNames,
      nodeName: failedNode.name
    });

    if (validation.fixedCode) {
      fixedCode = validation.fixedCode;
    }

    // Force correct signature
    const sigMatch = fixedCode.match(/def\s+\w+\s*\([^)]*\)\s*:/);
    if (sigMatch && sigMatch[0] !== correctSignature) {
      console.log('[Autopilot] Forcing correct signature');
      fixedCode = fixedCode.replace(/def\s+\w+\s*\([^)]*\)\s*:/, correctSignature);
    }

    // Replace common wrong variable names
    if (expectedParams.length > 0) {
      const wrongVars = ['in_df', 'input_df', 'input_data'];
      for (const wrongVar of wrongVars) {
        const regex = new RegExp(`\\b${wrongVar}\\b`, 'g');
        if (regex.test(fixedCode) && !fixedCode.includes(`${wrongVar} =`)) {
          fixedCode = fixedCode.replace(regex, expectedParams[0]);
        }
      }
    }

    // Final validation
    const finalValidation = validatePythonCode(fixedCode, {
      expectedParams,
      parentNodeNames,
      nodeName: failedNode.name
    });

    return NextResponse.json({
      success: true,
      nodeId: failedNodeId,
      nodeName: failedNode.name,
      analysis: `Fixed ${errorType || 'error'}${userLineNumber ? ` on line ${userLineNumber}` : ''}`,
      fixDescription: `Applied minimal fix for: ${cleanMessage}`,
      fixedCode: finalValidation.fixedCode || fixedCode,
      originalCode: failedNode.code,
      expectedSignature: correctSignature,
      validationWarnings: finalValidation.warnings,
      validationErrors: finalValidation.errors
    });

  } catch (error) {
    console.error("Error fixing pipeline:", error);
    return NextResponse.json(
      {
        error: "Failed to analyze and fix error",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
