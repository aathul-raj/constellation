'use client';

import { useRef, useState, useMemo, useEffect } from 'react';
import { GraphCanvas, GraphCanvasRef, GraphEdge, GraphNode, darkTheme } from 'reagraph';
import type { LayoutTypes } from 'reagraph';
import type { ClusterViewProps } from '@/lib/types';
import { STATUS_COLORS } from '@/lib/constants';
import { PaneHeader } from '@/components/layout/PaneHeader';
import styles from './ClusterGraphView.module.css';

export function ClusterGraphView({ nodes, selectedNodeId, onSelectNode }: ClusterViewProps) {
  const graphRef = useRef<GraphCanvasRef>(null);
  const [layoutType, setLayoutType] = useState<LayoutTypes>('forceDirected2d');
  const [is3D, setIs3D] = useState(false);

  const graphNodes: GraphNode[] = useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        label: node.label,
        fill: STATUS_COLORS[node.status],
        size: selectedNodeId === node.id ? 15 : 10,
      })),
    [nodes, selectedNodeId]
  );

  const customTheme = {
    ...darkTheme,
    canvas: {
      background: 'transparent',
      fog: '#0a0a0f',
    },
    node: {
      ...darkTheme.node,
      label: {
        ...darkTheme.node.label,
        color: '#e4e4e7',
        stroke: '#0a0a0f',
      },
    },
  };

  const graphEdges: GraphEdge[] = useMemo(() => {
    const edges: GraphEdge[] = [];
    const edgeMap = new Map();

    nodes.forEach((node, index) => {
      if (node.type === 'simulation') {
        const storageNodes = nodes.filter((n) => n.type === 'storage');
        storageNodes.forEach((storage) => {
          const edgeId = `${storage.id}-${node.id}`;
          if (!edgeMap.has(edgeId)) {
            edges.push({
              id: edgeId,
              source: storage.id,
              target: node.id,
            });
            edgeMap.set(edgeId, true);
          }
        });
      }

      if (node.type === 'gpu') {
        const computeNodes = nodes.filter((n) => n.type === 'compute' || n.type === 'simulation');
        computeNodes.forEach((compute) => {
          const edgeId = `${node.id}-${compute.id}`;
          if (!edgeMap.has(edgeId)) {
            edges.push({
              id: edgeId,
              source: node.id,
              target: compute.id,
            });
            edgeMap.set(edgeId, true);
          }
        });
      }

      if (node.type === 'network') {
        nodes.forEach((targetNode) => {
          if (targetNode.id !== node.id && targetNode.type !== 'network') {
            const edgeId = `${node.id}-${targetNode.id}`;
            if (!edgeMap.has(edgeId)) {
              edges.push({
                id: edgeId,
                source: node.id,
                target: targetNode.id,
              });
              edgeMap.set(edgeId, true);
            }
          }
        });
      }
    });

    return edges;
  }, [nodes]);

  const toggle3D = () => {
    const new3D = !is3D;
    setIs3D(new3D);
    setLayoutType(new3D ? 'forceDirected3d' : 'forceDirected2d');

    setTimeout(() => {
      graphRef.current?.fitNodesInView();
    }, 100);
  };

  useEffect(() => {
    setTimeout(() => {
      graphRef.current?.fitNodesInView();
    }, 500);
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <div className={styles.container}>
      <PaneHeader
        title="Cluster Graph"
        subtitle={selectedNode?.label || `${nodes.length} nodes`}
        actions={
          <div className={styles.controls}>
            <button
              className={`${styles.controlBtn} ${is3D ? styles.active : ''}`}
              onClick={toggle3D}
              title={is3D ? 'Switch to 2D' : 'Switch to 3D'}
            >
              {is3D ? '3D' : '2D'}
            </button>
            <button
              className={styles.controlBtn}
              onClick={() => graphRef.current?.fitNodesInView()}
              title="Fit to view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            </button>
          </div>
        }
      />

      <div className={styles.graphContainer}>
        <GraphCanvas
          ref={graphRef}
          nodes={graphNodes}
          edges={graphEdges}
          layoutType={layoutType}
          labelType="all"
          theme={customTheme}
          cameraMode={is3D ? 'rotate' : 'pan'}
          onNodeClick={(node) => {
            onSelectNode(selectedNodeId === node.id ? null : node.id);
          }}
          layoutOverrides={{
            linkDistance: 150,
            nodeStrength: -500,
            centerInertia: 0.1,
          }}
          edgeArrowPosition="end"
          edgeLabelPosition="natural"
          sizingType="centrality"
          clusterAttribute="status"
        />
      </div>

      {/* Node list at bottom */}
      <div className={styles.nodeList}>
        {nodes.map((node) => (
          <button
            key={node.id}
            className={`${styles.nodeItem} ${selectedNodeId === node.id ? styles.selected : ''}`}
            onClick={() => onSelectNode(selectedNodeId === node.id ? null : node.id)}
          >
            <span
              className={styles.statusDot}
              style={{ backgroundColor: STATUS_COLORS[node.status] }}
            />
            <div className={styles.nodeInfo}>
              <span className={styles.nodeLabel}>{node.label}</span>
              <span className={styles.nodeType}>{node.type}</span>
            </div>
            {node.metrics?.cpu !== undefined && (
              <span className={styles.metric}>{node.metrics.cpu}%</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
