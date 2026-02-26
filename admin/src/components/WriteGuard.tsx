/**
 * WriteGuard — renders children only when the user is authenticated.
 * With Xano auth, "authenticated" simply means the correct password was entered.
 */

import React from 'react';
import { useAuth } from '../auth/AuthContext';

interface Props {
  children: React.ReactNode;
}

export default function WriteGuard({ children }: Props) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="access-denied">
        <div className="access-icon"><i className="ph ph-lock"></i></div>
        <h3>Not signed in</h3>
        <p>Enter the editor password to edit content.</p>
      </div>
    );
  }

  return <>{children}</>;
}
