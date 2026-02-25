/**
 * WriteGuard — checks Matrix room power levels before rendering an editor.
 *
 * Shows a clear access-denied message if the logged-in user doesn't have
 * the power level required to send eo.op events in the room.
 *
 * This is a UX convenience only — the Matrix server enforces power levels
 * server-side regardless of what the client does.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { resolveAlias, checkWriteAccess } from '../matrix/client';

interface Props {
  contentId: string;
  children: React.ReactNode;
  onRoomId?: (roomId: string) => void;
}

type AccessState =
  | { status: 'checking' }
  | { status: 'ok'; roomId: string; userLevel: number }
  | { status: 'denied'; userLevel: number; required: number }
  | { status: 'no-room' }
  | { status: 'not-logged-in' };

export default function WriteGuard({ contentId, children, onRoomId }: Props) {
  const { creds } = useAuth();
  const [access, setAccess] = useState<AccessState>({ status: 'checking' });

  useEffect(() => {
    if (!creds) { setAccess({ status: 'not-logged-in' }); return; }

    let cancelled = false;
    async function check() {
      setAccess({ status: 'checking' });
      try {
        const serverName = new URL(creds!.homeserver).hostname;
        const alias = `#${contentId}:${serverName}`;
        const roomId = await resolveAlias(creds!.homeserver, alias);
        const { canWrite, userLevel, required } = await checkWriteAccess(creds!, roomId);
        if (cancelled) return;
        if (canWrite) {
          setAccess({ status: 'ok', roomId, userLevel });
          onRoomId?.(roomId);
        } else {
          setAccess({ status: 'denied', userLevel, required });
        }
      } catch {
        if (!cancelled) setAccess({ status: 'no-room' });
      }
    }

    check();
    return () => { cancelled = true; };
  }, [contentId, creds]);

  if (access.status === 'checking') {
    return <div className="access-checking">Checking access…</div>;
  }

  if (access.status === 'not-logged-in') {
    return (
      <div className="access-denied">
        <div className="access-icon">🔒</div>
        <h3>Not signed in</h3>
        <p>Sign in with your Matrix account to edit content.</p>
      </div>
    );
  }

  if (access.status === 'no-room') {
    return (
      <div className="access-no-room">
        <div className="access-icon">⬜</div>
        <h3>Room not found</h3>
        <p>No Matrix room exists for <code>{contentId}</code> on this homeserver.</p>
        <p>Create it first from the <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = ''; }}>Content list</a>.</p>
      </div>
    );
  }

  if (access.status === 'denied') {
    return (
      <div className="access-denied">
        <div className="access-icon">⊘</div>
        <h3>Write access denied</h3>
        <p>
          Your account has power level <strong>{access.userLevel}</strong>,
          but this room requires <strong>{access.required}</strong> to write.
        </p>
        <p>
          Ask a room admin to raise your power level, or use Element to join
          and request access.
        </p>
        <details>
          <summary>How to grant access</summary>
          <pre>{`# Run from the repo root with your admin token:
MATRIX_ACCESS_TOKEN=<admin_token> \\
MATRIX_USER_ID=@you:hyphae.social \\
npx tsx tools/setup-rooms.ts --invite \\
  !roomid:hyphae.social \\
  @editor:hyphae.social 50`}</pre>
        </details>
      </div>
    );
  }

  // status === 'ok'
  return <>{children}</>;
}
