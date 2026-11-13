import { DEFAULT_VIEW, type Material, type Project } from '@jarvis/core';

const dark: Material = { color: '#1b1d22', metalness: 0.2, roughness: 0.75 };
const aluminium: Material = { color: '#c9d1d9', metalness: 1, roughness: 0.25 };

/** A small desk speaker, shown on first run so the viewport is not empty. */
export function demoProject(): Project {
    return {
        name: 'Desk Speaker',
        view: { ...DEFAULT_VIEW },
        parts: [
            {
                id: 'base',
                name: 'Aluminium base',
                shape: { kind: 'cylinder', radius: 44, height: 6 },
                position: [0, 3, 0],
                rotation: [0, 0, 0],
                material: aluminium,
            },
            {
                id: 'fabric-band',
                name: 'Acoustic fabric band',
                shape: { kind: 'tube', outerRadius: 45, innerRadius: 42, height: 40 },
                position: [0, 26, 0],
                rotation: [0, 0, 0],
                material: { color: '#2a2d34', metalness: 0, roughness: 1 },
            },
            {
                id: 'driver',
                name: 'Full-range speaker driver',
                shape: { kind: 'lathe', profile: [[0, -10], [14, -10], [36, 8], [38, 8], [38, 10], [12, 10], [0, 4]] },
                position: [0, 58, 0],
                rotation: [0, 0, 0],
                material: { color: '#101114', metalness: 0.4, roughness: 0.5 },
            },
            {
                id: 'battery',
                name: 'Battery pack',
                shape: { kind: 'box', size: [36, 22, 28], radius: 3 },
                position: [0, 82, 0],
                rotation: [0, 0, 0],
                material: dark,
            },
            {
                id: 'logic-board',
                name: 'Main logic board',
                shape: { kind: 'cylinder', radius: 36, height: 1.6 },
                position: [0, 98, 0],
                rotation: [0, 0, 0],
                material: { color: '#1f6b46', metalness: 0.3, roughness: 0.6 },
            },
            {
                id: 'waist-ring',
                name: 'Aluminium waist ring',
                shape: { kind: 'tube', outerRadius: 46, innerRadius: 43, height: 3 },
                position: [0, 104, 0],
                rotation: [0, 0, 0],
                material: aluminium,
            },
            {
                id: 'shell',
                name: 'Soft-touch body shell',
                shape: { kind: 'tube', outerRadius: 45, innerRadius: 42.5, height: 44 },
                position: [0, 128, 0],
                rotation: [0, 0, 0],
                material: dark,
            },
            {
                id: 'light-ring',
                name: 'Status light ring',
                shape: { kind: 'torus', radius: 40, tube: 1.6 },
                position: [0, 151, 0],
                rotation: [0, 0, 0],
                material: { color: '#0b2a33', metalness: 0, roughness: 0.4, emissive: '#35e0ff', emissiveIntensity: 3 },
            },
            {
                id: 'top-cap',
                name: 'Touch top cap',
                shape: { kind: 'lathe', profile: [[0, 3], [30, 2.5], [42, 0], [45, -3], [0, -3]] },
                position: [0, 155, 0],
                rotation: [0, 0, 0],
                material: { color: '#16181d', metalness: 0.6, roughness: 0.3 },
            },
        ],
    };
}
