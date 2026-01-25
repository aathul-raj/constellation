'use client';

import { useEffect } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';

export default function NotificationCenter() {
  const { notifications, removeNotification } = useHPCStore();

  useEffect(() => {
    if (notifications.length === 0) return;

    const lastNotification = notifications[notifications.length - 1];
    // Show error notifications longer (10s) to give users time to read them
    const timeout = lastNotification.type === 'error' ? 10000 : 4000;
    const timer = setTimeout(() => {
      removeNotification(lastNotification.id);
    }, timeout);

    return () => clearTimeout(timer);
  }, [notifications, removeNotification]);

  const getIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <CheckCircle size={18} />;
      case 'error':
        return <AlertCircle size={18} />;
      case 'info':
        return <Info size={18} />;
      default:
        return <Info size={18} />;
    }
  };

  return (
    <div className="notification-center">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`notification notification-${notification.type}`}
        >
          <div className="notification-icon">
            {getIcon(notification.type)}
          </div>
          <div className="notification-content">
            <div className="notification-title">{notification.title}</div>
            {notification.message && (
              <div className="notification-message">{notification.message}</div>
            )}
          </div>
          <button
            className="notification-close"
            onClick={() => removeNotification(notification.id)}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
