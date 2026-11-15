// Toolbar icons: 24-unit grid, drawn at 18 px with a 1.6 stroke in the current text colour.

import type { ReactNode } from 'react';
import { DRAW_VARIANT_ICONS } from './drawIcons';
import { MODIFY_MORE_ICONS } from './modifyIcons';
import { EXTRAS_ICONS } from './extrasIcons';
import { MODEL_SKETCH_ICONS } from './modelIcons';
import { RELATION_ICONS } from './relationIcons';
import { WHOLE_ICONS } from './wholeIcons';
import { DRAW_COMMAND_ICONS } from './drawCommandIcons';

const PATHS: Record<string, ReactNode> = {
    sketch: (
        <>
            <path d="M4 20h16" opacity="0.5" />
            <path d="M5 16l9.5-9.5 3 3L8 19H5z" />
            <path d="M12.5 8.5l3 3" />
        </>
    ),
    extrude: (
        <>
            <path d="M4 17l8 4 8-4-8-4z" />
            <path d="M12 13V4M9 7l3-3 3 3" />
        </>
    ),
    revolve: (
        <>
            <path d="M12 3v18" strokeDasharray="2 2" />
            <ellipse cx="12" cy="12" rx="7" ry="3" />
            <path d="M17 7.5l2 2.5-3 .5" />
        </>
    ),
    box: (
        <>
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
            <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
        </>
    ),
    cylinder: (
        <>
            <ellipse cx="12" cy="6" rx="7" ry="2.8" />
            <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" />
        </>
    ),
    sphere: (
        <>
            <circle cx="12" cy="12" r="8" />
            <ellipse cx="12" cy="12" rx="8" ry="3" />
        </>
    ),
    cone: (
        <>
            <path d="M12 3L5 18M12 3l7 15" />
            <ellipse cx="12" cy="18" rx="7" ry="2.6" />
        </>
    ),
    torus: (
        <>
            <ellipse cx="12" cy="12" rx="9" ry="5" />
            <ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" />
        </>
    ),
    tube: (
        <>
            <ellipse cx="12" cy="6" rx="7" ry="2.8" />
            <ellipse cx="12" cy="6" rx="3.5" ry="1.3" />
            <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" />
        </>
    ),
    fastener: (
        <>
            <path d="M7 4h10v4H7z" />
            <path d="M10 8v12h4V8" />
            <path d="M10 11l4 1.5M10 14l4 1.5M10 17l4 1.5" />
        </>
    ),
    fillet: (
        <>
            <path d="M4 20V11a7 7 0 0 1 7-7h9" />
            <path d="M4 20h16" opacity="0.5" />
        </>
    ),
    chamfer: (
        <>
            <path d="M4 20V10l6-6h10" />
            <path d="M4 20h16" opacity="0.5" />
        </>
    ),
    draft: (
        <>
            <path d="M7 19l2.5-14h5L17 19" />
            <path d="M3 19h18" opacity="0.5" />
            <path d="M12 3v16" opacity="0.5" strokeDasharray="2 2" />
        </>
    ),
    shell: (
        <>
            <path d="M3 6v13h18V6" />
            <path d="M6.5 6v9.5h11V6" />
        </>
    ),
    hole: (
        <>
            <ellipse cx="12" cy="7" rx="8" ry="3" />
            <ellipse cx="12" cy="7" rx="3" ry="1.2" />
            <path d="M9 7.5v10M15 7.5v10" strokeDasharray="2 1.8" />
        </>
    ),
    pattern: (
        <>
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
            <rect x="14.5" y="3.5" width="6" height="6" rx="1" opacity="0.7" />
            <rect x="3.5" y="14.5" width="6" height="6" rx="1" opacity="0.7" />
            <rect x="14.5" y="14.5" width="6" height="6" rx="1" opacity="0.45" />
        </>
    ),
    pocket: (
        <>
            <path d="M3 8l9-4 9 4-9 4z" />
            <path d="M3 8v8l9 4 9-4V8" />
            <path d="M8.5 8l3.5-1.6L15.5 8 12 9.6z" />
        </>
    ),
    move: (
        <>
            <path d="M12 3v18M3 12h18" />
            <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
        </>
    ),
    rotate: (
        <>
            <path d="M19 12a7 7 0 1 1-2.1-5" />
            <path d="M18 3v4.5h-4.5" />
        </>
    ),
    duplicate: (
        <>
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
        </>
    ),
    mirror: (
        <>
            <path d="M12 3v18" strokeDasharray="2 2" />
            <path d="M9 6L3 18h6zM15 6l6 12h-6z" />
        </>
    ),
    combine: (
        <>
            <rect x="3.5" y="3.5" width="11" height="11" rx="1" />
            <rect x="9.5" y="9.5" width="11" height="11" rx="1" opacity="0.7" />
        </>
    ),
    split: (
        <>
            <path d="M4 6h6v12H4zM14 6h6v12h-6z" />
            <path d="M12 2v20" strokeDasharray="2 2" />
        </>
    ),
    delete: (
        <>
            <path d="M4 7h16M10 7V4.5h4V7" />
            <path d="M6 7l1 13h10l1-13M10 11v6M14 11v6" />
        </>
    ),
    picture: (
        <>
            <rect x="3.5" y="5" width="17" height="14" rx="2" />
            <circle cx="9" cy="10" r="1.6" />
            <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" />
        </>
    ),
    material: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 3.5a8.5 8.5 0 0 0 0 17" fill="currentColor" fillOpacity="0.25" stroke="none" />
            <circle cx="9" cy="9" r="1.6" />
        </>
    ),
    views: (
        <>
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
            <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
            <path d="M12 3v9" opacity="0.4" />
        </>
    ),
    fit: (
        <>
            <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
            <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
        </>
    ),
    perspective: (
        <>
            <path d="M3 5l18 4v6L3 19z" />
            <path d="M9 6.4v11.2M15 7.7v8.6" opacity="0.7" />
        </>
    ),
    grid: (
        <>
            <path d="M3 4h18v16H3z" />
            <path d="M9 4v16M15 4v16M3 9.3h18M3 14.7h18" opacity="0.7" />
        </>
    ),
    edges: (
        <>
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" strokeWidth="2" />
            <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
        </>
    ),
    labels: (
        <>
            <rect x="10" y="4" width="11" height="6" rx="2" />
            <path d="M10 7H7l-3 9" />
            <circle cx="4" cy="17.5" r="1.4" />
        </>
    ),
    explode: (
        <>
            <rect x="8" y="3" width="8" height="4" rx="1" />
            <rect x="8" y="10" width="8" height="4" rx="1" />
            <rect x="8" y="17" width="8" height="4" rx="1" />
            <path d="M3 8l2-2 2 2M3 16l2 2 2-2M5 6v12" opacity="0.7" />
        </>
    ),
    stl: (
        <>
            <path d="M12 3v11M8 10l4 4 4-4" />
            <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
        </>
    ),
    step: (
        <>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v4h4M9 12l3-2 3 2v4l-3 2-3-2z" />
        </>
    ),
    freecad: (
        <>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v4h4" />
            <circle cx="10" cy="11" r="1.3" />
            <circle cx="10" cy="17" r="1.3" />
            <path d="M10 12.3v3.4M12.5 11h3M12.5 17h3" />
        </>
    ),
    check: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M8 12.5l2.7 2.7L16 9.8" />
        </>
    ),
    measure: (
        <g transform="rotate(-30 12 12)">
            <rect x="2.5" y="8.5" width="19" height="7" rx="1" />
            <path d="M6.5 8.5v3M9.5 8.5v2M12.5 8.5v3M15.5 8.5v2M18.5 8.5v3" />
        </g>
    ),
    mass: (
        <>
            <path d="M6.5 9h11l2.5 11.5h-16z" />
            <circle cx="12" cy="6" r="2.5" />
        </>
    ),
    undo: <path d="M9 5L4 10l5 5M4 10h10a5.5 5.5 0 0 1 0 11h-3" />,
    redo: <path d="M15 5l5 5-5 5M20 10H10a5.5 5.5 0 0 0 0 11h3" />,
    line: (
        <>
            <path d="M5 19L19 5" />
            <circle cx="5" cy="19" r="1.8" />
            <circle cx="19" cy="5" r="1.8" />
        </>
    ),
    rectangle: (
        <>
            <rect x="4" y="6" width="16" height="12" rx="0.5" />
            <circle cx="4" cy="6" r="1.4" fill="currentColor" />
            <circle cx="20" cy="18" r="1.4" fill="currentColor" />
        </>
    ),
    circle: (
        <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 12h8" opacity="0.6" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
        </>
    ),
    arc: (
        <>
            <path d="M4 18a9 9 0 0 1 16 0" />
            <circle cx="4" cy="18" r="1.6" />
            <circle cx="20" cy="18" r="1.6" />
            <circle cx="12" cy="9" r="1.2" fill="currentColor" />
        </>
    ),
    slot: (
        <>
            <path d="M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z" />
            <circle cx="8" cy="12" r="1.1" fill="currentColor" />
            <circle cx="16" cy="12" r="1.1" fill="currentColor" />
        </>
    ),
    polygon: <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" />,
    'center-rect': (
        <>
            <rect x="4" y="6" width="16" height="12" rx="0.5" />
            <path d="M4 6l16 12" strokeDasharray="2 2" opacity="0.6" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" />
        </>
    ),
    'tangent-arc': (
        <>
            <path d="M3 17h8" />
            <path d="M11 17a6 6 0 0 0 6-6V5" />
            <circle cx="11" cy="17" r="1.4" fill="currentColor" />
        </>
    ),
    'perimeter-circle': (
        <>
            <circle cx="12" cy="12" r="7.5" />
            <circle cx="12" cy="4.5" r="1.4" fill="currentColor" />
            <circle cx="5.5" cy="15.8" r="1.4" fill="currentColor" />
            <circle cx="18.5" cy="15.8" r="1.4" fill="currentColor" />
        </>
    ),
    'rect-3pt': (
        <>
            <path d="M4 15l9-9 7 7-9 9z" />
            <circle cx="4" cy="15" r="1.4" fill="currentColor" />
            <circle cx="13" cy="6" r="1.4" fill="currentColor" />
            <circle cx="20" cy="13" r="1.4" fill="currentColor" />
        </>
    ),
    'center-arc': (
        <>
            <path d="M19 12a7 7 0 0 1-12.1 4.8" />
            <path d="M12 12h7" opacity="0.6" />
            <circle cx="12" cy="12" r="1.3" fill="currentColor" />
            <circle cx="19" cy="12" r="1.6" />
            <circle cx="6.9" cy="16.8" r="1.6" />
        </>
    ),
    ellipse: (
        <>
            <ellipse cx="12" cy="12" rx="8.5" ry="5" />
            <path d="M12 12h8.5M12 12V7" opacity="0.6" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
        </>
    ),
    'partial-ellipse': (
        <>
            <path d="M20.5 12A8.5 5 0 1 1 12 7" />
            <ellipse cx="12" cy="12" rx="8.5" ry="5" opacity="0.3" strokeDasharray="1.5 2" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
            <circle cx="20.5" cy="12" r="1.5" />
            <circle cx="12" cy="7" r="1.5" />
        </>
    ),
    spline: (
        <>
            <path d="M3 17c3-9 6-9 8-4s5 5 10-6" />
            <circle cx="3" cy="17" r="1.4" />
            <circle cx="11" cy="13" r="1.4" />
            <circle cx="21" cy="7" r="1.4" />
        </>
    ),
    'style-spline': (
        <>
            <path d="M3 18C8 3 15 21 21 6" />
            <path d="M3 18L8 4l7 16 6-14" opacity="0.45" strokeDasharray="1.5 2" />
            <rect x="6.8" y="2.8" width="2.4" height="2.4" />
            <rect x="13.8" y="18.8" width="2.4" height="2.4" />
        </>
    ),
    parabola: (
        <>
            <path d="M4 5c2 10 14 10 16 0" />
            <circle cx="12" cy="9" r="1.2" fill="currentColor" />
            <circle cx="12" cy="12.5" r="1.4" />
        </>
    ),
    conic: (
        <>
            <path d="M4 18Q12 0 20 18" />
            <path d="M4 18l8-14 8 14" opacity="0.45" strokeDasharray="1.5 2" />
            <circle cx="12" cy="4" r="1.4" />
        </>
    ),

    trim: (
        <>
            <path d="M12 3v18" opacity="0.6" />
            <path d="M3 12h6" />
            <path d="M15 12h6" strokeDasharray="2 2" />
            <path d="M16 8.5l3 3M19 8.5l-3 3" />
        </>
    ),
    extend: (
        <>
            <path d="M19 3v18" opacity="0.6" />
            <path d="M3 12h7" />
            <path d="M10 12h6" strokeDasharray="2 2" />
            <path d="M14 9l3 3-3 3" />
        </>
    ),
    'sk-fillet': (
        <>
            <path d="M5 4v8a7 7 0 0 0 7 7h8" />
            <path d="M5 19h3M5 16v3" opacity="0.5" />
        </>
    ),
    'sk-chamfer': (
        <>
            <path d="M5 4v9l6 6h9" />
            <path d="M5 19h3M5 16v3" opacity="0.5" />
        </>
    ),
    offset: (
        <>
            <rect x="8" y="8" width="8" height="8" rx="0.5" />
            <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="2.5 2" />
        </>
    ),
    'pattern-circular': (
        <>
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
            <circle cx="12" cy="5" r="2" />
            <circle cx="18.1" cy="15.5" r="2" />
            <circle cx="5.9" cy="15.5" r="2" />
        </>
    ),
    finish: (
        <>
            <path d="M4 20l8-4 8 4-8 3z" opacity="0.5" />
            <path d="M6 10.5l4 4L18 6" strokeWidth="2" />
        </>
    ),
    cancel: <path d="M6 6l12 12M18 6L6 18" />,
    ghost: (
        <>
            <rect x="3" y="8" width="9" height="9" rx="1" strokeDasharray="2 2" />
            <rect x="11" y="5" width="10" height="10" rx="1" />
        </>
    ),
    thread: (
        <>
            <path d="M9 3v18M15 3v18" opacity="0.5" />
            <path d="M8 5l8 2.5M8 9l8 2.5M8 13l8 2.5M8 17l8 2.5" />
        </>
    ),
    loft: (
        <>
            <rect x="5" y="16" width="14" height="4" rx="1" />
            <ellipse cx="12" cy="5.5" rx="3.5" ry="1.6" />
            <path d="M5 16L8.5 5.8M19 16l-3.5-10.2" />
        </>
    ),
    sweep: (
        <>
            <path d="M5 18c4 0 4-12 8-12s4 12 8 12" />
            <ellipse cx="5" cy="18" rx="2.2" ry="3" />
        </>
    ),
    select: <path d="M6 3l12 9-5.5 1.2L16 20l-2.6 1.2-3-6.6L6 18z" />,
    dimension: (
        <>
            <path d="M4 7v10M20 7v10" />
            <path d="M4 12h16M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5" />
        </>
    ),
    'c-coincident': (
        <>
            <path d="M3 20l8-8M13 12l8-8" opacity="0.6" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </>
    ),
    'c-horizontal': (
        <>
            <path d="M4 15h16" />
            <path d="M8 5v6M16 5v6M8 8h8" opacity="0.7" />
        </>
    ),
    'c-vertical': (
        <>
            <path d="M9 4v16" />
            <path d="M14 8h6M14 16h6M17 8v8" opacity="0.7" />
        </>
    ),
    'c-parallel': <path d="M5 19L13 5M11 19l8-14" />,
    'c-perpendicular': <path d="M5 19h14M12 19V5M12 15h4v4" />,
    'c-tangent': (
        <>
            <circle cx="12" cy="13" r="6" />
            <path d="M3 7h18" />
        </>
    ),
    'c-equal': <path d="M5 9h14M5 15h14" />,
    'c-merge': (
        <>
            <path d="M4 6l7 6M4 18l7-6M12 12h8" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        </>
    ),
    'c-collinear': (
        <>
            <path d="M3 17L10 12.5M14 10l7-4.5" />
            <path d="M10 12.5l4-2.5" strokeDasharray="1.5 1.5" opacity="0.6" />
        </>
    ),
    'c-concentric': (
        <>
            <circle cx="12" cy="12" r="7.5" />
            <circle cx="12" cy="12" r="3.5" />
            <circle cx="12" cy="12" r="0.8" fill="currentColor" />
        </>
    ),
    'c-coradial': (
        <>
            <path d="M5 12a7 7 0 0 1 12.5-4.3" />
            <path d="M19 12a7 7 0 0 1-12.5 4.3" />
            <circle cx="12" cy="12" r="0.8" fill="currentColor" />
        </>
    ),
    'c-midpoint': (
        <>
            <path d="M3 17L21 7" />
            <path d="M12 12m-2.4 0a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0" fill="currentColor" />
        </>
    ),
    'c-symmetric': (
        <>
            <path d="M12 3v18" strokeDasharray="2 2" />
            <circle cx="6" cy="12" r="2" />
            <circle cx="18" cy="12" r="2" />
            <path d="M8.5 12h1.5M14 12h1.5" />
        </>
    ),
    'c-fix': (
        <>
            <rect x="7" y="11" width="10" height="8" rx="1.5" />
            <path d="M9 11V8a3 3 0 0 1 6 0v3" />
        </>
    ),
    'c-construction': <path d="M4 20L20 4" strokeDasharray="3 2.5" />,
    eye: (
        <>
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
            <circle cx="12" cy="12" r="2.8" />
        </>
    ),
    'eye-off': (
        <>
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" opacity="0.5" />
            <path d="M4 4l16 16" />
        </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    'sk-point': (
        <>
            <path d="M12 4v4M12 16v4M4 12h4M16 12h4" opacity="0.5" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
        </>
    ),
    centerline: <path d="M3 21L21 3" strokeDasharray="5 2.5 1 2.5" />,
    'ref-plane': <path d="M2.5 18l5.5-10h13.5l-5.5 10z" />,
    'ref-axis': (
        <>
            <path d="M4 20L20 4" strokeDasharray="3 2.5" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        </>
    ),
    'ref-point': (
        <>
            <path d="M12 5v14M5 12h14" opacity="0.45" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </>
    ),
    scale: (
        <>
            <rect x="3.5" y="11.5" width="9" height="9" rx="1" />
            <path d="M3.5 7.5v-4h17v17h-4" opacity="0.5" />
            <path d="M12 12l7-7M14.5 5H19v4.5" />
        </>
    ),
    relations: (
        <>
            <path d="M4 6h3M4 12h3M4 18h3" />
            <path d="M10 6h10M10 12h10M10 18h6" opacity="0.6" />
            <path d="M17 16.5l3 3M20 16.5l-3 3" />
        </>
    ),
    snap: (
        <>
            <path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" />
            <path d="M6 8h4M14 8h4" opacity="0.6" />
        </>
    ),
    repair: (
        <>
            <path d="M14.5 6.5a4 4 0 0 0 5 5L13 18l-2 2a2.1 2.1 0 0 1-3-3l2-2z" />
            <path d="M3 9h5M5.5 6.5v5" opacity="0.6" />
        </>
    ),
    'fully-define': (
        <>
            <path d="M4 18h16M4 15v6M20 15v6" />
            <path d="M6 5l4 4 8-7" />
        </>
    ),
    ...DRAW_VARIANT_ICONS,
    ...MODIFY_MORE_ICONS,
    ...EXTRAS_ICONS,
    ...MODEL_SKETCH_ICONS,
    ...RELATION_ICONS,
    ...WHOLE_ICONS,
    ...DRAW_COMMAND_ICONS,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {PATHS[name]}
        </svg>
    );
}
