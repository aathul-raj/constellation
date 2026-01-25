'use client';

import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { GraphCanvas, GraphNode, GraphEdge, GraphCanvasRef, darkTheme } from 'reagraph';
import type { LayoutTypes } from 'reagraph';
import { useHPCStore } from '../store/hpc-store';
import { transformToReagraph, getStatusColor } from '../utils/graph-transform';
import { AddNodeModal } from './AddNodeModal';
import { ConnectionToolbar } from './ConnectionToolbar';
import { DeleteEdgeToolbar } from './DeleteEdgeToolbar';

export default function GraphPanel() {
  const { graph, selectedNodeId, selectNode, setGraph } = useHPCStore();
  const graphRef = useRef<GraphCanvasRef>(null);
  const [layoutType, setLayoutType] = useState<LayoutTypes>('forceDirected2d');
  const [is3D, setIs3D] = useState(false);
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isConnectionMode, setIsConnectionMode] = useState(false);
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<string | null>(null);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<{ source: string; target: string } | null>(null);

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

    // Output nodes can only have 1 incoming connection
    if (targetNode.type === 'output-file' && targetNode.in.length >= 1) return false;

    // Check if connection already exists
    const connectionExists = sourceNode.out.includes(targetId);
    if (connectionExists) return false;

    return true;
  }, [graph.nodes]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    // Ignore node clicks in delete mode
    if (isDeleteMode) return;

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
  }, [isConnectionMode, connectionSource, connectionTarget, selectNode, selectedNodeId, graph.nodes, canConnect, isDeleteMode]);

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
    // Exit delete mode when entering connection mode
    if (newMode && isDeleteMode) {
      setIsDeleteMode(false);
      setSelectedEdge(null);
    }
  };

  const toggleDeleteMode = () => {
    const newMode = !isDeleteMode;
    setIsDeleteMode(newMode);
    if (!newMode) {
      setSelectedEdge(null);
    }
    // Exit connection mode when entering delete mode
    if (newMode && isConnectionMode) {
      setIsConnectionMode(false);
      setConnectionSource(null);
      setConnectionTarget(null);
    }
  };

  const handleEdgeClick = useCallback((edge: GraphEdge) => {
    if (isDeleteMode) {
      setSelectedEdge({ source: edge.source, target: edge.target });
    }
  }, [isDeleteMode]);

  const handleDeleteEdge = () => {
    if (!selectedEdge) return;

    const targetNode = graph.nodes.find(n => n.id === selectedEdge.target);

    // Check if deleting this edge would leave a non-input node with no incoming connections
    const willBeOrphaned = targetNode &&
                          targetNode.type !== 'input-file' &&
                          targetNode.in.length === 1 &&
                          targetNode.in[0] === selectedEdge.source;

    if (willBeOrphaned) {
      const confirmed = window.confirm(
        `Deleting this connection will leave "${targetNode.name}" with no incoming connections. The node will be deleted. Continue?`
      );
      if (!confirmed) {
        setSelectedEdge(null);
        return;
      }
    }

    // Remove the edge and potentially the orphaned node
    setGraph({
      ...graph,
      nodes: graph.nodes
        .filter(node => {
          // Remove orphaned node
          if (willBeOrphaned && node.id === selectedEdge.target) {
            return false;
          }
          return true;
        })
        .map(node => {
          // Remove outgoing connection from source
          if (node.id === selectedEdge.source) {
            return {
              ...node,
              out: node.out.filter(id => id !== selectedEdge.target)
            };
          }
          // Remove incoming connection from target
          if (node.id === selectedEdge.target) {
            return {
              ...node,
              in: node.in.filter(id => id !== selectedEdge.source)
            };
          }
          // Remove any connections TO the deleted node
          if (willBeOrphaned) {
            return {
              ...node,
              out: node.out.filter(id => id !== selectedEdge.target)
            };
          }
          return node;
        })
    });

    setSelectedEdge(null);
    setIsDeleteMode(false);
  };

  const handleCancelDelete = () => {
    setSelectedEdge(null);
    setIsDeleteMode(false);
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

  const customTheme = {
    ...darkTheme,
    canvas: {
      ...darkTheme.canvas,
      background: '#0a0a0f',
      fog: '#0a0a0f'
    },
    ring: {
      ...darkTheme.ring,
      fill: 'rgba(0, 0, 0, 0)',
      activeFill: '#3b82f6',
    },
    edge: {
      ...darkTheme.edge,
      fill: '#3b82f6',
      activeFill: '#60a5fa',
      opacity: 0.8,
      selectedOpacity: 1,
      inactiveOpacity: 0.8,
    },
    arrow: {
      ...darkTheme.arrow,
      fill: '#3b82f6',
      activeFill: '#60a5fa',
    },
    node: {
      ...darkTheme.node,
      fill: '#1f2937',
      activeFill: '#3b82f6',
      opacity: 0.9,
      selectedOpacity: 1,
      inactiveOpacity: 0.9,
      label: {
        color: '#475569',
        // stroke: '#fff',
        activeColor: '#3b82f6'
      }
    }};

  const sourceNodeName = graph.nodes.find(n => n.id === connectionSource)?.name;
  const targetNodeName = graph.nodes.find(n => n.id === connectionTarget)?.name;

  const selectedEdgeSourceName = selectedEdge ? graph.nodes.find(n => n.id === selectedEdge.source)?.name : undefined;
  const selectedEdgeTargetName = selectedEdge ? graph.nodes.find(n => n.id === selectedEdge.target)?.name : undefined;

  // Determine selections for graph
  const selections = useMemo(() => {
    if (isConnectionMode) {
      const sel = [];
      if (connectionSource) sel.push(connectionSource);
      if (connectionTarget) sel.push(connectionTarget);
      return sel;
    }
    if (isDeleteMode && selectedEdge) {
      return [selectedEdge.source, selectedEdge.target];
    }
    return selectedNodeId ? [selectedNodeId] : [];
  }, [isConnectionMode, connectionSource, connectionTarget, selectedNodeId, isDeleteMode, selectedEdge]);

  const renderCustomNode = useCallback(({ size, color, opacity, active }: any) => (
    <group>
      <mesh>
        <sphereGeometry attach="geometry" args={[size, 32, 32]} />
        <meshStandardMaterial attach="material" color={active ? '#ffffff' : color} opacity={opacity} transparent />
      </mesh>
    </group>
  ), []);

  return (
    <div className="graph-panel">
      <div className="graph-panel-header">
        <div className="header-left">
          <h2>Pipeline Graph</h2>
          <span className="node-count">{graph.nodes.length} nodes</span>
        </div>
        <div className="header-controls">
          <button
            className="control-btn"
            onClick={() => setIsAddNodeOpen(true)}
            title="Add new node"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
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
            className={`control-btn ${isDeleteMode ? 'active' : ''}`}
            onClick={toggleDeleteMode}
            title={isDeleteMode ? 'Exit delete mode' : 'Delete connections'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
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
          onEdgeClick={handleEdgeClick}
          selections={selections}
          actives={selections}
          layoutType={layoutType}
          labelType="all"
          theme={customTheme}
          cameraMode={is3D ? 'rotate' : 'pan'}
          renderNode={renderCustomNode}
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

        <DeleteEdgeToolbar
          sourceNode={selectedEdgeSourceName}
          targetNode={selectedEdgeTargetName}
          onDelete={handleDeleteEdge}
          onCancel={handleCancelDelete}
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
