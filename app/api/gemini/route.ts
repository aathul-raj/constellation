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

    const { prompt, graph, selectedNodeId } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { error: "Missing prompt" },
        { status: 400 }
      );
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

    const selectedNode = selectedNodeId
      ? graph?.nodes?.find((n: { id: string }) => n.id === selectedNodeId)
      : null;

    const systemPrompt = `You are an AI assistant for an HPC (High-Performance Computing) workflow builder.

Users describe computational tasks in natural language, and you help them by generating Python code for compute nodes.

CURRENT PIPELINE STATE:
${graph ? JSON.stringify(graph, null, 2) : "No graph provided"}

${selectedNode ? `SELECTED NODE:
- ID: ${selectedNode.id}
- Name: ${selectedNode.name}
- Type: ${selectedNode.type}
- Current Code:
${selectedNode.code || "(empty)"}` : "No node selected."}

YOUR TASK:
When the user asks you to write code for a task (like "sort data", "filter rows", "train a model", etc.):
1. Generate Python code using this exact function signature: def task(input, output):
2. The 'input' parameter contains the data from upstream nodes
3. The 'output' parameter is where you write results for downstream nodes
4. Return your response as JSON

RESPONSE FORMAT (always respond with valid JSON):
{
  "action": "update_code" | "update_name" | "chat",
  "nodeId": "<node id to update, use selected node if applicable>",
  "code": "<python code if action is update_code>",
  "name": "<new name if action is update_name>",
  "message": "<brief explanation to show the user>"
}

For general questions without code changes, use action: "chat" with just a message.

IMPORTANT:
- Only generate code for "compute" type nodes
- If no compute node is selected and user asks for code, tell them to select a compute node first
- Keep code practical and focused on the task
- Use common Python libraries (pandas, numpy, sklearn, etc.) as needed`;

    const fullPrompt = `${systemPrompt}\n\nUser request: ${prompt}`;

    console.log("Sending to Gemini...");
    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();
    console.log("Raw response:", text);

    // Try to parse as JSON
    let parsed;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const jsonStr = jsonMatch[1]?.trim() || text.trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      // If not valid JSON, treat as chat response
      parsed = {
        action: "chat",
        message: text
      };
    }

    return NextResponse.json(parsed);

  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      {
        error: "Failed to process request",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
