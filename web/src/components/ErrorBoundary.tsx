import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface Props { children: ReactNode; resetKey: string }
interface State { error: Error | null }

class Boundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidUpdate(prev: Props) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="page">
        <div className="card pad stack" role="alert">
          <h2 className="mb-0">Something went wrong on this page</h2>
          <p className="muted mb-0">Your data is safe. Try again, or go back and repeat the last step. If it keeps happening, send this message to support:</p>
          <pre className="small-text" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{e.message}</pre>
          <div className="row">
            <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </div>
      </div>
    );
  }
}

/** Keeps a page crash inside the content area; navigating to another page clears it. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <Boundary resetKey={loc.pathname}>{children}</Boundary>;
}
