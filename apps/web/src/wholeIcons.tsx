// Toolbar icons of the whole-sketch tools (sketchWholeTools.tsx): the sketch toggles, Close Sketch to Model, Derived
// Sketch, Rapid Sketch and the 2D to 3D toolbar. Same 24-unit grid and stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

/** A cube seen from the front-right-top, one face filled: the view a 2D to 3D sketch becomes. */
function cubeFace(face: string): ReactNode {
    return (
        <>
            <path d="M4 8l8-4 8 4v9l-8 4-8-4z" opacity="0.55" />
            <path d="M4 8l8 4 8-4M12 12v9" opacity="0.55" />
            <path d={face} fill="currentColor" fillOpacity="0.35" />
        </>
    );
}

export const WHOLE_ICONS: Record<string, ReactNode> = {
    'shaded-contours': (
        <>
            <path d="M4 6h10l6 6-6 6H4z" fill="currentColor" fillOpacity="0.3" />
            <path d="M8 10h4v4H8z" />
        </>
    ),
    instant2d: (
        <>
            <path d="M4 18h16" />
            <path d="M4 15v6M20 15v6" opacity="0.6" />
            <path d="M4 9h12" />
            <circle cx="18.5" cy="9" r="2" fill="currentColor" fillOpacity="0.35" />
            <path d="M8 6v6M12 7v4" opacity="0.6" />
        </>
    ),
    'rapid-sketch': (
        <>
            <path d="M3 17l7-3 11 3-7 3z" opacity="0.6" />
            <path d="M9 13l7.5-7.5 2 2L11 15H9z" />
            <path d="M5 4l-1 3h2l-1 3" />
        </>
    ),
    'close-to-model': (
        <>
            <path d="M4 18h16" strokeDasharray="2 2" />
            <path d="M6 18V8h12v10" />
            <path d="M12 21l-2-3h4z" fill="currentColor" />
        </>
    ),
    'derived-sketch': (
        <>
            <path d="M3 6h8v6H3z" />
            <path d="M13 13h8v6h-8z" />
            <path d="M8 13v3h4M10.5 14.5L12 16l-1.5 1.5" />
        </>
    ),
    underive: (
        <>
            <path d="M3 6h8v6H3z" />
            <path d="M13 13h8v6h-8z" />
            <path d="M7 15l4 3M11 15l-4 3" />
        </>
    ),
    'sketch-from-selection': (
        <>
            <path d="M3 3h9v9H3z" strokeDasharray="2 2" />
            <path d="M5 9l3-3 2 2" />
            <path d="M13 13h8v8h-8z" />
            <path d="M15 19l3-3 2 2" />
        </>
    ),
    'add-front': cubeFace('M4 8l8 4v9l-8-4z'),
    'add-back': cubeFace('M12 4l8 4v9l-8-4z'),
    'add-top': cubeFace('M4 8l8-4 8 4-8 4z'),
    'add-bottom': cubeFace('M4 17l8-4 8 4-8 4z'),
    'add-right': cubeFace('M12 12l8-4v9l-8 4z'),
    'add-left': cubeFace('M4 8l8-4v9l-8 4z'),
    'add-auxiliary': (
        <>
            <path d="M4 8l8-4 8 4v9l-8 4-8-4z" opacity="0.55" />
            <path d="M4 8l8 4 8-4M12 12v9" opacity="0.55" />
            <path d="M12 12l8-4-4 11z" fill="currentColor" fillOpacity="0.35" />
        </>
    ),
    'align-sketch': (
        <>
            <path d="M4 6h8M4 18h16" />
            <path d="M8 9v6M5.5 12.5L8 15l2.5-2.5" />
            <path d="M14 6h6" opacity="0.6" />
        </>
    ),
    'convert-extrude': (
        <>
            <path d="M4 17l8 4 8-4-8-4z" strokeDasharray="2 2" />
            <path d="M12 13V4M9 7l3-3 3 3" />
        </>
    ),
    'convert-cut': (
        <>
            <path d="M4 7l8 4 8-4-8-4z" strokeDasharray="2 2" />
            <path d="M12 11v9M9 17l3 3 3-3" />
        </>
    ),
};
