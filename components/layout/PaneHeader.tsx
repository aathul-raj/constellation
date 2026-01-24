'use client';

import React, { ReactNode } from 'react';
import styles from './PaneHeader.module.css';

interface PaneHeaderProps {
  title: string;
  subtitle?: string | ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PaneHeader({ 
  title, 
  subtitle, 
  actions, 
  className = '' 
}: PaneHeaderProps) {
  return (
    <div className={`${styles.header} ${className}`}>
      <div className={styles.leftSection}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle && (
          <span className={styles.subtitle}>
            {subtitle}
          </span>
        )}
      </div>
      
      {actions && (
        <div className={styles.actions}>
          {actions}
        </div>
      )}
    </div>
  );
}