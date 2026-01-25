import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { generateFunctionSignature, nodeNameToParamName } from '@/app/utils/signature-generator';

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

    // Generate the function signature for the selected node (if compute)
    const expectedSignature = selectedNode && selectedNode.type === 'compute'
      ? generateFunctionSignature(selectedNode, graph)
      : null;

    // Extract the input parameter name from the signature
    const inputParamMatch = expectedSignature?.match(/def\s+task\s*\(\s*(\w+)\s*\)/);
    const inputParamName = inputParamMatch ? inputParamMatch[1] : 'input';

    // Get input file metadata for the selected node
    const inputFileMetadata = selectedNode
      ? graph?.nodes
          ?.filter((n: any) => selectedNode.in?.includes(n.id))
          ?.map((n: any) => n.fileMetadata)
          ?.filter(Boolean)
      : [];

    // Generate a mapping of all node names to their parameter names
    // This helps the AI know what parameter to use when creating new nodes
    const nodeParamMapping = graph?.nodes?.map((n: any) => ({
      name: n.name,
      paramName: nodeNameToParamName(n.name),
      type: n.type
    })) || [];

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

NODE PARAMETER REFERENCE (CRITICAL - use these exact parameter names in your code):
${nodeParamMapping.map((n: any) => `- "${n.name}" → parameter name: "${n.paramName}" (${n.type})`).join('\n')}

When writing code for a new compute node that connects FROM a parent node, the function signature will be:
  def task(parent_param_name):  # where parent_param_name is from the table above

Example: If creating a node that connects from "Post Processing", your code MUST use:
  def task(post_processing):
      out_df = post_processing.copy()  # Use the parameter name, NOT "in_df"!
      ...

${selectedNode ? `SELECTED NODE:
- ID: ${selectedNode.id}
- Name: ${selectedNode.name}
- Type: ${selectedNode.type}
- Current Code:
${selectedNode.code || "(empty)"}
${expectedSignature ? `
IMPORTANT - THE FUNCTION SIGNATURE IS:
${expectedSignature}

This means the function parameter is named: ${inputParamName}
YOU MUST use "${inputParamName}" in your code, NOT "in_df" or "input_data"
Example: out_df = ${inputParamName}.copy()` : ''}` : "No node selected."}

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

CODE GENERATION REQUIREMENTS:
1. **Robustness**: The generated code MUST be self-contained and error-resistant.
2. **Defined Variables**: NEVER reference variables that are not explicitly defined.
3. **MANDATORY**: You MUST STRICTLY use the variable name defined in the function signature.
   - If you write def task(replace_with_ones):, YOU MUST use out_df = replace_with_ones.copy().
   - referencing in_df when the argument is named replace_with_ones is a CRITICAL ERROR.
4. **Input Handling**: The first argument is ALWAYS your input dataframe. Use it as the source.
5. **Output Handling**: If modifying the data, explicitly define out_df = <input_arg_name>.copy() at the beginning.
6. **Return Value**: ALWAYS return the output dataframe at the end.

EXAMPLE - Good (Consistent Naming):
def task(my_data):
    import pandas as pd
    
    out_df = my_data.copy()
    
    if 'value' in out_df.columns:
        out_df['doubled'] = out_df['value'] * 2
        
    return out_df

EXAMPLE - Bad (Inconsistent Naming):
def task(input_data):
    # Error: 'in_df' is undefined!
    out_df = in_df.copy() 
    return out_df

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

4. **Connection Edits for Existing Nodes (IMPORTANT)**:
  - When user says "add connection from A to B", that means a directed edge A → B.
  - When user says "remove connection from A to B", remove ONLY the directed edge A → B.
  - DO NOT remove any other connections unless explicitly asked.
  - Compute nodes can have MULTIPLE inputs. Do not treat multiple inputs as an error.
  - Prefer using add/remove fields below rather than replacing all connections.

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

For EDIT_NODE intent (connection changes, renames, code changes on existing nodes):
{
  "intent": "edit_node",
  "nodeId": "<node id to edit>",
  "nodeName": "<node name if used instead of id>",
  "addInConnections": ["<node id or name>"] , // add incoming connections (A → target)
  "addOutConnections": ["<node id or name>"] , // add outgoing connections (target → B)
  "removeInConnections": ["<node id or name>"] , // remove incoming connections (A → target)
  "removeOutConnections": ["<node id or name>"] , // remove outgoing connections (target → B)
  "newInConnections": ["<node id or name>"] , // ONLY if user says "set/replace" inputs
  "newOutConnections": ["<node id or name>"] , // ONLY if user says "set/replace" outputs
  "newCode": "<python code>",
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

For EDIT_NODE intent (editing existing node connections or code):
{
  "intent": "edit_node",
  "nodeId": "<id of node to edit - MUST be from the graph above>",
  "nodeName": "<name of node to edit>",
  "newInConnections": ["node_id_1", "node_id_2"] (optional, for changing inputs - MUST be valid node IDs from graph),
  "newOutConnections": ["node_id_3"] (optional, for changing outputs - MUST be valid node IDs from graph),
  "newCode": "<python code>" (optional, for compute nodes),
  "parallelization": { ... } (optional, for compute nodes),
  "message": "<explanation of what changed>"
}

Examples of EDIT_NODE usage:
1. User: "Edit the Input Data node to also connect to the transform step"
   → nodeId: "550e8400-e29b-41d4-a716-446655440000" (the actual ID from the graph)
   → newOutConnections: ["550e8400-e29b-41d4-a716-446655440001"] (actual ID of transform node)

2. User: "Change the output node to receive from the filter step instead"
   → nodeId: "550e8400-e29b-41d4-a716-446655440002" (actual output node ID)
   → newInConnections: ["node-id-of-filter-node"] (actual filter node ID from graph)

3. User: "Update the compute node code to use vectorized operations"
   → nodeId: "550e8400-e29b-41d4-a716-446655440001"
   → newCode: "<updated python code>"

CRITICAL RULES FOR EDIT_NODE:
- **IMPORTANT - Node IDs MUST be valid**:
  - ALL nodeId, newInConnections, and newOutConnections values MUST be actual node IDs from the provided graph
  - Do NOT invent or make up node IDs
  - Do NOT use node names as IDs - convert them to actual IDs by looking up in the graph
  - If a node cannot be found, ask the user to clarify which node they mean
- **Connection validation**:
  - Input nodes (type: input-file) can only have OUT connections (they are sources)
  - Output nodes (type: output-file) can only have IN connections (they are sinks)
  - Compute nodes can have both IN and OUT connections
  - Never create invalid connections (output → input, input ← output)
- **When user says "connect to X" or "connects from Y"**:
  - Find the EXACT node match in the graph by name
  - Look up that node's ID in the graph
  - Set either newOutConnections or newInConnections accordingly
  - For compute nodes: ask if they want to REPLACE existing connections or ADD to them
- **Replacement vs Addition**:
  - If user says "connect to X instead", REPLACE: newOutConnections = [<actual ID of X>]
  - If user says "also connect to X", ADD: newOutConnections = [...existing IDs, <actual ID of X>]
  - If user says "remove connection to X", REPLACE: newOutConnections = [<all current IDs except X>]
  - When in doubt, ASK before applying changes

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
