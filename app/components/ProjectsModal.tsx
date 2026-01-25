'use client';

import { useEffect, useState } from 'react';
import { X, Plus, Save, Trash2, FolderOpen } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import styles from './ProjectsModal.module.css';

interface Project {
  id: string;
  name: string;
  graph: any;
  updatedAt: number;
  createdAt: number;
}

interface ProjectsModalProps {
  onClose: () => void;
}

export default function ProjectsModal({ onClose }: ProjectsModalProps) {
  const { graph, setGraph, addNotification, currentProjectId, currentProjectName, setCurrentProject } = useHPCStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [projectName, setProjectName] = useState(currentProjectName || graph.name);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      const data = await response.json();
      setProjects(data.projects || []);
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Load Failed',
        message: 'Failed to load projects',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveNew = async () => {
    if (!projectName.trim()) {
      addNotification({
        type: 'error',
        title: 'Invalid Name',
        message: 'Please enter a project name',
      });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName,
          graph,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setCurrentProject(data.id, projectName);
        addNotification({
          type: 'success',
          title: 'Project Saved',
          message: `${projectName} saved successfully`,
        });
        await loadProjects();
      } else {
        throw new Error(data.error);
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: error instanceof Error ? error.message : 'Failed to save project',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!currentProjectId) {
      handleSaveNew();
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${currentProjectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName,
          graph,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        addNotification({
          type: 'success',
          title: 'Project Updated',
          message: `${projectName} updated successfully`,
        });
        await loadProjects();
      } else {
        throw new Error(data.error);
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: error instanceof Error ? error.message : 'Failed to update project',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (project: Project) => {
    setGraph(project.graph);
    setProjectName(project.name);
    setCurrentProject(project.id, project.name);
    addNotification({
      type: 'success',
      title: 'Project Loaded',
      message: `${project.name} loaded successfully`,
    });
    onClose();
  };

  const handleDelete = async (projectId: string, projectName: string) => {
    if (!confirm(`Delete "${projectName}"? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        addNotification({
          type: 'success',
          title: 'Project Deleted',
          message: `${projectName} deleted successfully`,
        });
        if (currentProjectId === projectId) {
          setCurrentProject(null, null);
        }
        await loadProjects();
      } else {
        const data = await response.json();
        throw new Error(data.error);
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: error instanceof Error ? error.message : 'Failed to delete project',
      });
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2>Projects</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.saveSection}>
            <h3>Current Project</h3>
            <div className={styles.saveForm}>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name"
                className={styles.projectNameInput}
              />
              <div className={styles.saveButtons}>
                <button
                  className={styles.btnPrimary}
                  onClick={handleUpdate}
                  disabled={saving}
                >
                  <Save size={16} />
                  <span>{currentProjectId ? 'Update' : 'Save New'}</span>
                </button>
                {currentProjectId && (
                  <button
                    className={styles.btnSecondary}
                    onClick={() => {
                      setCurrentProject(null, null);
                      setProjectName('Untitled Project');
                    }}
                  >
                    <Plus size={16} />
                    <span>Save as New</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className={styles.projectsList}>
            <h3>Saved Projects</h3>
            {loading ? (
              <div className={styles.loadingState}>
                <div className={styles.loadingSpinner} />
                <span>Loading projects...</span>
              </div>
            ) : projects.length === 0 ? (
              <div className={styles.emptyState}>
                <FolderOpen size={48} />
                <p>No saved projects yet</p>
                <p className={styles.emptyHint}>Save your current work to get started</p>
              </div>
            ) : (
              <div className={styles.projectsGrid}>
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className={`${styles.projectCard} ${currentProjectId === project.id ? styles.active : ''}`}
                  >
                    <div className={styles.projectInfo} onClick={() => handleLoad(project)}>
                      <h4>{project.name}</h4>
                      <p className={styles.projectMeta}>
                        {project.graph.nodes.length} nodes • Updated {formatDate(project.updatedAt)}
                      </p>
                    </div>
                    <button
                      className={styles.deleteBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(project.id, project.name);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
