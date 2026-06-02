import React, { Component } from "react";

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to console for local debugging without exposing to the user
    console.error("[Flow Desktop] Renderer error:", error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flow-desktop error-boundary-fallback">
          <div className="error-boundary-content">
            <div className="error-boundary-icon" aria-hidden="true">⚠</div>
            <h2 className="error-boundary-title">Something went wrong</h2>
            <p className="error-boundary-message">
              The Flow Desktop interface encountered an unexpected error.
            </p>
            <pre className="error-boundary-detail">{this.state.error.message}</pre>
            <button type="button" className="error-boundary-retry" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
