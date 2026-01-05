import { useState } from 'react';
import { User, LogIn, LogOut, Settings } from 'lucide-react';
import { Button } from '../../primitives/Button';

interface UserInfo {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
}

interface UserButtonProps {
  user: UserInfo | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenSettings?: () => void;
}

export function UserButton({ user, onSignIn, onSignOut, onOpenSettings }: UserButtonProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  if (!user) {
    return (
      <Button variant="ghost" size="sm" onClick={onSignIn}>
        <LogIn size={16} className="mr-2" />
        Sign In
      </Button>
    );
  }

  const displayName = user.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
    : user.email;

  return (
    <div className="relative">
      <button
        onClick={() => setIsMenuOpen(!isMenuOpen)}
        className="flex items-center gap-2 p-1.5 rounded-md hover:bg-surface"
      >
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={displayName}
            className="w-7 h-7 rounded-full"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center">
            <User size={16} className="text-button-text" />
          </div>
        )}
        <span className="text-sm text-text-primary max-w-[120px] truncate">
          {displayName}
        </span>
      </button>

      {isMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="absolute right-0 top-full mt-1 w-48 bg-surface rounded-lg shadow-xl z-50 py-1">
            <div className="px-3 py-2 border-b border-bg-primary">
              <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
              <p className="text-xs text-text-secondary truncate">{user.email}</p>
            </div>

            {onOpenSettings && (
              <button
                onClick={() => {
                  setIsMenuOpen(false);
                  onOpenSettings();
                }}
                className="w-full px-3 py-2 text-sm text-text-primary hover:bg-bg-primary flex items-center gap-2"
              >
                <Settings size={16} />
                Account Settings
              </button>
            )}

            <button
              onClick={() => {
                setIsMenuOpen(false);
                onSignOut();
              }}
              className="w-full px-3 py-2 text-sm text-red-400 hover:bg-bg-primary flex items-center gap-2"
            >
              <LogOut size={16} />
              Sign Out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
