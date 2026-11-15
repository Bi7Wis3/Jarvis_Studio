import { Component, type ReactNode } from 'react';

/** Keeps the rest of the interface alive when the 3D viewport stops: without WebGL, or after an error in the scene. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
    state: { error: string | null } = { error: null };

    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    componentDidCatch(error: unknown) {
        console.error('Viewport failed', error);
    }

    render() {
        const { error } = this.state;
        if (error === null) {
            return this.props.children;
        }
        // Say what really happened: only a WebGL failure is about the browser.
        const noWebGl = /webgl/i.test(error);
        return (
            <div className="viewport-error">
                <p>
                    {noWebGl
                        ? 'The 3D view could not start: this browser gave it no WebGL. Enable hardware acceleration or try another browser.'
                        : `The 3D view stopped because of an error: ${error}`}
                </p>
                <button type="button" onClick={() => this.setState({ error: null })}>Start the 3D view again</button>
            </div>
        );
    }
}
