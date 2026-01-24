'use client';

import { useMemo, useCallback } from 'react';
import { GraphCanvas, GraphNode, GraphEdge, darkTheme, lightTheme } from 'reagraph';
import { useHPCStore } from '../store/hpc-store';
import { transformToReagraph, getStatusColor } from '../utils/graph-transform';

export default function GraphPanel() {
  const { graph, selectedNodeId, selectNode, theme } = useHPCStore();

  const { nodes, edges } = useMemo(() => transformToReagraph(graph), [graph]);

  const graphNodes: GraphNode[] = useMemo(() =>
    nodes.map((node) => ({
      id: node.id,
      label: node.label,
      fill: getStatusColor(node.data?.status || 'queued'),
      data: node.data
    })),
    [nodes]
  );

  const graphEdges: GraphEdge[] = useMemo(() =>
    edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target
    })),
    [edges]
  );

  const handleNodeClick = useCallback((node: GraphNode) => {
    selectNode(node.id);
  }, [selectNode]);

  const graphTheme = theme === 'dark' ? darkTheme : lightTheme;

  return (
    <div className="graph-panel">
      <div className="panel-header">
        <h2>Pipeline Graph</h2>
        <span className="node-count">{graph.nodes.length} nodes</span>
      </div>
      <div className="graph-container">
        <GraphCanvas
          nodes={graphNodes}
          edges={graphEdges}
          onNodeClick={handleNodeClick}
          selections={selectedNodeId ? [selectedNodeId] : []}
          layoutType="hierarchicalLr"
          labelType="all"
          theme={graphTheme}
          edgeArrowPosition="end"
          animated={false}
        />
      </div>
      <div className="graph-legend">
        <div className="legend-item">
          <span className="legend-dot queued"></span>
          <span>Queued</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot running"></span>
          <span>Running</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot completed"></span>
          <span>Completed</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot failed"></span>
          <span>Failed</span>
        </div>
      </div>
    </div>
  );
}
