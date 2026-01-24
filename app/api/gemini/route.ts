import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function POST(request: NextRequest) {
  try {
    const { prompt, graph } = await request.json();

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = `You are an AI assistant helping research scientists build computational workflows.
You work with a graph-based system where:
- "input" nodes reference data files
- "compute" nodes contain Python code to process data
- "output" nodes store results

The current graph state is:
${JSON.stringify(graph, null, 2)}

When the user asks to add or modify nodes, respond with a JSON object containing:
1. "action": "add_node" | "modify_node" | "delete_node" | "connect_nodes" | "explain"
2. "node": the node object (for add/modify)
3. "nodeId": the node ID (for modify/delete)
4. "message": a brief explanation for the user

For compute nodes, generate Python code in this format:
def task(input_data, output_data):
    # your code here
    pass

Keep responses concise and focused on the task.`;

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: prompt },
    ]);

    const response = result.response;
    const text = response.text();

    return NextResponse.json({ response: text });
  } catch (error) {
    console.error("Gemini API error:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
