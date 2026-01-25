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

    const { prompt, graph, selectedNodeId, lastCreatedNodeId, history, pendingIntent } = await request.json();

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

    const historyText = history
      ? `RECENT CHAT HISTORY:\n${history.map((h: any) => `${h.role.toUpperCase()}: ${h.content}`).join('\n')}\n`
      : '';

    const lastCreatedNode = lastCreatedNodeId
      ? graph?.nodes?.find((n: any) => n.id === lastCreatedNodeId)
      : null;

    const lastNodeContext = lastCreatedNode
      ? `LAST CREATED NODE:\nID: ${lastCreatedNode.id}\nName: "${lastCreatedNode.name}"\nType: ${lastCreatedNode.type}\nWhen user says "that one", "from it", "from that", "a new one from there", they likely mean this node.`
      : '';

    const pendingIntentContext = pendingIntent 
      ? `PENDING INTENT (User is clarifying this):
${JSON.stringify(pendingIntent, null, 2)}
IMPORTANT: The user is answering a question about the above intent. You must START with this intent and UPDATE it with the new info. Do not lose existing fields like 'nodeName', 'parentNodeId', or 'pythonCode' unless explicitly changed.`
      : '';

    const systemPrompt = `You are an AI assistant for an HPC (High-Performance Computing) workflow builder.

Users describe computational tasks in natural language, and you help them write PARALLELIZABLE code or create new pipeline nodes.

${pendingIntentContext}

${lastNodeContext}

${historyText}

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
The 'in_df' parameter will contain this data structure.
` : ''}

YOUR TASKS:
1. **Detect intent**: Determine if the user wants to:
   - Create a NEW node (e.g., "add a filtering step", "create a compute node that aggregates")
   - Update code on the selected node
   - Rename a node
   - Just ask a question

2. **For node creation requests**:
   - Extract the node type they want: input-file (uploading data), compute (processing), or output-file (results)
   - Extract the node name
   - Identify which parent node it should connect from (usually the most recent node before it)
   - If compute node: generate the Python code skeleton
   - If you can't determine something, ask for clarification

3. **For code updates**: Generate parallelizable code for the selected node

PARALLELIZATION PRINCIPLES:
1. **Chunk-based processing**: Process data in independent chunks that can run in parallel
2. **No global state**: Avoid shared variables between chunks
3. **Map-reduce patterns**: Use patterns like map, filter, reduce that parallelize naturally
4. **Vectorized operations**: Use numpy/pandas vectorized ops instead of loops when possible
5. **Independent operations**: Each chunk should be processable without data from other chunks

EXAMPLE - Good (parallelizable, CSV input):
def task(in_df, out_df):
    import numpy as np
    import pandas as pd
    df = in_df  # or in_df['data'] depending on structure
    df['doubled'] = df['value_column'] * 2
    out_df['result'] = df

EXAMPLE - Bad (not parallelizable):
def task(in_df, out_df):
    import numpy as np
    import pandas as pd
    total = 0
    for item in in_df['data']:
        total += item  # Sequential dependency
    out_df['result'] = total

RESPONSE FORMAT (always respond with valid JSON):

For CREATE_NODE intent:
{
  "intent": "create_node",
  "nodeType": "input-file" | "compute" | "output-file",
  "nodeName": "<descriptive name>",
  "parentNodeId": "<id of source node>",
  "parentNodeName": "<name of source node>",
  "childNodeId": "<id of destination node if connecting TO existing node>", 
  "childNodeName": "<name of destination node if connecting TO existing node>",
  "replaceExistingConnection": true | false, // if user explicitly chooses to replace an existing connection
  "pythonCode": "<python code>",
  "completeness": "complete" | "needs_clarification",
  "missingFields": ["nodeType", "parentNodeId"] (only if strictly required),
  "clarifyingQuestions": ["Question 1?", "Question 2?"] (if incomplete OR if you want to confirm destination),
  "explanation": "<description>",
  "message": "<friendly message>"
}

CRITICAL RULES FOR PRONOUN & CONTEXT RESOLUTION:
When user says "that one", "from that", "from it", "a new one from that", "another one from there":
- CHECK the LAST CREATED NODE context above - this is what they're referring to
- Set parentNodeName to the last created node's name
- Set parentNodeId to the last created node's id
- Example: User created "Pass-Through Data", then says "new one from that please"
  → parentNodeName should be "Pass-Through Data"
  → parentNodeId should be the ID of "Pass-Through Data"

CRITICAL RULES FOR CLARIFICATION:
When clarifying a pendingIntent (user is answering a question):
- PRESERVE all existing fields: nodeName, parentNodeId, parentNodeName, nodeType, pythonCode
- UPDATE ONLY the fields the user is clarifying
- If user clarifies "no destination", set completeness: "complete" and leave childNodeId/childNodeName empty
- ALWAYS include the user's answer in your message to confirm understanding
- DO NOT re-ask questions that have been answered - move to node creation

CRITICAL RULES FOR NODE CREATION:
1. **Source Node**:
   - Check the parentNodeName carefully. If the user specifies a name (e.g. "from Process Data"), FIND THE EXACT NODE MATCH. Do not fuzzy match to "Pass-Through Data (from Process Data)" if "Process Data" exists.
   - If unconnected nodes exist and user says "add to isolated/unconnected node", prioritize those.
   - When user references "that one", "from it", etc., use the LAST CREATED NODE context above.

1b. **Node Naming**:
   - If user provides a description (e.g., "a new one that filters rows"), use it to name the node
   - If user just says "a new one from that" with no description:
     - Generate a contextual name based on parent node and position
     - Example: If parent is "Process Data", name could be "Transform Data", "Filter Data", "Process Results", etc.
     - AVOID generic names like "New Compute Node" unless truly no context

2. **Destination Node**:
   - RECOGNIZE these phrases as "no destination": "no destination", "no destination for now", "just pass", "endpoint", "leave unconnected", "terminal", "leaf", "dead end", "don't connect", "no output connection", "not yet", "later"
   - When user says "no destination":
     - LEAVE childNodeId and childNodeName EMPTY/NULL (undefined, not set).
     - DO NOT create a new 'output-file' node automatically.
     - Mark completeness as "complete". CRITICAL: DO NOT RE-ASK after this.
   - If user DOES NOT specify a destination, and it's a compute node:
     - If there are output nodes in graph AND this is a NEW node request (no pending intent being clarified), ASK which node to connect to.
     - If user is CLARIFYING an existing intent (pendingIntent exists), assume terminal node and mark complete.
     - Set completeness to "needs_clarification" only if truly ambiguous.
     
3. **Connection Conflict / Path Replacement**: 
   - Check the graph! If parentNode -> childNode ALREADY have a direct connection (check the 'out' array of the parent in the provided JSON):
   - You MUST ASK: "I see a connection already exists. Do you want to REPLACE it (insert between) or add a PARALLEL path?"
   - Set completeness to "needs_clarification" and add "replaceExistingConnection" to missingFields.
   - ONLY if the user explicitly answers "replace" or "parallel", then set replaceExistingConnection.
   - If you are unsure, set completeness to "needs_clarification".

For UPDATE_CODE intent:
{
  "intent": "update_code",
  "nodeId": "<node id to update>",
  "code": "<python code>",
  "parallelization": {
    "strategy": "map" | "reduce" | "map-reduce" | "vectorized" | "sequential",
    "estimatedCores": <number>,
    "chunkSize": <optional number>
  },
  "message": "<explanation>"
}

For UPDATE_NAME intent:
{
  "intent": "update_name",
  "nodeId": "<node id>",
  "name": "<new name>",
  "message": "<explanation>"
}

For CHAT intent:
{
  "intent": "chat",
  "message": "<your response>"
}

IMPORTANT:
- Always detect intent first from user message
- For node creation: extract all fields you can. If unsure about parentNodeId, nodeType, or name, ask for clarification
- If user says "add a node that does X", you should detect this as create_node intent
- If completeness is "needs_clarification", list the missing fields and ask specific questions
- Only generate Python code if you're confident in the input/output data structure
- Always explain HOW the code will be parallelized
- Use libraries: pandas, numpy, dask, scipy, scikit-learn
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
        intent: "chat",
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
