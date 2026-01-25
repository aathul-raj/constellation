import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { toParamName, buildFunctionSignature, validatePythonCode } from "@/app/utils/code-validator";

export async function POST(request: NextRequest) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "API key not configured" },
        { status: 500 }
      );
    }

    const { graph, failedNodeId, errorMessage, consoleLogs, userGoal } = await request.json();

    if (!graph || !failedNodeId || !errorMessage) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      );
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const failedNode = graph.nodes.find((n: any) => n.id === failedNodeId);
    if (!failedNode) {
      return NextResponse.json(
        { error: "Failed node not found" },
        { status: 404 }
      );
    }

    // CRITICAL: Build LOCAL context from the graph, not from AWS/S3 paths
    // Get upstream nodes to understand data flow - use LOCAL node names
    const upstreamNodes = graph.nodes.filter((n: any) => failedNode.in?.includes(n.id));
    
    // Build the CORRECT function signature based on LOCAL parent node names
    const parentNodeNames = upstreamNodes.map((n: any) => n.name);
    const expectedParams = parentNodeNames.map((name: string) => toParamName(name));
    const correctSignature = buildFunctionSignature(parentNodeNames);
    
    // Build upstream context with LOCAL names only (no S3 paths)
    const upstreamContext = upstreamNodes.map((n: any) => {
      const paramName = toParamName(n.name);
      if (n.type === 'input-file') {
        const meta = n.files?.[0]?.metadata || n.fileMetadata;
        if (meta) {
          return `Input "${n.name}" (param: ${paramName}): columns=[${meta.columns?.join(', ') || 'unknown'}], ${meta.rowCount || '?'} rows`;
        }
        return `Input "${n.name}" (param: ${paramName}): file uploaded`;
      } else if (n.type === 'compute') {
        // Show the LOCAL code, not S3 references
        const codePreview = n.code?.split('\n').slice(0, 8).join('\n').substring(0, 300);
        return `Compute "${n.name}" (param: ${paramName}):\n${codePreview}`;
      }
      return `${n.type} "${n.name}" (param: ${paramName})`;
    }).join('\n\n');

    // Get downstream nodes for return context
    const downstreamNodes = graph.nodes.filter((n: any) => failedNode.out?.includes(n.id));
    const downstreamContext = downstreamNodes.length > 0
      ? `Downstream nodes expecting output: ${downstreamNodes.map((n: any) => n.name).join(', ')}`
      : 'This is a terminal node (no downstream connections)';

    // Format console logs - filter for LOCAL context only
    const relevantLogs = (consoleLogs || [])
      .filter((log: any) => log.nodeId === failedNodeId || log.type === 'error')
      .slice(-10)
      .map((log: any) => `[${log.type}] ${log.message}`)
      .join('\n');

    // Validate current code to identify specific issues
    const currentCodeValidation = validatePythonCode(failedNode.code || '', {
      nodeName: failedNode.name,
      parentNodeNames,
      expectedParams
    });

    const validationContext = currentCodeValidation.errors.length > 0 || currentCodeValidation.warnings.length > 0
      ? `\nCODE VALIDATION ISSUES DETECTED:
${currentCodeValidation.errors.map(e => `- ERROR: ${e}`).join('\n')}
${currentCodeValidation.warnings.map(w => `- WARNING: ${w}`).join('\n')}`
      : '';

    const prompt = `You are a Python debugging expert fixing a LOCAL data pipeline node. 

CRITICAL CONTEXT - USE ONLY LOCAL NAMES:
- Do NOT use S3 paths, bucket names, or AWS references
- The function receives pandas DataFrames from upstream nodes
- Parameter names are derived from LOCAL parent node names (snake_case)

PIPELINE: ${graph.name}
${graph.description ? `Description: ${graph.description}` : ''}
${userGoal ? `User's Goal: ${userGoal}` : ''}

FAILED NODE: "${failedNode.name}" (type: ${failedNode.type})

**REQUIRED FUNCTION SIGNATURE (MUST USE EXACTLY):**
${correctSignature}

UPSTREAM DATA SOURCES (LOCAL):
${upstreamContext || 'No upstream nodes - this node generates data'}

${downstreamContext}

CURRENT CODE:
\`\`\`python
${failedNode.code}
\`\`\`

ERROR MESSAGE:
${errorMessage}
${validationContext}

CONSOLE LOGS:
${relevantLogs || 'No logs available'}

STRICT REQUIREMENTS:
1. Function MUST be named "task"
2. Function signature MUST be EXACTLY: ${correctSignature}
3. Parameter names are: ${expectedParams.length > 0 ? expectedParams.join(', ') : '(none)'}
4. Use ONLY these parameter names in your code - do NOT use 'in_df', 'input_df', or 'input_data'
5. Function MUST return a pandas DataFrame
6. Initialize output with: out_df = ${expectedParams[0] || 'pd.DataFrame()'}.copy()
7. Handle edge cases: empty DataFrames, missing columns, type mismatches
8. Keep fix minimal - only change what's necessary

EXAMPLE for a node with parent "Sales Data":
\`\`\`python
def task(sales_data):
    import pandas as pd
    import numpy as np
    
    out_df = sales_data.copy()
    
    # Your transformation here
    
    return out_df
\`\`\`

Respond with ONLY a JSON object (no markdown):
{
  "analysis": "Brief explanation of what went wrong",
  "fix_description": "What you changed to fix it",
  "fixed_code": "The complete fixed Python function - MUST use signature: ${correctSignature}"
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse the JSON response
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error("Failed to parse AI response:", responseText);
      return NextResponse.json(
        { error: "Failed to parse AI fix response", details: responseText },
        { status: 500 }
      );
    }

    if (!parsed.fixed_code || !parsed.analysis) {
      return NextResponse.json(
        { error: "AI response missing required fields", details: parsed },
        { status: 500 }
      );
    }

    // CRITICAL: Validate and fix the AI's generated code before returning
    const fixedCodeValidation = validatePythonCode(parsed.fixed_code, {
      nodeName: failedNode.name,
      parentNodeNames,
      expectedParams
    });

    let finalCode = parsed.fixed_code;
    
    // Apply auto-fixes if the AI still made mistakes
    if (fixedCodeValidation.fixedCode) {
      console.log('[Autopilot] Applied auto-fixes to AI response:', fixedCodeValidation.warnings);
      finalCode = fixedCodeValidation.fixedCode;
    }

    // Final validation
    if (!fixedCodeValidation.valid && fixedCodeValidation.errors.length > 0) {
      console.warn('[Autopilot] Code still has issues after fix:', fixedCodeValidation.errors);
      // Try one more time with stricter prompt
      const retryPrompt = `The previous fix still has errors: ${fixedCodeValidation.errors.join(', ')}

Fix these SPECIFIC issues. The function MUST:
1. Be named "task"
2. Have signature: ${correctSignature}
3. Use parameter names: ${expectedParams.join(', ')}
4. Return a DataFrame

Current broken code:
${parsed.fixed_code}

Return ONLY the fixed Python code (no JSON, no explanation):`;

      try {
        const retryResult = await model.generateContent(retryPrompt);
        const retryCode = retryResult.response.text()
          .replace(/```python\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        
        const retryValidation = validatePythonCode(retryCode, {
          nodeName: failedNode.name,
          parentNodeNames,
          expectedParams
        });
        
        if (retryValidation.valid || (retryValidation.errors.length < fixedCodeValidation.errors.length)) {
          finalCode = retryValidation.fixedCode || retryCode;
        }
      } catch (retryError) {
        console.warn('[Autopilot] Retry failed:', retryError);
      }
    }

    return NextResponse.json({
      nodeId: failedNodeId,
      nodeName: failedNode.name,
      analysis: parsed.analysis,
      fixDescription: parsed.fix_description || parsed.analysis,
      fixedCode: finalCode,
      originalCode: failedNode.code,
      expectedSignature: correctSignature,
      validationWarnings: fixedCodeValidation.warnings
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
