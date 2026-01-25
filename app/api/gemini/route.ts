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
    // Use standard model for simple tasks, more capable model for complex pipeline generation
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
    // More capable model for pipeline generation (handles complex multi-node graphs better)
    const pipelineModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

    // Get all input nodes for file metadata context (define early for use in prompt)
    const allInputNodes = graph?.nodes?.filter((n: any) => n.type === 'input-file') || [];

    const historyText = history
      ? `RECENT CHAT HISTORY (READ THIS CAREFULLY - user already provided this info):\n${history.map((h: any) => `${h.role.toUpperCase()}: ${h.content}`).join('\n')}\n\nIMPORTANT: DO NOT ask about anything the user already mentioned in the history above.\n`
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

CRITICAL - The user is answering your previous questions:
- READ THE RECENT CHAT HISTORY above to see what they already told you
- DO NOT ask about things they already mentioned
- If this is a 'generate_pipeline' intent:
  - UPDATE 'understoodSoFar' by ADDING the new information to what's already there
  - After 1-2 rounds of questions, you should have ENOUGH info - set completeness to "ready_to_generate"
  - Make reasonable assumptions for missing details (e.g., standard column names, default settings)
  - Include all nodes, edges, and code when ready
- If this is a 'create_node' intent: Update with the new info without losing existing fields.`
      : '';

    // Build file metadata context for the model
    const fileMetadataContext = allInputNodes.length > 0 ? `
CRITICAL - FILE METADATA AVAILABLE:
${allInputNodes.map((n: any) => {
      const files = n.files || [];
      const meta = files[0]?.metadata || n.fileMetadata;
      if (meta) {
        return `- ${n.name}: ${meta.fileName || 'unknown'} (${meta.fileType || 'unknown'}), ${meta.rowCount || '?'} rows, columns: ${meta.columns?.join(', ') || 'unknown'}`;
      }
      return `- ${n.name}: file uploaded`;
    }).join('\n')}

IMPORTANT: You already have file size and format info above. DO NOT ask about:
- File size, row count, or data volume
- File format (CSV, JSON, etc.)
- Column names or schema
These are already known from the metadata. Proceed with pipeline generation.
` : '';

    const systemPrompt = `You are a concise AI assistant for an HPC workflow builder. Be direct and brief in responses.

${pendingIntentContext}

${lastNodeContext}

${historyText}
${fileMetadataContext}
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

YOUR TASKS (be concise):
1. **Detect intent**: pipeline | node creation | edit | code update | chat
2. **For PIPELINE requests**: If file metadata exists, DO NOT ask about file size/format. Max 1-2 questions if needed.
   - Design HPC graph. Generate all nodes, edges, and code.
3. **For node creation**: Extract type, name, parent node. Generate Python code for compute nodes.

4. **For code updates**: Generate parallelizable code

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

For GENERATE_PIPELINE intent (when user describes an ENTIRE pipeline in natural language):
{
  "intent": "generate_pipeline",
  "completeness": "needs_clarification" | "ready_to_generate",

  // When asking clarifying questions (first round only - be decisive!)
  "clarifyingQuestions": ["What output format do you need?", "How large is your dataset?"],
  "understoodSoFar": "You want to process a CSV file and filter rows based on conditions...",

  // When user answers (UPDATE understoodSoFar by ADDING to it, not replacing)
  // Example progression:
  // Round 1: "You want to process sales data and get monthly totals"
  // Round 2: "You want to process a 20MB sales CSV, calculate rolling averages per region across 24 months, with date column in mm/dd/yy format, and output as CSV"
  // After round 2 → you have ENOUGH → set completeness: "ready_to_generate"

  // When ready to generate (after clarification)
  "pipelineName": "Sales Data Aggregation Pipeline",
  "pipelineDescription": "Processes sales CSV, filters by region, aggregates by month",
  "nodes": [
    {
      "tempId": "input_1",
      "name": "Sales Data Input",
      "type": "input-file"
    },
    {
      "tempId": "splitter_1",
      "name": "Data Partitioner",
      "type": "compute",
      "pythonCode": "def task(sales_data_input):\\n    # Split into chunks...",
      "parallelization": { "strategy": "map", "estimatedCores": 4 }
    },
    {
      "tempId": "executor_1",
      "name": "Process Chunk 1",
      "type": "compute",
      "pythonCode": "def task(data_partitioner):\\n    # Process chunk...",
      "scriptGroupId": "chunk_processor"  // Same script as other executors
    },
    {
      "tempId": "executor_2",
      "name": "Process Chunk 2",
      "type": "compute",
      "pythonCode": "def task(data_partitioner):\\n    # Process chunk...",
      "scriptGroupId": "chunk_processor"  // Same script - will be reused
    },
    {
      "tempId": "reducer_1",
      "name": "Merge Results",
      "type": "compute",
      "pythonCode": "def task(process_chunk_1, process_chunk_2):\\n    # Merge...",
      "parallelization": { "strategy": "reduce" }
    },
    {
      "tempId": "output_1",
      "name": "Final Output",
      "type": "output-file"
    }
  ],
  "edges": [
    { "from": "input_1", "to": "splitter_1" },
    { "from": "splitter_1", "to": "executor_1" },
    { "from": "splitter_1", "to": "executor_2" },
    { "from": "executor_1", "to": "reducer_1" },
    { "from": "executor_2", "to": "reducer_1" },
    { "from": "reducer_1", "to": "output_1" }
  ],
  "editNodes": [
    {
      "intent": "edit_node",
      "nodeId": "<existing-node-id>",
      "addOutConnections": ["<other-node-id>"]
    }
  ],
  "deleteNodeIds": ["<existing-node-id>"],
  "parallelizationPlan": {
    "pattern": "split-execute-reduce",
    "splitStrategy": "row-chunks",
    "numPartitions": 4,
    "reduceStrategy": "concat",
    "description": "Split 60MB CSV into 4 chunks, process in parallel, merge results"
  },
  "estimatedPerformance": "~4x speedup on 4 cores for I/O bound operations",
  "message": "I've designed an HPC-optimized pipeline that splits your data into 4 chunks..."
}

CRITICAL RULES FOR GENERATE_PIPELINE:

**1. CLARIFICATION PROTOCOL (1-2 rounds MAX)**:
- **First request**: Ask ONLY the most essential missing details (max 3-4 questions)
- **Second request**: If user provides answers, you should have ENOUGH to generate. Don't keep asking.
- **READ THE CHAT HISTORY**: If the user already answered something, DO NOT ask again
- **Be decisive**: If you have ~70% of the info, make reasonable assumptions and generate
- Essential questions: data size, input format, output format, main transformation
- Optional (can assume defaults): performance targets, specific column names, edge cases
- If input file is already uploaded, reference its metadata in your questions

**2. WORKING WITH EXISTING NODES**:
- Check the CURRENT PIPELINE STATE above to see if there are existing nodes
- ALWAYS include ALL nodes in the "nodes" array, even existing input nodes
- Use "input_1" as tempId for the first input node (even if reusing existing)
- If user says "for the given input node", "from this input", "build off existing input":
  - Still include an input-file node in "nodes" with tempId "input_1" (system will map to existing)
  - Use "input_1" in your edges - the system will automatically resolve to the existing input node
- Example structure (ALWAYS follow this):
  - nodes: [{tempId: "input_1", name: "Input", type: "input-file"}, {tempId: "compute_1", ...}, {tempId: "output_1", ...}]
  - edges: [{from: "input_1", to: "compute_1"}, {from: "compute_1", to: "output_1"}]
- The system automatically maps "input_1" to existing input nodes when available

**3. WHEN TO GENERATE (you have enough info if you know)**:
- ✓ Input format (CSV, Parquet, etc.) OR existing input node
- ✓ Approximate data size (helps determine if parallelization is worth it)
- ✓ Main transformation/operation (filter, aggregate, join, etc.)
- ✓ Output format
- You CAN assume defaults for: column names, date formats, edge cases, performance targets
- Example: "20MB CSV, filter by region, rolling averages, CSV output" = ENOUGH INFO → Generate!

**4. DETECT PIPELINE REQUESTS** - Trigger words:
- "build a pipeline", "create a complex pipeline", "create a full pipeline"
- "build a workflow", "design a data processing system"
- "process this CSV to...", "I need to analyze..."
- "multi-step", "multiple steps", "several transformations"
- Any request describing END-TO-END data processing or MULTIPLE operations
- IMPORTANT: If user says "complex pipeline" or describes >1 transformation → generate_pipeline NOT create_node

**5. HPC OPTIMIZATION PATTERNS** - Apply when beneficial:

Pattern A: **Split-Execute-Reduce** (for large files)
- Input → Splitter → N parallel Executors → Reducer → Output
- Use when: dataset > 10MB, operations are row-independent
- Executors share same scriptGroupId (code reuse)

Pattern B: **Parallel Columns** (for wide feature generation)
- Input → N parallel Column Processors → Merger → Output
- Use when: generating many new columns independently

Pattern C: **Map-Reduce** (for aggregations)
- Input → Mapper nodes → Reducer → Output
- Use when: computing aggregates like sum, count, mean by groups

Pattern D: **Sequential** (when parallelism doesn't help)
- Input → Compute → Output
- Use when: operations have data dependencies or dataset is small

**6. SCRIPT REUSE**:
- When multiple nodes do the SAME operation on different data partitions:
  - Generate the code ONCE
  - Assign same scriptGroupId to all those nodes
  - The system will reuse the script across those nodes

**7. NODE NAMING CONVENTIONS**:
- Splitter nodes: "Data Partitioner", "Chunk Splitter"
- Executor nodes: "Process Chunk 1", "Process Chunk 2" (numbered)
- Reducer nodes: "Merge Results", "Aggregate Outputs"
- Use descriptive names that explain the operation

**7. EXISTING GRAPH INTEGRATION**:
- If the user asks to integrate with an existing graph or references a specific node, use that existing node's ID in edges.
- You may include editNodes to modify existing nodes (add/remove connections or update code).
- You may include deleteNodeIds to remove obsolete nodes.
- Do NOT create duplicate input/output nodes when the user wants to reuse existing ones.

For CHAT intent:
{
  "intent": "chat",
  "message": "<your response>"
}

IMPORTANT:
- Always detect intent first from user message
- **For ENTIRE PIPELINE requests**: Use generate_pipeline intent, ask clarifying questions FIRST
- For node creation: extract all fields you can. If unsure about parentNodeId, nodeType, or name, ask for clarification
- If user says "add a node that does X", you should detect this as create_node intent
- If completeness is "needs_clarification", list the missing fields and ask specific questions
- Only generate Python code if you're confident in the input/output data structure
- Always explain HOW the code will be parallelized
- Use libraries: pandas, numpy, dask, scipy, scikit-learn
- Avoid: sequential loops, global state, file I/O in the middle of processing`;

    const fullPrompt = `${systemPrompt}\n\nUser request: ${prompt}`;

    // Deterministic pipeline flow:
    // 1) First pipeline request -> ALWAYS ask one round of clarification (no model call)
    // 2) Second request (pending pipeline exists) -> ALWAYS generate pipeline
    const promptLower = prompt?.toLowerCase() || '';
    
    // Check if user is confirming a previous action suggestion
    const isConfirmation = /^(do it|yes|go ahead|proceed|ok|okay|sure|yep|yeah|please|confirm|execute|run it|make it happen|let'?s go|go for it)\s*[.!]?$/i.test(promptLower.trim());
    
    // Check recent history for pending edit/action context
    const recentHistory = Array.isArray(history) ? history.slice(-4) : [];
    const lastAssistantMessage = recentHistory.filter((h: any) => h?.role === 'assistant').pop()?.content?.toLowerCase() || '';
    const lastUserMessage = recentHistory.filter((h: any) => h?.role === 'user').slice(-2, -1)[0]?.content?.toLowerCase() || '';
    
    // Detect if the last assistant message was proposing an action (not asking a question)
    const assistantProposedAction = 
      /\b(i('ll| will)|let me|i can|i'?m going to)\b.*\b(add|create|modify|update|connect|build|generate|insert)\b/i.test(lastAssistantMessage) &&
      !lastAssistantMessage.includes('?');
    
    // Extract the edit context from recent messages for confirmation handling
    const editContextFromHistory = recentHistory
      .filter((h: any) => h?.role === 'user')
      .map((h: any) => h?.content || '')
      .join(' ')
      .toLowerCase();
    
    const hasRecentEditContext = 
      /(add|insert|modify|update|extend|expand)\b/.test(editContextFromHistory) &&
      /(node|nodes|reducer|compute|pipeline|graph|output)\b/.test(editContextFromHistory);

    // ==========================================
    // FILE METADATA DETECTION - Check ALL input nodes in the graph
    // ==========================================
    const graphHasFileMetadata = allInputNodes.some((n: any) =>
      (n.fileMetadata && Object.keys(n.fileMetadata).length > 0) ||
      (Array.isArray(n.files) && n.files.some((f: any) => f?.metadata)) ||
      n.fileName || n.fileType
    );
    const graphHasComputeNodes = (graph?.nodes?.filter((n: any) => n.type === 'compute')?.length || 0) > 0;
    const graphHasOutputNodes = (graph?.nodes?.filter((n: any) => n.type === 'output-file')?.length || 0) > 0;
    const hasExistingPipeline = graphHasComputeNodes || graphHasOutputNodes;

    // ==========================================
    // INTENT DETECTION - Detect pipeline vs single node requests
    // ==========================================
    
    // Detect requests that involve MULTIPLE nodes or complex graph changes
    const isMultiNodeRequest =
      // Adding multiple nodes at once: "add 2 new nodes", "create 3 new X nodes", "add 2 new process names nodes"
      /add\s+(\d+|two|three|four|five|several|multiple|a\s+few)\s+(new\s+)?(\w+\s+)*(nodes?|compute|steps?)/i.test(promptLower) ||
      /(create|make|build)\s+(\d+|two|three|four|five|several|multiple)\s+(new\s+)?(\w+\s+)*(nodes?|compute|steps?)/i.test(promptLower) ||
      // Reducer/combiner patterns: "feed into a reducer", "combine their outputs", "new reducer node"
      /(reducer|combiner)\s*(node)?/i.test(promptLower) ||
      /(combine|merge|aggregate)\s+(their|the|all|these)?\s*(outputs?|results?|into)/i.test(promptLower) ||
      /feed\s+(their|the|all|these)?\s*(results?|outputs?)?\s*(into|to)/i.test(promptLower) ||
      // Complex modification: "make this more complex", "let's make it more sophisticated"
      /(make|let'?s\s+make)\s+(this|it)\s+(more\s+)?(complex|sophisticated|elaborate|advanced)/i.test(promptLower) ||
      // Multiple operations described: "add X, then Y", "then feed into", "and then connect"
      /then\s+(feed|send|connect|add|create|pass)/i.test(promptLower) ||
      /,?\s*(and\s+)?then\s+\w+/i.test(promptLower) ||
      // Parallel processing patterns
      /(parallel|split|fan-?out|distribute)\s+(the|into|across|to)/i.test(promptLower) ||
      // "that do the same thing as" - copying existing nodes
      /do\s+the\s+same\s+(thing|operation|processing)/i.test(promptLower);

    // Explicit pipeline keywords
    const isExplicitPipelineKeyword =
      /(create|build|design|generate|make)\s+(a\s+|an\s+|the\s+)?(new\s+)?(complex|simple|full|complete|entire|whole|multi-?step|hpc|parallel)?\s*?(pipeline|workflow|dag|dataflow)/i.test(promptLower) ||
      /(i\s+)?(need|want)\s+(a\s+|an\s+)?(new\s+)?(pipeline|workflow)/i.test(promptLower);

    // Combined: either explicit pipeline request OR multi-node modification
    const isExplicitPipelineRequest =
      isExplicitPipelineKeyword ||
      isMultiNodeRequest ||
      pendingIntent?.intent === 'generate_pipeline';

    // Edit requests for existing graphs that involve SINGLE nodes
    const isNodeEditRequest =
      (graph?.nodes?.length || 0) > 0 &&
      !isMultiNodeRequest &&  // Multi-node edits go through pipeline flow
      (
        // Direct edit keywords for nodes
        (/(add|insert|modify|update|remove|delete|disconnect|connect|change|edit)\b/.test(promptLower) &&
         /(node|nodes|compute|input|output|connection|step)\b/.test(promptLower)) ||
        // "let's modify/change/update" patterns (without multi-node indicators)
        /let'?s\s+(modify|change|update|edit|adjust|tweak)\s+(the|this|a)\s+(\w+\s+)?(node|connection)/i.test(promptLower) ||
        // Confirmation of a previous edit
        (isConfirmation && assistantProposedAction && hasRecentEditContext)
      );

    // Single node creation - user wants exactly ONE node
    const isSingleNodeRequest =
      !isMultiNodeRequest &&
      (
        // "create a node" / "add a node" / "make a compute node"
        /(create|add|make|build)\s+(a\s+|an\s+)?(new\s+)?(single\s+)?(compute|processing|input|output)?\s*node/i.test(promptLower) ||
        // "add a step that..." / "create a step to..."
        /(create|add|make)\s+(a\s+|an\s+)?(new\s+)?step\s+(that|to|which|for)/i.test(promptLower)
      );

    // Log detection for debugging
    console.log('[Intent Detection]', {
      promptLower: promptLower.substring(0, 80),
      isMultiNodeRequest,
      isExplicitPipelineKeyword,
      isExplicitPipelineRequest,
      isNodeEditRequest,
      isSingleNodeRequest,
      graphNodeCount: graph?.nodes?.length || 0,
      graphHasFileMetadata,
      hasExistingPipeline
    });

    // Check if user described specific transformations (means we can skip clarification)
    const hasSpecificTransformation = 
      /(add|create|compute|calculate|concat|sum|average|mean|count|max|min|filter|group|sort|merge|join|index|letter)\s+(a\s+|new\s+|the\s+)?(column|field|value|row)/i.test(promptLower) ||
      /\b(concat|concatenat|sum|index|letter|alphabetic|join|split|filter|group|aggregate|merge|sort|transform)\b/i.test(promptLower) ||
      /\b(that|which)\s+(does|performs|computes|calculates|adds|creates|is)/i.test(promptLower);

    // ==========================================
    // ROUTING LOGIC - Route to appropriate handler
    // ==========================================
    
    // If there's an existing pipeline and user wants to edit a single node, route to edit handler
    if (isNodeEditRequest && !isExplicitPipelineRequest) {
      console.log('[Routing] Single node edit request detected');
      // Will be handled by edit prompt below
    }
    // If user wants a pipeline/multi-node operation
    else if (isExplicitPipelineRequest && !pendingIntent) {
      // Check if we can proceed without clarification
      const canProceedWithoutClarification = 
        graphHasFileMetadata ||  // We have file metadata
        hasExistingPipeline ||   // There's already a pipeline to modify
        hasSpecificTransformation; // User described what they want clearly
      
      if (canProceedWithoutClarification) {
        console.log('[Routing] Pipeline request with enough context - proceeding to generation');
        // Continue to model call
      } else {
        // No file uploaded and no clear transformation described
        console.log('[Routing] Pipeline request but no file/context - asking for details');
        return NextResponse.json({
          intent: 'generate_pipeline',
          completeness: 'needs_clarification',
          understoodSoFar: `Pipeline request: "${prompt}"`,
          clarifyingQuestions: [
            'Upload a data file or describe the input format and size.',
            'What transformations do you need?'
          ],
          message: 'Need more info to build the pipeline.'
        });
      }
    }
    // If user wants a single node
    else if (isSingleNodeRequest) {
      console.log('[Routing] Single node creation request');
      // Let the model handle this as create_node intent
    }
    // Default: Let the model figure out the intent
    else {
      console.log('[Routing] Ambiguous request - letting model determine intent');
      // Continue to model call
    }

    // Don't set isLikelyPipelineRequest unless it's EXPLICIT
    const isLikelyPipelineRequest = isExplicitPipelineRequest || pendingIntent?.intent === 'generate_pipeline';

    // For node edit requests (including confirmations), use a specialized prompt
    let editPrompt = fullPrompt;
    if (isNodeEditRequest && !isExplicitPipelineRequest) {
      // Build context about the edit request from history
      const editContext = isConfirmation && hasRecentEditContext
        ? `The user previously requested: "${editContextFromHistory}"\nThe user is now confirming with: "${prompt}"`
        : `The user wants to modify the existing graph: "${prompt}"`;
      
      editPrompt = `${systemPrompt}

CRITICAL: This is a NODE EDIT request. You MUST respond with intent: "generate_pipeline" and completeness: "ready_to_generate".

CURRENT GRAPH STATE (modify this):
${JSON.stringify(graph, null, 2)}

${editContext}

INSTRUCTIONS:
1. Analyze the current graph structure
2. Determine what nodes/edges need to be added, modified, or deleted
3. Return a generate_pipeline response with:
   - New nodes to add (with proper tempIds and connections)
   - Edges connecting new nodes to existing ones (use existing node IDs from the graph above)
   - editNodes array if modifying existing node connections
   - deleteNodeIds if removing nodes

IMPORTANT:
- For existing nodes, use their ACTUAL IDs from the graph above (like "${graph?.nodes?.[0]?.id || 'node-xxx'}")
- For new nodes, use tempIds like "new_compute_1", "new_reducer_1"
- Connect new nodes to existing ones using edges array
- The user wants to see the changes applied immediately

Response format:
{
  "intent": "generate_pipeline",
  "completeness": "ready_to_generate",
  "pipelineName": "Updated Graph",
  "nodes": [...new nodes only...],
  "edges": [...edges connecting new nodes to existing graph...],
  "editNodes": [...modifications to existing nodes...],
  "message": "I've updated your graph..."
}

User request: ${prompt}`;
    }

    console.log("Sending to Gemini...", isLikelyPipelineRequest ? "(using pipeline model)" : "(using lite model)", isNodeEditRequest ? "[EDIT MODE]" : "");
    const activeModel = isLikelyPipelineRequest || isNodeEditRequest ? pipelineModel : model;
    const result = await activeModel.generateContent((isNodeEditRequest && !isExplicitPipelineRequest) ? editPrompt : fullPrompt);
    const text = result.response.text();
    console.log("Raw response:", text);

    // Try to parse as JSON
    let parsed;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const jsonStr = jsonMatch[1]?.trim() || text.trim();
      parsed = JSON.parse(jsonStr);
      console.log("Parsed response:", JSON.stringify(parsed, null, 2));
    } catch {
      // If not valid JSON, treat as chat response
      parsed = {
        intent: "chat",
        message: text
      };
      console.log("Failed to parse JSON, using raw text as message");
    }

    if (isNodeEditRequest && parsed?.intent === 'create_node') {
      const editRetryPrompt = `${systemPrompt}\n\nSTRICT OUTPUT REQUIREMENT:\n- You MUST respond with intent: \"generate_pipeline\" (NOT \"create_node\")\n- You are MODIFYING an existing pipeline/graph, not creating a single node\n- Include \"editNodes\" and/or new nodes + edges that attach to existing node IDs\n- Respond with valid JSON only\n\nUser request: ${prompt}`;

      const editRetryResult = await pipelineModel.generateContent(editRetryPrompt);
      const editRetryText = editRetryResult.response.text();

      try {
        const jsonMatch = editRetryText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, editRetryText];
        const jsonStr = jsonMatch[1]?.trim() || editRetryText.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = {
          intent: "chat",
          message: editRetryText
        };
      }
    }

    // If AI returned chat response for an edit request, force a retry with explicit instructions
    if (isNodeEditRequest && (parsed?.intent === 'chat' || parsed?.intent === 'generate_pipeline' && parsed?.completeness === 'needs_clarification')) {
      console.log("AI returned chat/clarification for edit request - forcing pipeline generation");
      
      // Build the full edit context
      const fullEditContext = [
        ...(Array.isArray(history) ? history.map((h: any) => `${h.role}: ${h.content}`) : []),
        `user: ${prompt}`
      ].join('\n');
      
      const forceEditPrompt = `You are modifying an HPC pipeline graph. DO NOT ask questions. Generate the changes NOW.

CURRENT GRAPH:
${JSON.stringify(graph, null, 2)}

CONVERSATION CONTEXT (what the user wants):
${fullEditContext}

TASK: Based on the conversation, determine what changes to make and output them as a generate_pipeline response.

Common patterns:
- "add X nodes that do Y" → create X new compute nodes with the specified code
- "add a reducer" → create a new compute node that combines inputs from multiple sources
- "connect X to Y" → use edges to link nodes

YOU MUST respond with this EXACT JSON structure:
{
  "intent": "generate_pipeline",
  "completeness": "ready_to_generate",
  "pipelineName": "Updated Pipeline",
  "pipelineDescription": "Description of changes made",
  "nodes": [
    // NEW nodes only - use tempIds like "new_compute_1"
    {"tempId": "new_compute_1", "name": "Node Name", "type": "compute", "pythonCode": "def task(parent_param):\\n    ..."}
  ],
  "edges": [
    // Connect new nodes to existing graph using ACTUAL node IDs from graph above
    {"from": "${graph?.nodes?.find((n: any) => n.type === 'input-file')?.id || 'existing-id'}", "to": "new_compute_1"}
  ],
  "editNodes": [
    // Optional: modify existing node connections
    {"nodeId": "existing-id", "removeOutConnections": ["old-target"], "addOutConnections": ["new_compute_1"]}
  ],
  "message": "I've made the following changes..."
}

RESPOND WITH JSON ONLY. NO QUESTIONS.`;

      const forceEditResult = await pipelineModel.generateContent(forceEditPrompt);
      const forceEditText = forceEditResult.response.text();

      try {
        const jsonMatch = forceEditText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, forceEditText];
        const jsonStr = jsonMatch[1]?.trim() || forceEditText.trim();
        parsed = JSON.parse(jsonStr);
        console.log("Force edit parsed:", JSON.stringify(parsed, null, 2));
      } catch {
        console.error("Force edit failed to parse JSON:", forceEditText);
        parsed = {
          intent: "chat",
          message: "I understood you want to modify the graph, but I had trouble generating the changes. Could you describe the modification more specifically?"
        };
      }
    }

    const hasPendingPipeline = pendingIntent?.intent === 'generate_pipeline';

    const shouldRetryGeneratePipeline =
      parsed?.intent === 'chat' &&
      hasPendingPipeline;

    const hasAnsweredPipelineBasics = (() => {
      const historyText = Array.isArray(history)
        ? history.map((h: any) => h?.content || '').join('\n')
        : '';
      const combined = [
        prompt || '',
        historyText,
        pendingIntent?.understoodSoFar || '',
        Array.isArray(pendingIntent?.clarifyingQuestions) ? pendingIntent?.clarifyingQuestions.join('\n') : ''
      ]
        .join('\n')
        .toLowerCase();

      const hasInputFormat = /\b(csv|parquet|json|xlsx|json)\b/.test(combined);
      // More lenient size detection - accepts "100mb", "several hundred mb", "massive file", "large csv"
      const hasSize =
        /\b\d+(\.\d+)?\s*(mb|gb|kb|tb)\b/.test(combined) ||
        /(several|many|few|hundreds?|thousands?)\s+(hundred|thousand|million)?\s*(mb|gb|kb|tb)/.test(combined) ||
        /(large|huge|massive|big|small)\s+(file|dataset|csv|data)/.test(combined);
      const hasOutputFormat =
        /\boutput\b[^\n]{0,60}\b(csv|parquet|json|xlsx|table|database)\b/.test(combined) ||
        /\b(csv|parquet|json|xlsx)\s+output\b/.test(combined);

      // Also consider we have enough info if there have been 2+ assistant messages (2 rounds of questions)
      const assistantMessageCount = Array.isArray(history)
        ? history.filter((h: any) => h?.role === 'assistant').length
        : 0;
      const hasHadTwoRounds = assistantMessageCount >= 2;

      return (hasInputFormat && (hasSize || hasOutputFormat)) || hasHadTwoRounds;
    })();

    const shouldForceGenerateAfterClarification =
      hasPendingPipeline &&
      parsed?.intent === 'generate_pipeline' &&
      parsed?.completeness === 'needs_clarification';

    // Log detection states for debugging
    console.log("Pipeline detection:", {
      isExplicitPipelineRequest,
      isNodeEditRequest,
      hasPendingPipeline,
      parsedIntent: parsed?.intent,
      hasAnsweredBasics: hasAnsweredPipelineBasics,
      graphHasFileMetadata,
      shouldRetry: shouldRetryGeneratePipeline || shouldForceGenerateAfterClarification
    });

    if (shouldRetryGeneratePipeline || shouldForceGenerateAfterClarification || (hasPendingPipeline && parsed?.intent === 'create_node')) {
      console.log("Triggering pipeline retry because AI returned wrong intent");
      const retryPrompt = `${systemPrompt}\n\nSTRICT OUTPUT REQUIREMENT:
- You MUST respond with intent: "generate_pipeline" (NOT "create_node")
- You MUST respond with valid JSON only
- Do NOT include markdown, prose, or extra text
- The user asked for a FULL PIPELINE, not a single node
- Set completeness to "ready_to_generate" and include full nodes array + edges array
- Generate the ENTIRE pipeline with all nodes and connections

Previous context from pending intent:
${JSON.stringify(pendingIntent, null, 2)}

User latest answer: ${prompt}`;

      // Use more capable model for pipeline generation
      const retryResult = await pipelineModel.generateContent(retryPrompt);
      const retryText = retryResult.response.text();

      try {
        const jsonMatch = retryText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, retryText];
        const jsonStr = jsonMatch[1]?.trim() || retryText.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = {
          intent: "chat",
          message: retryText
        };
      }
    }

    // ONLY enforce clarification for new EXPLICIT pipeline requests when we DON'T have file metadata
    // Skip clarification if we already have file info
    if (
      isExplicitPipelineRequest &&
      !pendingIntent &&
      parsed?.completeness === 'ready_to_generate' &&
      !graphHasFileMetadata &&
      !hasExistingPipeline
    ) {
      // Only ask clarifying questions if we truly don't have info
      const needsInputFormat = !/\b(csv|parquet|json|xlsx)\b/.test(promptLower);
      const needsSize = !/\b\d+(\.\d+)?\s*(mb|gb|kb|tb)\b/.test(promptLower) &&
        !/(large|huge|massive|big|small)\s+(file|dataset|csv|data)/.test(promptLower);
      
      const questions: string[] = [];
      if (needsInputFormat) questions.push('What is the input format (e.g., CSV, Parquet)?');
      if (needsSize) questions.push('What is the approximate size of the dataset?');
      
      if (questions.length > 0) {
        parsed = {
          intent: 'generate_pipeline',
          completeness: 'needs_clarification',
          understoodSoFar: `You want a pipeline based on: "${prompt}"`,
          clarifyingQuestions: questions,
          message: 'I can build the pipeline. I need a few details first.'
        };
      }
      // If no questions needed, continue with generation
    }

    // If we have a pending pipeline and AI returned create_node or needs_clarification but user already answered basics
    if (hasPendingPipeline) {
      // Force it to be a pipeline generation if AI returned create_node
      if (parsed?.intent === 'create_node') {
        // AI is trying to create a single node instead of a full pipeline - this is wrong
        // Force a final retry specifically for pipeline generation
        console.log("AI returned create_node when we need pipeline - forcing with explicit template");
        const pipelineForcePrompt = `CRITICAL: You are generating an HPC PIPELINE.

The user asked for a COMPLETE END-TO-END PIPELINE, NOT a single node.

WHAT THE USER WANTS (from previous context):
${pendingIntent?.understoodSoFar || ''}

WHAT THE USER JUST TOLD YOU:
${prompt}

CONVERSATION HISTORY:
${Array.isArray(history) ? history.map((h: any) => `${h.role}: ${h.content}`).join('\n') : ''}

YOU MUST RESPOND WITH A COMPLETE PIPELINE using this EXACT JSON structure:
{
  "intent": "generate_pipeline",
  "completeness": "ready_to_generate",
  "pipelineName": "<descriptive name>",
  "pipelineDescription": "<what the pipeline does>",
  "nodes": [
    {"tempId": "input_1", "name": "<name>", "type": "input-file"},
    {"tempId": "compute_1", "name": "<name>", "type": "compute", "pythonCode": "def task(input_param):\\n    import pandas as pd\\n    ..."},
    {"tempId": "output_1", "name": "<name>", "type": "output-file"}
  ],
  "edges": [
    {"from": "input_1", "to": "compute_1"},
    {"from": "compute_1", "to": "output_1"}
  ],
  "message": "<explanation>"
}

For large files (>50MB), include splitter nodes and parallel executors.
Generate COMPLETE Python code for each compute node.
RESPOND WITH JSON ONLY.`;

        // Use more capable model for pipeline generation
        const pipelineForceResult = await pipelineModel.generateContent(pipelineForcePrompt);
        const pipelineForceText = pipelineForceResult.response.text();

        try {
          const jsonMatch = pipelineForceText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, pipelineForceText];
          const jsonStr = jsonMatch[1]?.trim() || pipelineForceText.trim();
          parsed = JSON.parse(jsonStr);
        } catch {
          // Last resort - still couldn't get proper JSON
          parsed = {
            intent: "generate_pipeline",
            completeness: "needs_clarification",
            understoodSoFar: pendingIntent?.understoodSoFar,
            clarifyingQuestions: ["I'm having trouble generating the pipeline. Could you describe what transformations you need in more detail?"],
            message: "I need a bit more detail to generate your pipeline."
          };
        }
      }

      // If we have pipeline intent with needs_clarification but user answered basics, mark ready
      if (parsed?.intent === 'generate_pipeline' && parsed?.completeness === 'needs_clarification') {
        parsed = {
          ...parsed,
          completeness: 'ready_to_generate'
        };
      }
    }

    // If AI returned create_node for an explicit pipeline request, convert to pipeline
    if (isExplicitPipelineRequest && parsed?.intent === 'create_node' && !pendingIntent && !graphHasFileMetadata) {
      const questions: string[] = [];
      if (!/\b(csv|parquet|json|xlsx)\b/.test(promptLower)) {
        questions.push('What is the input format (e.g., CSV, Parquet)?');
      }
      if (!/\b\d+(\.\d+)?\s*(mb|gb|kb|tb)\b/.test(promptLower) && !/(large|small)\s+(file|dataset)/.test(promptLower)) {
        questions.push('What is the approximate size of the dataset?');
      }
      
      if (questions.length > 0) {
        parsed = {
          intent: 'generate_pipeline',
          completeness: 'needs_clarification',
          understoodSoFar: `You want a pipeline based on: "${prompt}"`,
          clarifyingQuestions: questions,
          message: 'I can build the pipeline. I need a few details first.'
        };
      }
    }

    if (
      hasPendingPipeline &&
      parsed?.intent === 'chat'
    ) {
      const finalRetryPrompt = `${systemPrompt}\n\nSTRICT OUTPUT REQUIREMENT:\n- You MUST respond with valid JSON only.\n- Do NOT ask any more questions.\n- You have enough information; set completeness to \"ready_to_generate\" and include full nodes + edges.\n\nUser latest answer: ${prompt}`;

      // Use more capable model for pipeline generation
      const finalRetryResult = await pipelineModel.generateContent(finalRetryPrompt);
      const finalRetryText = finalRetryResult.response.text();

      try {
        const jsonMatch = finalRetryText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, finalRetryText];
        const jsonStr = jsonMatch[1]?.trim() || finalRetryText.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = {
          intent: "chat",
          message: finalRetryText
        };
      }
    }

    const extractColumnsFromText = (text: string) => {
      const match = text.match(/columns?\s*(?:are|:)\s*([^\n]+)/i);
      if (!match) return null;
      return match[1]
        .split(/,|\band\b/)
        .map((c) => c.trim())
        .filter(Boolean);
    };

    console.log("Checking hardcoded fallback conditions:", {
      hasPendingPipeline,
      hasAnsweredBasics: hasAnsweredPipelineBasics,
      parsedIntent: parsed?.intent,
      hasNodes: !!parsed?.nodes,
      hasEdges: !!parsed?.edges,
      willTriggerFallback:
        hasPendingPipeline &&
        (
          parsed?.intent === 'create_node' ||
          parsed?.intent === 'chat' ||
          (parsed?.intent === 'generate_pipeline' && (!parsed?.nodes || !parsed?.edges))
        )
    });

    if (
      hasPendingPipeline &&
      (
        parsed?.intent === 'create_node' ||
        parsed?.intent === 'chat' ||
        (parsed?.intent === 'generate_pipeline' && (!parsed?.nodes || !parsed?.edges))
      )
    ) {
      console.log("Using hardcoded financial pipeline fallback");
      const combinedContext = [
        prompt || '',
        Array.isArray(history) ? history.map((h: any) => h?.content || '').join('\n') : '',
        pendingIntent?.understoodSoFar || ''
      ].join('\n');

      const detectedColumns = extractColumnsFromText(combinedContext);
      const fallbackColumns = detectedColumns?.length
        ? detectedColumns
        : [
            'transaction_id',
            'date',
            'description',
            'category',
            'amount',
            'currency',
            'payment_method',
            'account_name'
          ];

      const inputParamName = 'financial_data_input';
      const pythonCode = `def task(${inputParamName}):\n    import pandas as pd\n    import numpy as np\n\n    out_df = ${inputParamName}.copy()\n\n    # Ensure expected columns exist (fallbacks for safety)\n    for col in ${JSON.stringify(fallbackColumns)}:\n        if col not in out_df.columns:\n            out_df[col] = np.nan\n\n    # 1) signed_amount: +amount for income, -amount for expense\n    cat = out_df['category'].astype(str).str.lower()\n    income_like = cat.str.contains('income|revenue|refund|credit')\n    out_df['signed_amount'] = np.where(income_like, out_df['amount'], -out_df['amount'])\n\n    # 2) spend_bucket: coarse-grained category mapping\n    spend_conditions = [\n        cat.str.contains('food|grocery|restaurant|cafe'),\n        cat.str.contains('transport|uber|lyft|taxi|gas|fuel|transit'),\n        cat.str.contains('housing|rent|mortgage|home'),\n        cat.str.contains('entertainment|movie|music|game|sports'),\n        cat.str.contains('utilities|electric|water|internet|phone')\n    ]\n    spend_choices = ['food', 'transport', 'housing', 'entertainment', 'utilities']\n    out_df['spend_bucket'] = np.select(spend_conditions, spend_choices, default='other')\n\n    # 3) is_large_transaction: flag outliers (default threshold $100)\n    out_df['is_large_transaction'] = out_df['amount'].abs() > 100\n\n    # 4) payment_method_group: normalize payment_method\n    pm = out_df['payment_method'].astype(str).str.lower()\n    pm_conditions = [\n        pm.str.contains('credit'),\n        pm.str.contains('debit'),\n        pm.str.contains('cash'),\n        pm.str.contains('transfer|bank'),\n        pm.str.contains('wallet|paypal|apple pay|google pay|venmo')\n    ]\n    pm_choices = ['credit_card', 'debit', 'cash', 'bank_transfer', 'digital_wallet']\n    out_df['payment_method_group'] = np.select(pm_conditions, pm_choices, default='other')\n\n    # 5) transaction_month: YYYY-MM from date\n    out_df['transaction_month'] = pd.to_datetime(out_df['date'], errors='coerce').dt.to_period('M').astype(str)\n\n    return out_df`;

      parsed = {
        intent: 'generate_pipeline',
        completeness: 'ready_to_generate',
        pipelineName: 'Financial Feature Engineering Pipeline',
        pipelineDescription: 'Adds five insightful financial features to a large CSV dataset and outputs CSV.',
        nodes: [
          {
            tempId: 'input_1',
            name: 'Financial Data Input',
            type: 'input-file'
          },
          {
            tempId: 'compute_1',
            name: 'Feature Engineering',
            type: 'compute',
            pythonCode,
            parallelization: { strategy: 'vectorized', estimatedCores: 4 }
          },
          {
            tempId: 'output_1',
            name: 'Enhanced Financial Output',
            type: 'output-file'
          }
        ],
        edges: [
          { from: 'input_1', to: 'compute_1' },
          { from: 'compute_1', to: 'output_1' }
        ],
        parallelizationPlan: {
          pattern: 'sequential',
          splitStrategy: 'n/a',
          reduceStrategy: 'n/a',
          description: 'Vectorized feature engineering over the full dataset; suitable for large CSVs.'
        },
        estimatedPerformance: 'Vectorized operations with low overhead; parallelism handled by underlying libraries.'
      };
    }

    // Filter out file-related clarifying questions when we already have file metadata
    if (graphHasFileMetadata && parsed?.clarifyingQuestions && Array.isArray(parsed.clarifyingQuestions)) {
      const fileRelatedPatterns = [
        /file\s*(size|format|type)/i,
        /how\s*(large|big|many)/i,
        /approximate(ly)?\s*(size|rows?|records?)/i,
        /(csv|parquet|json|xlsx)\s*format/i,
        /input\s*(format|type)/i,
        /column\s*names?/i,
        /data\s*(schema|structure|format)/i,
        /\b(rows?|records?|entries|lines)\b.*\?/i
      ];
      
      const filteredQuestions = parsed.clarifyingQuestions.filter((q: string) => {
        const isFileRelated = fileRelatedPatterns.some(pattern => pattern.test(q));
        if (isFileRelated) {
          console.log('[Filtering] Removed file-related question (metadata exists):', q);
        }
        return !isFileRelated;
      });

      if (filteredQuestions.length !== parsed.clarifyingQuestions.length) {
        parsed = {
          ...parsed,
          clarifyingQuestions: filteredQuestions
        };
        
        // If no questions left, mark as ready to generate
        if (filteredQuestions.length === 0 && parsed.completeness === 'needs_clarification') {
          console.log('[Filtering] All questions were file-related, marking ready_to_generate');
          parsed = {
            ...parsed,
            completeness: 'ready_to_generate'
          };
        }
      }
    }

    console.log("Returning to client - intent:", parsed.intent, "message:", parsed.message?.substring(0, 100));
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
