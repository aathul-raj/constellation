'use client';

import { useEffect, useState } from 'react';
import { X, Plus, Trash2, FolderOpen } from 'lucide-react';
import { useHPCStore, initialGraph } from '../store/hpc-store';
import { ConfirmationModal } from './ConfirmationModal';
import styles from './ProjectsModal.module.css';

interface Project {
  id: string;
  name: string;
  graph: any;
  chatMessages?: any[];
  updatedAt: number;
  createdAt: number;
}

interface ProjectsModalProps {
  onClose: () => void;
}

export default function ProjectsModal({ onClose }: ProjectsModalProps) {
  const { setGraph, setChatMessages, addNotification, currentProjectId, setCurrentProject } = useHPCStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    projectId: string;
    projectName: string;
  } | null>(null);

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

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newProjectName.trim()) {
      return;
    }

    setCreating(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProjectName.trim(),
          graph: initialGraph,
          chatMessages: [],
        }),
      });

      const data = await response.json();

      if (response.ok) {
        // Load the new project
        setGraph(initialGraph);
        setChatMessages([]);
        setCurrentProject(data.id, newProjectName.trim());

        addNotification({
          type: 'success',
          title: 'Project Created',
          message: `${newProjectName} created successfully`,
        });

        setNewProjectName('');
        setShowCreateForm(false);
        await loadProjects();
        onClose();
      } else {
        throw new Error(data.error);
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Create Failed',
        message: error instanceof Error ? error.message : 'Failed to create project',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleLoad = async (project: Project) => {
    setGraph(project.graph);
    setCurrentProject(project.id, project.name);

    // Load chat messages if they exist, otherwise clear them
    if (project.chatMessages) {
      // Convert timestamp strings back to Date objects
      const messagesWithDates = project.chatMessages.map((msg: any) => ({
        ...msg,
        timestamp: typeof msg.timestamp === 'string' ? new Date(msg.timestamp) : msg.timestamp,
      }));
      setChatMessages(messagesWithDates);
    } else {
      setChatMessages([]);
    }

    addNotification({
      type: 'success',
      title: 'Project Loaded',
      message: `${project.name} loaded successfully`,
    });
    onClose();
  };

  const handleDeleteClick = (projectId: string, projectName: string) => {
    setDeleteConfirmation({ projectId, projectName });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmation) return;

    const { projectId, projectName } = deleteConfirmation;
    setDeleteConfirmation(null);

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
          setChatMessages([]);
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
          <div className={styles.projectsList}>
            <div className={styles.projectsListHeader}>
              <h3>Your Projects</h3>
              {!showCreateForm ? (
                <button
                  className={styles.btnPrimary}
                  onClick={() => setShowCreateForm(true)}
                  disabled={creating}
                >
                  <Plus size={16} />
                  <span>New Project</span>
                </button>
              ) : (
                <form onSubmit={handleCreateNew} className={styles.createForm}>
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="Project name..."
                    className={styles.projectInput}
                    autoFocus
                    disabled={creating}
                  />
                  <button
                    type="submit"
                    className={styles.btnCreate}
                    disabled={creating || !newProjectName.trim()}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                  <button
                    type="button"
                    className={styles.btnCancel}
                    onClick={() => {
                      setShowCreateForm(false);
                      setNewProjectName('');
                    }}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
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
                        handleDeleteClick(project.id, project.name);
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

      {deleteConfirmation && (
        <ConfirmationModal
          type="edge"
          message={`Delete project "${deleteConfirmation.projectName}"? This cannot be undone.`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirmation(null)}
        />
      )}
    </div>
  );
}
