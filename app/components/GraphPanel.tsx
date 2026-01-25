'use client';

import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { GraphCanvas, GraphNode, GraphEdge, GraphCanvasRef, darkTheme } from 'reagraph';
import type { LayoutTypes } from 'reagraph';
import { Info, Trash2 } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { transformToReagraph, getStatusColor } from '../utils/graph-transform';
import { AddNodeModal } from './AddNodeModal';
import { ConnectionToolbar } from './ConnectionToolbar';
import { DeleteEdgeToolbar } from './DeleteEdgeToolbar';
import { ConfirmationModal } from './ConfirmationModal';

// Animated node component for smooth hover effects
const AnimatedNode = ({ size, color, opacity, active }: any) => {
  const meshRef = useRef<any>(null);

  useEffect(() => {
    let animationFrameId: number;
    // Scale up when active
    const targetScale = active ? 1.1 : 1;

    const animate = () => {
      if (meshRef.current) {
        const currentScale = meshRef.current.scale.x;
        // Smooth lerp (0.1 = fast, 0.05 = slower)
        const newScale = currentScale + (targetScale - currentScale) * 0.04;

        if (Math.abs(targetScale - newScale) > 0.001) {
          meshRef.current.scale.setScalar(newScale);
          animationFrameId = requestAnimationFrame(animate);
        } else {
          meshRef.current.scale.setScalar(targetScale);
        }
      }
    };

    animate();
    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [active]);

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry attach="geometry" args={[size, 32, 32]} />
        <meshBasicMaterial attach="material" color={active ? '#3b82f6' : color} opacity={opacity} transparent />
      </mesh>
    </group>
  );
};

// Custom node renderer
const renderCustomNode = (props: any) => <AnimatedNode {...props} />;

export default function GraphPanel() {
  const { graph, selectedNodeId, selectNode, setGraph, theme, clearStore } = useHPCStore();
  const graphRef = useRef<GraphCanvasRef>(null);
  const [is3D, setIs3D] = useState(false);
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isConnectionMode, setIsConnectionMode] = useState(false);
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<string | null>(null);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<{ source: string; target: string } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    type: 'edge' | 'node' | 'all';
    message: string;
    onConfirm: () => void;
    onEdgeOnly?: () => void;
  } | null>(null);
  const [isHoveringNode, setIsHoveringNode] = useState(false);
  const graphContainerRef = useRef<HTMLDivElement>(null);

  const { nodes, edges } = useMemo(() => transformToReagraph(graph), [graph]);

  const layoutType: LayoutTypes = useMemo(() => {
    if (!graph.nodes.length) {
      return is3D ? 'forceDirected3d' : 'forceDirected2d';
    }

    const rootCount = graph.nodes.filter(node => node.in.length === 0).length;

    if (rootCount === 1) {
      return 'hierarchicalTd';
    }

    return is3D ? 'forceDirected3d' : 'forceDirected2d';
  }, [graph.nodes, is3D]);

  const graphNodes: GraphNode[] = useMemo(() =>
    nodes.map((node) => ({
      id: node.id,
      label: node.label,
      fill: getStatusColor(node.data?.status || 'queued'),
      data: node.data
    })),
    [nodes, is3D, theme]
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

  const handleClearAll = () => {
    setDeleteConfirmation({
      type: 'all',
      message: 'Are you sure you want to delete EVERYTHING? This will remove all nodes, edges, and associated input files. This action cannot be undone.',
      onConfirm: () => {
        setGraph({ ...graph, nodes: [] });
        selectNode(null);
        setDeleteConfirmation(null);
        setIsDeleteMode(false);
      }
    });
  };

  const handleNodeClick = useCallback((node: GraphNode) => {
    // Delete mode: prompt to delete node
    if (isDeleteMode) {
      const nodeToDelete = graph.nodes.find(n => n.id === node.id);
      if (!nodeToDelete) return;

      setDeleteConfirmation({
        type: 'node',
        message: `Delete "${nodeToDelete.name}"?`,
        onConfirm: () => {
          // Remove node and all connections to it
          setGraph({
            ...graph,
            nodes: graph.nodes
              .filter(n => n.id !== node.id)
              .map(n => ({
                ...n,
                in: n.in.filter(id => id !== node.id),
                out: n.out.filter(id => id !== node.id)
              }))
          });
          setDeleteConfirmation(null);
          setIsDeleteMode(false);
        }
      });
      return;
    }

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
  }, [isConnectionMode, connectionSource, connectionTarget, selectNode, selectedNodeId, graph.nodes, canConnect, isDeleteMode, graph]);

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

  const handleNodePointerOver = useCallback(() => {
    setIsHoveringNode(true);
  }, []);

  const handleNodePointerOut = useCallback(() => {
    setIsHoveringNode(false);
  }, []);

  const handleDeleteEdge = () => {
    if (!selectedEdge) return;

    const targetNode = graph.nodes.find(n => n.id === selectedEdge.target);

    // Check if deleting this edge would leave a non-input node with no incoming connections
    const willBeOrphaned = targetNode &&
                          targetNode.type !== 'input-file' &&
                          targetNode.in.length === 1 &&
                          targetNode.in[0] === selectedEdge.source;

    if (willBeOrphaned) {
      // Ask if user wants to delete the orphaned node too
      setDeleteConfirmation({
        type: 'edge',
        message: `Deleting this connection will leave "${targetNode.name}" with no incoming connections.`,
        onConfirm: () => {
          // Delete edge AND node
          setGraph({
            ...graph,
            nodes: graph.nodes
              .filter(node => node.id !== selectedEdge.target)
              .map(node => {
                if (node.id === selectedEdge.source) {
                  return {
                    ...node,
                    out: node.out.filter(id => id !== selectedEdge.target)
                  };
                }
                return {
                  ...node,
                  out: node.out.filter(id => id !== selectedEdge.target)
                };
              })
          });
          setDeleteConfirmation(null);
          setSelectedEdge(null);
          setIsDeleteMode(false);
        },
        onEdgeOnly: () => {
          // Delete edge only, keep stranded node
          setGraph({
            ...graph,
            nodes: graph.nodes.map(node => {
              if (node.id === selectedEdge.source) {
                return {
                  ...node,
                  out: node.out.filter(id => id !== selectedEdge.target)
                };
              }
              if (node.id === selectedEdge.target) {
                return {
                  ...node,
                  in: node.in.filter(id => id !== selectedEdge.source)
                };
              }
              return node;
            })
          });
          setDeleteConfirmation(null);
          setSelectedEdge(null);
          setIsDeleteMode(false);
        }
      });
    } else {
      // Just delete the edge
      setGraph({
        ...graph,
        nodes: graph.nodes.map(node => {
          if (node.id === selectedEdge.source) {
            return {
              ...node,
              out: node.out.filter(id => id !== selectedEdge.target)
            };
          }
          if (node.id === selectedEdge.target) {
            return {
              ...node,
              in: node.in.filter(id => id !== selectedEdge.source)
            };
          }
          return node;
        })
      });
      setSelectedEdge(null);
      setIsDeleteMode(false);
    }
  };

  const handleCancelDelete = () => {
    setSelectedEdge(null);
    setIsDeleteMode(false);
  };

  const toggle3D = () => {
    const new3D = !is3D;
    setIs3D(new3D);
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
    // Only fit nodes in view if there are actually nodes to display
    // This prevents the camera from getting stuck when transitioning from empty to populated graph
    if (nodes && nodes.length > 0) {
      setTimeout(() => {
        graphRef.current?.fitNodesInView();
      }, 100);
    }
  }, [nodes]);

  useEffect(() => {
    if (is3D && graphRef.current) {
      // Set unbounded rotation for 3D camera
      const controls = (graphRef.current as any).getControls?.();
      if (controls) {
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI;
        controls.minAzimuthAngle = -Infinity;
        controls.maxAzimuthAngle = Infinity;
        controls.autoRotate = false;
      }
    }
  }, [is3D]);

  const customTheme = useMemo(() => {
    const isDark = theme === 'dark';

    return {
      ...darkTheme,
      canvas: {
        ...darkTheme.canvas,
        background: isDark ? '#0a0a0f' : '#fafafa',
        fog: isDark ? '#0a0a0f' : '#fafafa'
      },
      // ring: {
      //   ...darkTheme.ring,
      //   fill: 'rgba(0, 0, 0, 0)',
      //   activeFill: 'rgba(0, 0, 0, 0)',
      // },
      edge: { // controls the arrow line
        ...darkTheme.edge,
        fill: '#3b82f6',
        activeFill: isConnectionMode ? '#3b82f6' : '#60a5fa',
        opacity: 0.8,
        selectedOpacity: 1,
        inactiveOpacity: 0.35,
        size: 6,
        strokeWidth: 6,
      },
      arrow: {
        ...darkTheme.arrow,
        fill: '#3b82f6',
        activeFill: isConnectionMode ? '#3b82f6' : '#60a5fa',
        opacity: 0.35,
        selectedOpacity: 1,
      },
      node: {
        fill: isDark ? '#a1a1aa' : '#52525b',
        activeFill: '#3b82f6',
        opacity: 0.9,
        selectedOpacity: 1,
        inactiveOpacity: 0.6,
        label: {
          color: isDark ? '#a1a1aa' : '#52525b',
          stroke: isDark ? '#0a0a0f' : '#fafafa',
          activeColor: '#3b82f6',
        },
      }
    };
  }, [isConnectionMode, theme]);

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

      <div
        className={`graph-container ${isDeleteMode ? 'delete-mode' : ''} ${isHoveringNode ? 'hover-node' : ''}`}
        ref={graphContainerRef}
      >
        {graph.nodes.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              zIndex: 10
            }}
          >
            <div
              style={{
                maxWidth: '420px',
                textAlign: 'center',
                padding: '20px 24px',
                borderRadius: '12px',
                background: 'rgba(15, 23, 42, 0.6)',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                color: '#e2e8f0',
                backdropFilter: 'blur(6px)'
              }}
            >
              <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '6px' }}>Ready to compute</div>
              <div style={{ fontSize: '14px', color: '#cbd5f5' }}>
                Start by adding a new input node, then connect steps to build your workflow.
              </div>
            </div>
          </div>
        )}
        <GraphCanvas
          ref={graphRef}
          nodes={graphNodes}
          edges={graphEdges}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          onNodePointerOver={handleNodePointerOver}
          onNodePointerOut={handleNodePointerOut}
          selections={selections}
          actives={selections}
          layoutType={layoutType}
          layoutOverrides={{
            nodeSeparation: 0.6,
            nodeSize: [80, 80],
          }}
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

        {isConnectionMode && !connectionSource && (
          <div className="mode-overlay">
            <Info size={16} className="text-blue-400" />
            <span>Select source and target nodes to connect. Output nodes cannot be sources.</span>
          </div>
        )}

        {isDeleteMode && !selectedEdge && (
          <div style={{ position: 'absolute', top: '20px', left: '20px', right: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 50, gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: '8px', border: '1px solid rgba(248,113,113,0.3)', backdropFilter: 'blur(4px)' }}>
              <Info size={16} style={{ color: '#ef5350' }} />
              <span style={{ fontSize: '14px', color: '#f5f5f5' }}>Select an edge or node to delete</span>
            </div>
            
            <button
              onClick={handleClearAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '24px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
                boxShadow: '0 2px 8px rgba(239,68,68,0.3)',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              <Trash2 size={16} />
              Clear All
            </button>
          </div>
        )}

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

      {/* <div className="graph-legend">
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
      </div> */}

      <AddNodeModal
        isOpen={isAddNodeOpen}
        onClose={() => setIsAddNodeOpen(false)}
        parentNodeId={selectedNodeId}
      />

      {deleteConfirmation && (
        <ConfirmationModal
          message={deleteConfirmation.message}
          type={deleteConfirmation.type}
          onConfirm={deleteConfirmation.onConfirm}
          onCancel={() => setDeleteConfirmation(null)}
          onEdgeOnly={deleteConfirmation.onEdgeOnly}
        />
      )}
    </div>
  );
}
