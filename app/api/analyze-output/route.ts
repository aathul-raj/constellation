import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { getExecutionLevels } from "@/app/utils/graph-transform";

export async function POST(request: NextRequest) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "API key not configured" },
        { status: 500 }
      );
    }

    const { graph, outputNodeId, outputData } = await request.json();

    if (!graph || !outputNodeId) {
      return NextResponse.json(
        { error: "Missing required parameters", message: "Graph and output node ID are required" },
        { status: 400 }
      );
    }

    if (!graph.nodes || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      return NextResponse.json(
        { error: "Invalid graph", message: "Graph contains no nodes" },
        { status: 400 }
      );
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const outputNode = graph.nodes.find((n: any) => n.id === outputNodeId);
    if (!outputNode) {
      return NextResponse.json(
        { error: "Output node not found", message: `No output node with ID ${outputNodeId}` },
        { status: 404 }
      );
    }

    if (!outputData || outputData.trim().length === 0) {
      return NextResponse.json(
        { error: "No output data", message: "Output node contains no data to analyze" },
        { status: 400 }
      );
    }

    // Get execution levels for the flow trace
    const executionLevels = getExecutionLevels(graph);

    // Build the data flow trace
    const traceSteps: string[] = [];
    executionLevels.forEach((level, idx) => {
      const levelNodes = level.map(nodeId => {
        const node = graph.nodes.find((n: any) => n.id === nodeId);
        return `${node.name} (${node.type})`;
      });
      traceSteps.push(`Level ${idx + 1}: ${levelNodes.join(', ')}`);
    });

    // Get input nodes and their metadata
    const inputNodes = graph.nodes.filter((n: any) => n.type === 'input-file');
    const inputContext = inputNodes.map((n: any) => {
      const meta = n.files?.[0]?.metadata || n.fileMetadata;
      if (meta) {
        return `${n.name}: ${meta.fileName || 'unknown'} (${meta.rowCount || '?'} rows, columns: ${meta.columns?.join(', ') || 'unknown'})`;
      }
      return `${n.name}: file uploaded`;
    }).join('\n');

    // Get compute nodes and their transformations
    const computeNodes = graph.nodes.filter((n: any) => n.type === 'compute');
    const transformations = computeNodes.map((n: any) => {
      const parents = n.in.map((id: string) => graph.nodes.find((p: any) => p.id === id)?.name || 'unknown').join(', ');

      // Extract meaningful code snippet (avoid boilerplate)
      const codeLines = (n.code || '').split('\n').filter((line: string) => {
        const trimmed = line.trim();
        return trimmed &&
               !trimmed.startsWith('#') &&
               !trimmed.startsWith('import') &&
               !trimmed.startsWith('def task') &&
               !trimmed.startsWith('return');
      });

      const codeSnippet = codeLines.slice(0, 2).join(' ').substring(0, 150);
      const inputNames = n.in.map((id: string) => graph.nodes.find((p: any) => p.id === id)?.name || 'unknown');

      return `${n.name}:\n  Inputs: ${parents || 'none'}\n  Logic: ${codeSnippet || 'no code'}${codeSnippet.length >= 150 ? '...' : ''}`;
    }).join('\n\n');

    // Sample the output data if available
    let outputSample = outputData?.substring(0, 800) || 'No output data available';

    // If it's CSV, show first few lines for better structure visibility
    if (outputData && outputData.includes(',') && outputData.includes('\n')) {
      const lines = outputData.split('\n').slice(0, 6);
      outputSample = lines.join('\n');
      if (outputData.split('\n').length > 6) {
        outputSample += '\n... (truncated)';
      }
    }

    const prompt = `You are analyzing the output of an HPC data pipeline. Provide a clear, insightful analysis.

PIPELINE STRUCTURE:
Name: ${graph.name}
Description: ${graph.description}

INPUT DATA:
${inputContext}

DATA FLOW TRACE:
${traceSteps.join('\n')}

TRANSFORMATIONS:
${transformations}

OUTPUT NODE: ${outputNode.name}
OUTPUT SAMPLE (first 500 chars):
${outputSample}

Provide a structured analysis in this format:

**Pipeline Intent**
[1-2 sentences explaining what this pipeline was designed to accomplish]

**Data Flow**
[Trace how data moved through the pipeline from input to output, highlighting key transformations]

**Output Summary**
[Describe what the output contains, key patterns, or notable findings]

**Assessment**
[Does the output align with the pipeline's intent? Any concerns or recommendations?]

Keep each section concise (2-3 sentences max). Use clear, direct language.`;

    const result = await model.generateContent(prompt);
    const analysis = result.response.text();

    return NextResponse.json({
      analysis,
      flowTrace: traceSteps,
      pipelineName: graph.name
    });

  } catch (error) {
    console.error("Error analyzing output:", error);
    return NextResponse.json(
      {
        error: "Failed to analyze output",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
