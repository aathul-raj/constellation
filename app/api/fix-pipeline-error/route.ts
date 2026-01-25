import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";

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

    // Get upstream nodes to understand data flow
    const upstreamNodes = graph.nodes.filter((n: any) => failedNode.in.includes(n.id));
    const upstreamContext = upstreamNodes.map((n: any) => {
      if (n.type === 'input-file' && n.files?.[0]?.metadata) {
        const meta = n.files[0].metadata;
        return `Input "${n.name}": columns=[${meta.columns?.join(', ') || 'unknown'}], ${meta.rowCount || '?'} rows`;
      } else if (n.type === 'compute') {
        return `Compute "${n.name}": ${n.code?.split('\n').slice(0, 5).join(' ').substring(0, 200)}...`;
      }
      return `${n.type} "${n.name}"`;
    }).join('\n');

    // Format console logs for context
    const relevantLogs = (consoleLogs || [])
      .filter((log: any) => log.nodeId === failedNodeId || log.type === 'error')
      .slice(-10)
      .map((log: any) => `[${log.type}] ${log.message}`)
      .join('\n');

    const prompt = `You are a Python debugging expert. A data pipeline node has failed. Analyze the error and fix the code.

PIPELINE CONTEXT:
Name: ${graph.name}
Description: ${graph.description}
${userGoal ? `User's Goal: ${userGoal}` : ''}

FAILED NODE: "${failedNode.name}" (ID: ${failedNode.id})

UPSTREAM DATA SOURCES:
${upstreamContext || 'No upstream nodes'}

CURRENT CODE:
\`\`\`python
${failedNode.code}
\`\`\`

ERROR MESSAGE:
${errorMessage}

CONSOLE LOGS:
${relevantLogs || 'No logs available'}

IMPORTANT RULES:
1. The function MUST be named "task" and follow this signature pattern: def task(in_df_NODEID, in_df_NODEID2, ...):
2. Input DataFrames are named based on upstream node IDs
3. The function must return a DataFrame
4. Use pandas and numpy (already imported)
5. Handle edge cases like missing columns, empty DataFrames, type mismatches
6. Keep the fix minimal - only change what's necessary to fix the error

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{
  "analysis": "Brief explanation of what went wrong (1-2 sentences)",
  "fix_description": "What you're changing to fix it (1-2 sentences)",
  "fixed_code": "The complete fixed Python function code"
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse the JSON response
    let parsed;
    try {
      // Try to extract JSON from the response (handle potential markdown wrapping)
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

    // Validate the response has required fields
    if (!parsed.fixed_code || !parsed.analysis) {
      return NextResponse.json(
        { error: "AI response missing required fields", details: parsed },
        { status: 500 }
      );
    }

    return NextResponse.json({
      nodeId: failedNodeId,
      nodeName: failedNode.name,
      analysis: parsed.analysis,
      fixDescription: parsed.fix_description || parsed.analysis,
      fixedCode: parsed.fixed_code,
      originalCode: failedNode.code
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
