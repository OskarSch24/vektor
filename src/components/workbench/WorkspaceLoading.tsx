import type { FC } from 'react';

interface WorkspaceLoadingProps {
  label: string;
}

export const WorkspaceLoading: FC<WorkspaceLoadingProps> = ({ label }) => (
  <div className="grid h-full place-items-center bg-[#181818] text-[11px] text-apple-text-tertiary">
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-apple-accent" />
      {label}…
    </span>
  </div>
);
