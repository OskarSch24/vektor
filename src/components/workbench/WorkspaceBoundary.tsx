import { Component, type ErrorInfo, type ReactNode } from 'react';

interface WorkspaceBoundaryProps {
  label: string;
  children: ReactNode;
}

interface WorkspaceBoundaryState {
  error: Error | null;
}

export class WorkspaceBoundary extends Component<WorkspaceBoundaryProps, WorkspaceBoundaryState> {
  override state: WorkspaceBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WorkspaceBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} konnte nicht geladen werden.`, error, info);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center bg-[#181818] px-8 text-center">
        <div className="max-w-md text-[11px] text-apple-text-tertiary">
          <p className="text-[12px] font-medium text-apple-text-secondary">
            {this.props.label} konnte nicht geladen werden.
          </p>
          <p className="mt-1 break-words">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-[3px] border border-white/[0.09] bg-white/[0.045] px-3 py-1.5 text-apple-text-secondary hover:bg-white/[0.075] hover:text-white"
          >
            Arbeitsbereich neu laden
          </button>
        </div>
      </div>
    );
  }
}
