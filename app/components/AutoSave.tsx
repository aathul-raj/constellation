'use client';

import { useEffect, useRef } from 'react';
import { useHPCStore } from '../store/hpc-store';
import { useSession } from 'next-auth/react';

export default function AutoSave() {
  const { graph, currentProjectId, currentProjectName, setSaveStatus, addNotification } = useHPCStore();
  const { data: session } = useSession();
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedGraphRef = useRef<string | null>(null);

  useEffect(() => {
    // Don't auto-save if not logged in or no current project
    if (!session || !currentProjectId) {
      return;
    }

    const currentGraphString = JSON.stringify(graph);

    // Don't save if nothing changed
    if (currentGraphString === lastSavedGraphRef.current) {
      return;
    }

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set status to idle (user is typing)
    setSaveStatus('idle');

    // Debounce: wait 2 seconds after last change before saving
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving');

      try {
        const response = await fetch(`/api/projects/${currentProjectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: currentProjectName,
            graph,
          }),
        });

        if (response.ok) {
          setSaveStatus('saved');
          lastSavedGraphRef.current = currentGraphString;

          // Reset to idle after 2 seconds
          setTimeout(() => {
            setSaveStatus('idle');
          }, 2000);
        } else {
          const data = await response.json();
          throw new Error(data.error || 'Failed to save');
        }
      } catch (error) {
        console.error('Auto-save error:', error);
        setSaveStatus('error');
        addNotification({
          type: 'error',
          title: 'Auto-save Failed',
          message: error instanceof Error ? error.message : 'Failed to save project',
        });

        // Reset to idle after 3 seconds
        setTimeout(() => {
          setSaveStatus('idle');
        }, 3000);
      }
    }, 2000);

    // Cleanup on unmount
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [graph, currentProjectId, currentProjectName, session, setSaveStatus, addNotification]);

  return null; // This is a logic-only component
}
