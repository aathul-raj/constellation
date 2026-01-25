# Intent Detection & Node Creation from Chat

## Overview
The AI chat now detects user intent to create nodes and handles the full workflow: intent extraction → validation → clarification if needed → node creation with proper graph connections.

## How It Works

### 1. Intent Extraction (Gemini API)
When a user messages the chat with intent to create a node, the Gemini API recognizes patterns like:
- "create new compute from [node] that [description]"
- "add a [type] node after [parent]"
- "new step that does [task]"

The response includes:
```json
{
  "intent": "create_node",
  "nodeType": "compute",
  "nodeName": "Pass-Through Data",
  "parentNodeName": "Process Data",
  "pythonCode": "def task(input):\n    return input",
  "completeness": "complete",
  "message": "Created new compute node..."
}
```

### 2. Intent Validation
The intent validator checks if all required fields are present:
- `nodeType` - always required
- `nodeName` - always required
- `parentNodeId` or `parentNodeName` - required for non-input-file nodes
- `pythonCode` - required for compute nodes
- `childNodeId` - NOT required (terminal nodes are OK)

If any critical field is missing, the validator sets `completeness: "needs_clarification"` with specific questions.

### 3. Clarification Loop
If completeness is "needs_clarification":
1. Chat displays clarifying questions to user
2. pendingNodeCreation state is stored
3. Gemini receives the pending intent + user response
4. Gemini updates the intent with new information
5. Chat component trusts Gemini's completeness determination (no re-validation)
6. If now complete, creates the node

### 4. Node Creation
Once intent is complete, the system:
1. Resolves node names to IDs
2. Creates the new node with `createNode()`
3. Automatically connects to parent via `in`/`out` arrays
4. Optionally connects to destination node if specified
5. Selects the new node in the UI

## Key Improvements

### Fixed: "No Destination" Loop
**Problem**: When user said "no destination for now", the AI kept asking where to connect the output.

**Solution**:
- Removed validator forcing destination clarification when creating terminal nodes
- Improved Gemini prompt recognition of "no destination" phrases:
  - "no destination"
  - "no destination for now"
  - "just pass"
  - "endpoint"
  - "terminal"
  - "leaf"
  - etc.

**Implementation**:
- When user indicates "no destination", Gemini sets `completeness: "complete"` with `childNodeId` undefined
- Chat component trusts Gemini's completeness instead of re-validating
- Validator only asks about destination if truly ambiguous

### Smart Intent Preservation
When clarifying a pending intent, Gemini preserves all existing fields and only updates clarified ones:
```
PENDING INTENT (User is clarifying this):
{
  "nodeName": "Pass-Through Data",
  "parentNodeName": "Process Data",
  "nodeType": "compute",
  "childNodeId": null,  // Was being asked about
  "pythonCode": "def task(input):\n    return input",
  "completeness": "complete",  // Now satisfied after "no destination"
  ...
}
```

## File Structure

**Type Definitions**: `/app/types/intent.ts`
- `NodeCreationIntent` - Complete intent structure with all node metadata
- `CompletionStatus` - "complete" | "needs_clarification" | "error"
- `AIResponse` union type for all response types

**Validation**: `/app/utils/intent-validator.ts`
- `validateNodeCreationIntent()` - Checks what's missing
- `extractNodeContext()` - Gathers graph state for validation
- `isReadyForNodeCreation()` - Returns true if completeness === "complete"

**Chat Component**: `/app/components/AIChatPanel.tsx`
- Handles `create_node` intent case
- Trusts Gemini's completeness determination
- Manages pendingNodeCreation state
- Calls createNode/connectNodes on completion

**Store Actions**: `/app/store/hpc-store.ts`
- `createNode(type, name, parentId?, code?)` - Creates node and connects to parent
- `connectNodes(sourceId, targetId)` - Adds edge between existing nodes
- `disconnectNodes(sourceId, targetId)` - Removes edge

## Example Conversation Flow

```
User: "create new compute from process data that just passes data for now"
   ↓
Gemini:
  intent: "create_node",
  completeness: "complete",
  nodeType: "compute",
  nodeName: "Pass-Through Data",
  parentNodeName: "Process Data",
  pythonCode: "def task(input):\n    return input"
   ↓
Chat: Calls createNode(), selectNode(), displays "Created new compute node..."

User: "no destination for now"
   ↓
Gemini (with pendingIntent):
  Updates existing intent with completeness: "complete"
  Confirms: "Got it - I'll leave this as a terminal node for now"
   ↓
Chat: Node creation proceeds immediately
```

## Intent Response Types

### create_node
```typescript
{
  intent: "create_node",
  nodeType: "input-file" | "compute" | "output-file",
  nodeName: string,
  parentNodeId?: string,
  parentNodeName?: string,
  childNodeId?: string,
  childNodeName?: string,
  pythonCode?: string,
  completeness: "complete" | "needs_clarification",
  missingFields?: string[],
  clarifyingQuestions?: string[],
  message: string
}
```

### update_code
```typescript
{
  intent: "update_code",
  nodeId: string,
  code: string,
  parallelization?: { strategy, estimatedCores, chunkSize },
  message: string
}
```

### update_name
```typescript
{
  intent: "update_name",
  nodeId: string,
  name: string,
  message: string
}
```

### chat
```typescript
{
  intent: "chat",
  message: string
}
```

## Gemini Prompt Structure

The system prompt passed to Gemini includes:

1. **Pending Intent Context** (if clarifying)
   - Current incomplete intent
   - Instructions to preserve existing fields
   - Instruction to NOT re-ask answered questions

2. **Chat History** (last 6 messages)
   - Helps Gemini understand conversation context
   - Prevents loops by showing previous questions

3. **Current Pipeline State**
   - Full graph JSON
   - Node names, types, connections

4. **Critical Rules**
   - How to recognize and handle "no destination" patterns
   - How to preserve intent during clarification
   - When to mark completeness as "complete" vs "needs_clarification"

## Testing Patterns

Try these to test intent detection:

1. **Basic node creation**:
   - "create new compute from Process Data that filters rows"
   - "add a compute node after Input Data"

2. **Terminal nodes (no destination)**:
   - "create new compute from process data that just passes data for now"
   - Then say: "no destination for now" → should immediately create node

3. **With destination**:
   - "new compute that transforms data and sends to Output Data"
   - Should create + connect in one go

4. **Input node**:
   - "add an input file node"
   - Should create without asking for parent (input files have no parent)
