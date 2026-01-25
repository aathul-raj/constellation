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
   - **Generate an ENTIRE pipeline** (e.g., "build a pipeline to process sales data", "I want to do X with my dataset")
   - Create a NEW node (e.g., "add a filtering step", "create a compute node that aggregates")
   - Edit an existing node (connections, code, name)
   - Update code on the selected node
   - Just ask a question

2. **For FULL PIPELINE requests** (generate_pipeline intent):
   - ALWAYS ask clarifying questions first (minimum one round)
   - Understand: desired outputs, transformations, scale, performance needs
   - If input file exists, reference its metadata in questions
   - When ready: design an HPC-optimized dependency graph
   - Apply parallelization patterns: split-execute-reduce, parallel-columns, map-reduce
   - Generate all nodes with proper edges and code

3. **For node creation requests**:
   - Extract the node type they want: input-file (uploading data), compute (processing), or output-file (results)
   - Extract the node name
   - Identify which parent node it should connect from (usually the most recent node before it)
   - If compute node: generate the Python code skeleton
   - If you can't determine something, ask for clarification

4. **For code updates**: Generate parallelizable code for the selected node

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

**2. WHEN TO GENERATE (you have enough info if you know)**:
- ✓ Input format (CSV, Parquet, etc.)
- ✓ Approximate data size (helps determine if parallelization is worth it)
- ✓ Main transformation/operation (filter, aggregate, join, etc.)
- ✓ Output format
- You CAN assume defaults for: column names, date formats, edge cases, performance targets
- Example: "20MB CSV, filter by region, rolling averages, CSV output" = ENOUGH INFO → Generate!

**3. DETECT PIPELINE REQUESTS** - Trigger words:
- "build a pipeline for...", "I want to do X with a dataset"
- "create a workflow that...", "design a data processing system"
- "process this CSV to...", "I need to analyze..."
- Any request describing END-TO-END data processing

**4. HPC OPTIMIZATION PATTERNS** - Apply when beneficial:

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

**5. SCRIPT REUSE**:
- When multiple nodes do the SAME operation on different data partitions:
  - Generate the code ONCE
  - Assign same scriptGroupId to all those nodes
  - The system will reuse the script across those nodes

**6. NODE NAMING CONVENTIONS**:
- Splitter nodes: "Data Partitioner", "Chunk Splitter"
- Executor nodes: "Process Chunk 1", "Process Chunk 2" (numbered)
- Reducer nodes: "Merge Results", "Aggregate Outputs"
- Use descriptive names that explain the operation

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

    // Detect if this is likely a pipeline request early to use better model
    const promptLower = prompt?.toLowerCase() || '';
    const isLikelyPipelineRequest =
      /(create|build|design|generate)\s+(a\s+)?(pipeline|workflow)/.test(promptLower) ||
      /end-?to-?end/.test(promptLower) ||
      /process\s+this\s+(csv|parquet|json|xlsx)/.test(promptLower) ||
      pendingIntent?.intent === 'generate_pipeline';

    console.log("Sending to Gemini...", isLikelyPipelineRequest ? "(using pipeline model)" : "(using lite model)");
    const activeModel = isLikelyPipelineRequest ? pipelineModel : model;
    const result = await activeModel.generateContent(fullPrompt);
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

    const shouldRetryGeneratePipeline =
      parsed?.intent === 'chat' &&
      pendingIntent?.intent === 'generate_pipeline';

    const isPipelineRequest = (() => {
      const historyText = Array.isArray(history)
        ? history.map((h: any) => h?.content || '').join('\n')
        : '';
      const combined = [prompt || '', historyText, pendingIntent?.understoodSoFar || '']
        .join('\n')
        .toLowerCase();
      return /(create|build|design|generate)\s+(a\s+)?(pipeline|workflow)/.test(combined) ||
        /end-?to-?end/.test(combined) ||
        /process\s+this\s+(csv|parquet|json|xlsx)/.test(combined);
    })();

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

      const hasInputFormat = /\b(csv|parquet|json|xlsx)\b/.test(combined);
      const hasSize = /\b\d+(\.\d+)?\s*(mb|gb)\b/.test(combined);
      const hasOutputFormat =
        /\boutput\b[^\n]{0,60}\b(csv|parquet|json|xlsx|table|database)\b/.test(combined) ||
        /\b(csv|parquet|json|xlsx)\s+output\b/.test(combined);

      return hasInputFormat && (hasSize || hasOutputFormat);
    })();

    const shouldForceGenerateAfterClarification =
      pendingIntent?.intent === 'generate_pipeline' &&
      parsed?.intent === 'generate_pipeline' &&
      parsed?.completeness === 'needs_clarification' &&
      hasAnsweredPipelineBasics;

    if (shouldRetryGeneratePipeline || shouldForceGenerateAfterClarification || (pendingIntent?.intent === 'generate_pipeline' && parsed?.intent === 'create_node')) {
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

    // Enforce at least one clarification round for new pipeline requests
    if (
      (parsed?.intent === 'generate_pipeline' || (parsed?.intent === 'create_node' && isPipelineRequest)) &&
      !pendingIntent &&
      parsed?.completeness === 'ready_to_generate'
    ) {
      parsed = {
        intent: 'generate_pipeline',
        completeness: 'needs_clarification',
        understoodSoFar: `You want an end-to-end pipeline based on: "${prompt}"`,
        clarifyingQuestions: [
          'What is the approximate size of the dataset (e.g., MB/GB)?',
          'What is the input format (e.g., CSV, Parquet)?',
          'What output format do you need (e.g., CSV, database table)?'
        ],
        message: 'I can build the pipeline. I need a few details first.'
      };
    }

    // If we have a pending pipeline and AI returned create_node or needs_clarification but user already answered basics
    if (
      pendingIntent?.intent === 'generate_pipeline' &&
      hasAnsweredPipelineBasics
    ) {
      // Force it to be a pipeline generation if AI returned create_node
      if (parsed?.intent === 'create_node') {
        // AI is trying to create a single node instead of a full pipeline - this is wrong
        // Force a final retry specifically for pipeline generation
        const pipelineForcePrompt = `You are generating an HPC pipeline. The user requested a FULL PIPELINE, not individual nodes.

USER'S ORIGINAL REQUEST (from context):
${pendingIntent?.understoodSoFar || ''}

USER'S LATEST ANSWER: ${prompt}

YOU MUST GENERATE A COMPLETE PIPELINE with this exact JSON structure:
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

    if (isPipelineRequest && parsed?.intent === 'create_node' && !pendingIntent) {
      parsed = {
        intent: 'generate_pipeline',
        completeness: 'needs_clarification',
        understoodSoFar: `You want an end-to-end pipeline based on: "${prompt}"`,
        clarifyingQuestions: [
          'What is the approximate size of the dataset (e.g., MB/GB)?',
          'What is the input format (e.g., CSV, Parquet)?',
          'What output format do you need (e.g., CSV, database table)?'
        ],
        message: 'I can build the pipeline. I need a few details first.'
      };
    }

    if (
      pendingIntent?.intent === 'generate_pipeline' &&
      parsed?.intent === 'chat' &&
      hasAnsweredPipelineBasics
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
