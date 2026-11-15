// Feature tree icons, coloured by kind so they read at a glance (as in a CAD feature manager): boss features green,
// cuts red with a notched glyph, fillet and chamfer, patterns, reference geometry and so on each their own.

import type { ReactNode } from 'react';
import { Icon } from './icons';

const BOSS = '#6fd58a';
const CUT = '#ff7b6e';
const REF = '#ffd58a';
const SKETCH = '#35e0ff';
const PLANE_GREY = '#8a94a6';

/** A face filled faintly in the icon's colour. */
const FILL = { fill: 'currentColor', fillOpacity: 0.22 } as const;

const block = <path d="M3 12h11v9H3zM3 12l4-4h11l-4 4M14 21l4-4V8" {...FILL} />;
const notched = <path d="M3 12h3v4h5v-4h3v9H3zM3 12l4-4h11l-4 4M14 21l4-4V8" {...FILL} />;

const ICONS: Record<string, { color: string; body: ReactNode }> = {
    'boss-extrude': {
        color: BOSS,
        body: (
            <>
                {block}
                <path d="M10.5 9.5V2M8 4.5L10.5 2 13 4.5" strokeWidth="2" />
            </>
        ),
    },
    'cut-extrude': {
        color: CUT,
        body: (
            <>
                {notched}
                <path d="M8.5 2v8M6 7.5L8.5 10 11 7.5" strokeWidth="2" />
            </>
        ),
    },
    boss: { color: BOSS, body: <path d="M4 9h11v11H4zM4 9l4-4h11l-4 4M15 20l4-4V5" {...FILL} /> },
    cut: { color: CUT, body: <path d="M4 9h3v5h5V9h3v11H4zM4 9l4-4h11l-4 4M15 20l4-4V5" {...FILL} /> },
    'boss-revolve': {
        color: BOSS,
        body: (
            <>
                <path d="M6 7v10a6 2.5 0 0 0 12 0V7" {...FILL} />
                <ellipse cx="12" cy="7" rx="6" ry="2.5" {...FILL} />
                <path d="M21 6.5a9 4 0 0 1-2 6.5M21 13l-2 0.2 0.3-2" />
            </>
        ),
    },
    'cut-revolve': {
        color: CUT,
        body: (
            <>
                <path d="M4 7v10a8 3 0 0 0 16 0V7" {...FILL} />
                <ellipse cx="12" cy="7" rx="8" ry="3" />
                <ellipse cx="12" cy="7" rx="3.5" ry="1.3" fill="currentColor" />
                <path d="M12 8.5v8" strokeDasharray="2 2" />
            </>
        ),
    },
    'boss-sweep': {
        color: BOSS,
        body: (
            <>
                <path d="M5 18c4 0 4-12 8-12s4 12 8 12" />
                <ellipse cx="5" cy="18" rx="2.2" ry="3" {...FILL} />
            </>
        ),
    },
    'cut-sweep': {
        color: CUT,
        body: (
            <>
                <path d="M5 18c4 0 4-12 8-12s4 12 8 12" strokeDasharray="2.5 2" />
                <ellipse cx="5" cy="18" rx="2.2" ry="3" fill="currentColor" />
            </>
        ),
    },
    'boss-loft': {
        color: BOSS,
        body: (
            <>
                <path d="M3 19l3-4h10l-3 4z" {...FILL} />
                <ellipse cx="14" cy="5.5" rx="5" ry="2" {...FILL} />
                <path d="M3.5 18.5L9 5.5M15.5 16.5L19 5.5" />
            </>
        ),
    },
    'cut-loft': {
        color: CUT,
        body: (
            <>
                <path d="M3 19l3-4h10l-3 4z" fill="currentColor" />
                <ellipse cx="14" cy="5.5" rx="5" ry="2" />
                <path d="M3.5 18.5L9 5.5M15.5 16.5L19 5.5" strokeDasharray="2 2" />
            </>
        ),
    },
    hole: {
        color: CUT,
        body: (
            <>
                <path d="M3 11l4-4h14l-4 4zM3 11v9h14v-9M17 20l4-4V7" {...FILL} />
                <ellipse cx="12" cy="9" rx="3.2" ry="1.3" fill="currentColor" />
                <path d="M12 2v5" strokeWidth="2" />
            </>
        ),
    },
    fillet: {
        color: '#5ab4ff',
        body: (
            <>
                <path d="M4 20V4h6a10 10 0 0 1 10 10v6z" {...FILL} />
                <path d="M10 4a10 10 0 0 1 10 10" strokeWidth="2.4" />
            </>
        ),
    },
    chamfer: {
        color: '#c79bff',
        body: (
            <>
                <path d="M4 20V4h8l8 8v8z" {...FILL} />
                <path d="M12 4l8 8" strokeWidth="2.4" />
            </>
        ),
    },
    shell: { color: '#ffb057', body: <path d="M3 6v15h18V6h-4v11H7V6z" {...FILL} /> },
    draft: {
        color: '#f2c46d',
        body: (
            <>
                <path d="M7 20l2.5-15h5L17 20z" {...FILL} />
                <path d="M3 20h18M12 3v18" opacity="0.55" strokeDasharray="2 2" />
            </>
        ),
    },
    mirror: {
        color: '#35e0ff',
        body: (
            <>
                <path d="M12 2v20" strokeDasharray="2.5 2" />
                <path d="M9.5 6L3 18h6.5z" {...FILL} />
                <path d="M14.5 6L21 18h-6.5z" />
            </>
        ),
    },
    'pattern-linear': {
        color: '#4fd6c0',
        body: <path d="M2 9h5.5v6H2zM9.25 9h5.5v6h-5.5zM16.5 9H22v6h-5.5z" {...FILL} />,
    },
    'pattern-circular': {
        color: '#4fd6c0',
        body: (
            <>
                <circle cx="12" cy="12" r="1.2" fill="currentColor" />
                {[0, 60, 120, 180, 240, 300].map((a) => (
                    <circle
                        key={a}
                        cx={12 + 8 * Math.cos((a * Math.PI) / 180)}
                        cy={12 + 8 * Math.sin((a * Math.PI) / 180)}
                        r="2.3"
                        {...(a === 0 ? { fill: 'currentColor' } : FILL)}
                    />
                ))}
            </>
        ),
    },
    thread: {
        color: '#b9c6d8',
        body: <path d="M7 3h10v18H7zM7 8l10-3M7 12l10-3M7 16l10-3M7 20l10-3" {...FILL} />,
    },
    combine: {
        color: '#e58bd6',
        body: (
            <>
                <rect x="3" y="7" width="10" height="10" rx="1" {...FILL} />
                <circle cx="15" cy="12" r="5.5" {...FILL} />
            </>
        ),
    },
    'combine-cut': {
        color: CUT,
        body: (
            <>
                <path d="M3 7h10v2.2a5.5 5.5 0 0 0 0 5.6V17H3z" {...FILL} />
                <circle cx="15" cy="12" r="5.5" strokeDasharray="2.5 2" />
            </>
        ),
    },
    split: {
        color: '#e58bd6',
        body: (
            <>
                <path d="M3 6h7v12H3zM14 6h7v12h-7z" {...FILL} />
                <path d="M12 2v20" strokeDasharray="2 2" />
            </>
        ),
    },
    sketch: {
        color: SKETCH,
        body: (
            <>
                <path d="M2 20l4-6h16l-4 6z" stroke={PLANE_GREY} />
                <path d="M9 17l1-3.5L19 4.5 21.5 7l-9 9z" fill="currentColor" fillOpacity="0.3" />
                <path d="M17 6.5l2.5 2.5" />
            </>
        ),
    },
    plane: { color: REF, body: <path d="M2 18l6-10h14l-6 10z" {...FILL} /> },
    axis: {
        color: REF,
        body: (
            <>
                <path d="M4 20L20 4" strokeDasharray="3 2.5" />
                <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            </>
        ),
    },
    point: {
        color: REF,
        body: (
            <>
                <path d="M12 5v14M5 12h14" opacity="0.45" />
                <circle cx="12" cy="12" r="2.8" fill="currentColor" />
            </>
        ),
    },
    origin: {
        color: '#ff6b6b',
        body: (
            <>
                <path d="M6 18V4M4 7l2-3 2 3" stroke="#6fd58a" />
                <path d="M6 18h14M17 16l3 2-3 2" />
                <circle cx="6" cy="18" r="2" fill="currentColor" />
            </>
        ),
    },
    material: {
        color: PLANE_GREY,
        body: (
            <>
                <rect x="3" y="3" width="6" height="5" fill="#ff7b6e" stroke="none" />
                <rect x="3" y="9.5" width="6" height="5" fill="#6fd58a" stroke="none" />
                <rect x="3" y="16" width="6" height="5" fill="#5ab4ff" stroke="none" />
                <path d="M12 5.5h9M12 12h9M12 18.5h9" />
            </>
        ),
    },
    part: {
        color: '#f5c451',
        body: (
            <>
                <path d="M12 2.5l8.5 4.5v10L12 21.5 3.5 17V7z" {...FILL} />
                <path d="M3.5 7L12 11.5 20.5 7M12 11.5v10" />
            </>
        ),
    },
    history: {
        color: '#8fb3ff',
        body: (
            <>
                <circle cx="13" cy="12" r="8" {...FILL} />
                <path d="M13 7.5V12l3 2" />
                <path d="M2 9l3 3 3-3" stroke="#6fd58a" />
            </>
        ),
    },
    // The Solid Bodies folder and one solid body in it.
    bodies: {
        color: '#b9c7dc',
        body: (
            <>
                <path d="M2 6h7l2 2h11v13H2z" {...FILL} />
                <path d="M9 12.5l3.5-2 3.5 2v4l-3.5 2-3.5-2zM9 12.5l3.5 2 3.5-2M12.5 14.5v4" />
            </>
        ),
    },
    'solid-body': {
        color: '#b9c7dc',
        body: (
            <>
                <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...FILL} />
                <path d="M4 7.5L12 12l8-4.5M12 12v9" />
            </>
        ),
    },
    // A folder of the feature tree, closed and open.
    folder: { color: '#e8c36a', body: <path d="M2 5.5h7l2 2.5h11v12H2z" {...FILL} /> },
    'folder-open': {
        color: '#e8c36a',
        body: (
            <>
                <path d="M2 20V5.5h7l2 2.5h9v3" />
                <path d="M2 20l3.5-9H23l-3.5 9z" {...FILL} />
            </>
        ),
    },
};

/** A history step icon: the tree's own coloured drawing, else the toolbar icon of that name. */
export function StepIcon({ name, size = 14 }: { name: string; size?: number }) {
    const icon = ICONS[name];
    if (!icon) {
        return <Icon name={name} size={size} />;
    }
    return (
        <svg
            className="icon step-icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: icon.color }}
            aria-hidden="true"
        >
            {icon.body}
        </svg>
    );
}
