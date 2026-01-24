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

    // Get input file metadata for the selected node
    const inputFileMetadata = selectedNode
      ? graph?.nodes
          ?.filter((n: any) => selectedNode.in?.includes(n.id))
          ?.map((n: any) => n.fileMetadata)
          ?.filter(Boolean)
      : [];

    const systemPrompt = `You are an AI assistant for an HPC (High-Performance Computing) workflow builder.

Users describe computational tasks in natural language, and you help them write PARALLELIZABLE code that will run on distributed compute clusters.

CURRENT PIPELINE STATE:
${graph ? JSON.stringify(graph, null, 2) : "No graph provided"}

${selectedNode ? `SELECTED NODE:
- ID: ${selectedNode.id}
- Name: ${selectedNode.name}
- Type: ${selectedNode.type}
- Current Code:
${selectedNode.code || "(empty)"}` : "No node selected."}

${inputFileMetadata.length > 0 ? `
INPUT DATA CONTEXT:
The selected node receives data from upstream nodes with the following structure:

${inputFileMetadata.map((meta: any, idx: number) => `
Input ${idx + 1}: ${meta.fileName} (${meta.fileType})
${meta.columns ? `Columns: ${meta.columns.join(', ')}
Column Types: ${JSON.stringify(meta.columnTypes, null, 2)}
Row Count: ${meta.rowCount}
Sample Data:
${JSON.stringify(meta.sampleRows, null, 2)}` :
meta.schema ? `Schema: ${JSON.stringify(meta.schema, null, 2)}` :
`Preview: ${meta.preview}`}
`).join('\n')}

IMPORTANT: Generate code that works with the ACTUAL columns and data shown above.
The 'input' parameter will contain this data structure.
` : ''}

YOUR TASK:
Generate code that can be efficiently parallelized across multiple cores/nodes. The system will automatically distribute the workload.

FUNCTION SIGNATURE:
def task(input, output):
    """
    input: Data from upstream nodes (dict, list, or dataframe)
    output: Where to write results for downstream nodes
    """
    # Your parallelizable code here

PARALLELIZATION PRINCIPLES:
1. **Chunk-based processing**: Process data in independent chunks that can run in parallel
2. **No global state**: Avoid shared variables between chunks
3. **Map-reduce patterns**: Use patterns like map, filter, reduce that parallelize naturally
4. **Vectorized operations**: Use numpy/pandas vectorized ops instead of loops when possible
5. **Independent operations**: Each chunk should be processable without data from other chunks

EXAMPLE - Good (parallelizable, CSV input):
def task(input, output):
    import pandas as pd
    # Assuming input CSV has been loaded as DataFrame
    df = input  # or input['data'] depending on structure
    # Vectorized operations parallelize automatically
    df['doubled'] = df['value_column'] * 2
    output['result'] = df

EXAMPLE - Bad (not parallelizable):
def task(input, output):
    # Global accumulator breaks parallelism
    total = 0
    for item in input['data']:
        total += item  # Sequential dependency
    output['result'] = total

HOW TO ACCESS INPUT DATA:
- For CSV: input will be a pandas DataFrame with the columns shown above
- For JSON: input will be a dict/list matching the schema shown above
- Use the EXACT column names from the input data context

RESPONSE FORMAT (always respond with valid JSON):
{
  "action": "update_code" | "update_name" | "chat",
  "nodeId": "<node id to update, use selected node if applicable>",
  "code": "<python code if action is update_code>",
  "name": "<new name if action is update_name>",
  "parallelization": {
    "strategy": "map" | "reduce" | "map-reduce" | "vectorized" | "sequential",
    "estimatedCores": <number, suggest cores based on task complexity>,
    "chunkSize": <optional, for chunked processing>
  },
  "message": "<brief explanation mentioning parallelization strategy>"
}

IMPORTANT:
- Only generate code for "compute" type nodes
- If no compute node is selected and user asks for code, tell them to select a compute node first
- Always explain HOW the code will be parallelized in your message
- Use libraries: pandas, numpy, dask, scipy, scikit-learn (these handle parallelization internally)
- Avoid: sequential loops, global state, file I/O in the middle of processing`;

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
