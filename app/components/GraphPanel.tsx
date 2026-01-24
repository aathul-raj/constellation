'use client';

import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { GraphCanvas, GraphNode, GraphEdge, GraphCanvasRef, darkTheme } from 'reagraph';
import type { LayoutTypes } from 'reagraph';
import { useHPCStore } from '../store/hpc-store';
import { transformToReagraph, getStatusColor } from '../utils/graph-transform';
import { AddNodeModal } from './AddNodeModal';
import { ConnectionToolbar } from './ConnectionToolbar';

export default function GraphPanel() {
  const { graph, selectedNodeId, selectNode, setGraph } = useHPCStore();
  const graphRef = useRef<GraphCanvasRef>(null);
  const [layoutType, setLayoutType] = useState<LayoutTypes>('forceDirected2d');
  const [is3D, setIs3D] = useState(false);
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isConnectionMode, setIsConnectionMode] = useState(false);
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<string | null>(null);

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

  const canConnect = useCallback((sourceId: string, targetId: string): boolean => {
    const sourceNode = graph.nodes.find(n => n.id === sourceId);
    const targetNode = graph.nodes.find(n => n.id === targetId);

    if (!sourceNode || !targetNode) return false;

    // Input nodes can only be sources
    if (sourceNode.type === 'output-file') return false;

    // Output nodes can only be targets
    if (targetNode.type === 'input-file') return false;

    // Check if connection already exists
    const connectionExists = sourceNode.out.includes(targetId);
    if (connectionExists) return false;

    return true;
  }, [graph.nodes]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (isConnectionMode) {
      // Connection mode: select source and target
      if (!connectionSource) {
        // First click - select source
        const sourceNode = graph.nodes.find(n => n.id === node.id);
        if (sourceNode?.type === 'output-file') {
          // Output nodes can't be sources
          return;
        }
        setConnectionSource(node.id);
      } else if (connectionSource === node.id) {
        // Clicked same node, deselect
        setConnectionSource(null);
      } else if (!connectionTarget) {
        // Second click - select target
        const targetNode = graph.nodes.find(n => n.id === node.id);
        if (targetNode?.type === 'input-file') {
          // Input nodes can't be targets
          return;
        }

        if (canConnect(connectionSource, node.id)) {
          setConnectionTarget(node.id);
        }
      } else {
        // Reset and start over
        const sourceNode = graph.nodes.find(n => n.id === node.id);
        if (sourceNode?.type === 'output-file') {
          return;
        }
        setConnectionSource(node.id);
        setConnectionTarget(null);
      }
    } else {
      // Normal mode: select node
      selectNode(selectedNodeId === node.id ? null : node.id);
    }
  }, [isConnectionMode, connectionSource, connectionTarget, selectNode, selectedNodeId, graph.nodes, canConnect]);

  const handleAddConnection = () => {
    if (!connectionSource || !connectionTarget) return;

    // Update graph with new connection
    setGraph({
      ...graph,
      nodes: graph.nodes.map(node => {
        if (node.id === connectionSource) {
          return {
            ...node,
            out: [...node.out, connectionTarget]
          };
        }
        if (node.id === connectionTarget) {
          return {
            ...node,
            in: [...node.in, connectionSource]
          };
        }
        return node;
      })
    });

    // Reset connection mode
    setConnectionSource(null);
    setConnectionTarget(null);
    setIsConnectionMode(false);
  };

  const handleCancelConnection = () => {
    setConnectionSource(null);
    setConnectionTarget(null);
    setIsConnectionMode(false);
  };

  const toggleConnectionMode = () => {
    const newMode = !isConnectionMode;
    setIsConnectionMode(newMode);
    if (!newMode) {
      setConnectionSource(null);
      setConnectionTarget(null);
    }
  };

  const toggle3D = () => {
    const new3D = !is3D;
    setIs3D(new3D);
    setLayoutType(new3D ? 'forceDirected3d' : 'forceDirected2d');

    setTimeout(() => {
      graphRef.current?.fitNodesInView();
    }, 500);
  };

  const fitView = () => {
    graphRef.current?.fitNodesInView();
  };

  const zoomIn = () => {
    graphRef.current?.zoomIn();
  };

  const zoomOut = () => {
    graphRef.current?.zoomOut();
  };

  useEffect(() => {
    setTimeout(() => {
      graphRef.current?.fitNodesInView();
    }, 1000);
  }, [nodes]);

  // Custom theme with subtle selection ring
  const customTheme = {
    ...darkTheme,
    canvas: {
      ...darkTheme.canvas,
      background: '#0a0a0f',
      fog: '#0a0a0f'
    },
    ring: {
      ...darkTheme.ring,
      fill: '#1a3a4a',
      activeFill: '#2a4a5a',
    },
    edge: {
      ...darkTheme.edge,
      fill: '#3b82f6',
      activeFill: '#60a5fa',
      opacity: 0.8,
      selectedOpacity: 1,
      inactiveOpacity: 0.3,
    },
    arrow: {
      ...darkTheme.arrow,
      fill: '#3b82f6',
      activeFill: '#60a5fa',
    },
  };

  const sourceNodeName = graph.nodes.find(n => n.id === connectionSource)?.name;
  const targetNodeName = graph.nodes.find(n => n.id === connectionTarget)?.name;

  // Determine selections for graph
  const selections = useMemo(() => {
    if (isConnectionMode) {
      const sel = [];
      if (connectionSource) sel.push(connectionSource);
      if (connectionTarget) sel.push(connectionTarget);
      return sel;
    }
    return selectedNodeId ? [selectedNodeId] : [];
  }, [isConnectionMode, connectionSource, connectionTarget, selectedNodeId]);

  return (
    <div className="graph-panel">
      <div className="panel-header">
        <div className="header-left">
          <h2>Pipeline Graph</h2>
          <span className="node-count">{graph.nodes.length} nodes</span>
        </div>
        <div className="header-controls">
          <button
            className={`control-btn ${isConnectionMode ? 'active' : ''}`}
            onClick={toggleConnectionMode}
            title={isConnectionMode ? 'Exit connection mode' : 'Add connections'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>
          <button
            className="control-btn"
            onClick={() => setIsAddNodeOpen(true)}
            title="Add new node"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <div className="control-divider" />
          <button
            className={`control-btn ${is3D ? 'active' : ''}`}
            onClick={toggle3D}
            title={is3D ? 'Switch to 2D' : 'Switch to 3D'}
          >
            {is3D ? '3D' : '2D'}
          </button>
          <div className="control-divider" />
          <button className="control-btn" onClick={zoomIn} title="Zoom in">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button className="control-btn" onClick={zoomOut} title="Zoom out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button className="control-btn" onClick={fitView} title="Fit to view">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>

      <div className="graph-container">
        <GraphCanvas
          ref={graphRef}
          nodes={graphNodes}
          edges={graphEdges}
          onNodeClick={handleNodeClick}
          selections={selections}
          layoutType={layoutType}
          labelType="all"
          theme={customTheme}
          cameraMode={is3D ? 'rotate' : 'pan'}
        >
          {is3D && (
            <>
              <ambientLight intensity={0.4} />
              <directionalLight position={[10, 10, 5]} intensity={1.2} color="#ffffff" />
              <directionalLight position={[-10, -5, -5]} intensity={0.6} color="#4a9eff" />
              <directionalLight position={[0, -10, 5]} intensity={0.4} color="#ff6b4a" />
            </>
          )}
        </GraphCanvas>

        <ConnectionToolbar
          sourceNode={connectionSource}
          targetNode={connectionTarget}
          sourceNodeName={sourceNodeName}
          targetNodeName={targetNodeName}
          onAddConnection={handleAddConnection}
          onCancel={handleCancelConnection}
        />
      </div>

      <div className="graph-legend">
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#6b7280' }} />
          <span>Queued</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#3b82f6' }} />
          <span>Running</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#22c55e' }} />
          <span>Completed</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: '#ef4444' }} />
          <span>Failed</span>
        </div>
      </div>

      <AddNodeModal
        isOpen={isAddNodeOpen}
        onClose={() => setIsAddNodeOpen(false)}
        parentNodeId={selectedNodeId}
      />
    </div>
  );
}
