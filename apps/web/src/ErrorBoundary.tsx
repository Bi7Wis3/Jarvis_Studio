import { Component, type ReactNode } from 'react';

/** Keeps the rest of the interface alive when the 3D viewport cannot start, e.g. without WebGL. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.error('Viewport failed', error);
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="viewport-error">
                    The 3D viewport could not start. This browser has no WebGL; enable hardware acceleration or try
                    another browser.
                </div>
            );
        }
        return this.props.children;
    }
}
