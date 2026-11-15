import { useEffect, useId, useRef } from 'react';
import { level } from './audio';
import { useCadDisplay } from './kernelActivity';
import { useStudio } from './state';
import './kernelActivity.css';

/** Steps of a build shown as separate segments of the outer ring; longer histories fill it as one arc. */
const MAX_SEGMENTS = 48;
const MAX_PIPS = 6;

/**
 * The assistant's presence: rings that idle, spin faster while thinking and pulse with the voice. The CAD kernel's
 * work shows on the outside: a ring that fills step by step, the tick ring chasing while it builds, a sweep while it
 * meshes, slow dots for jobs waiting, a flash when a result lands and a red pulse when a build fails.
 */
export function Orb() {
    const status = useStudio((s) => s.status);
    const speaking = useStudio((s) => s.speaking);
    const connected = useStudio((s) => s.connected);
    const cad = useCadDisplay();
    const ref = useRef<HTMLDivElement>(null);
    const id = useId().replace(/:/g, '');

    useEffect(() => {
        let frame = 0;
        let smooth = 0;
        const tick = () => {
            smooth += (level() - smooth) * 0.25;
            ref.current?.style.setProperty('--level', smooth.toFixed(3));
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, []);

    const state = !connected ? 'offline' : speaking ? 'speaking' : status;
    const assistant = { offline: 'Offline', idle: 'Online', thinking: 'Thinking', working: 'Working', speaking: 'Speaking' }[state];
    const look = connected ? cad.look : 'idle';
    const caption = look === 'idle' || !cad.caption ? assistant
        : state === 'idle' ? cad.caption : `${assistant} · ${cad.caption.toLowerCase()}`;
    const steps = cad.steps;
    const segmented = !!steps && steps.count <= MAX_SEGMENTS;
    // In step units (pathLength = count): the gap between segments, and the dash pattern of the segmented ring.
    const count = steps?.count ?? 1;
    const gap = segmented ? Math.min(0.3, 6 / count) : 0;
    const pips = Math.min(cad.queued, MAX_PIPS);
    return (
        <div
            ref={ref}
            className={`orb ${state} cad-${look}`}
            aria-label={`Jarvis is ${caption.toLowerCase()}${cad.line && look !== 'idle' ? `: ${cad.line}` : ''}`}
        >
            <span className="sweep" aria-hidden="true" />
            <svg viewBox="0 0 200 200" aria-hidden="true">
                <defs>
                    <mask id={`${id}-seg`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
                        <circle cx="100" cy="100" r="86" fill="none" stroke="#fff" strokeWidth="8" pathLength={count}
                            strokeDasharray={gap ? `${1 - gap} ${gap}` : undefined} strokeDashoffset={-gap / 2} />
                    </mask>
                    <mask id={`${id}-chase`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
                        <circle className="chase-window" cx="100" cy="100" r="78" fill="none" stroke="#fff" strokeWidth="12"
                            strokeDasharray="70 420" />
                    </mask>
                </defs>
                <circle className="halo" cx="100" cy="100" r="92" />
                <g className="cad-ring" transform="rotate(-90 100 100)" mask={`url(#${id}-seg)`}>
                    <circle className="cad-track" cx="100" cy="100" r="86" />
                    {steps && (
                        <>
                            <circle className="cad-fill" cx="100" cy="100" r="86" pathLength={count}
                                style={{ strokeDasharray: `${steps.done} ${count + 1}` }} />
                            {steps.done < count && (
                                <circle className="cad-now" cx="100" cy="100" r="86" pathLength={count}
                                    strokeDasharray={`1 ${count + 1}`} strokeDashoffset={-steps.done} />
                            )}
                        </>
                    )}
                </g>
                <g className="tick-ring">
                    <circle className="ring ticks" cx="100" cy="100" r="78" />
                    <circle className="ring ticks-lit" cx="100" cy="100" r="78" mask={`url(#${id}-chase)`} />
                </g>
                <circle className="ring arc-a" cx="100" cy="100" r="66" />
                <circle className="ring arc-b" cx="100" cy="100" r="56" />
                <circle className="core" cx="100" cy="100" r="24" />
                {pips > 0 && (
                    <g className="pips">
                        {Array.from({ length: pips }, (_, i) => (
                            <circle key={i} cx={100 + 97 * Math.sin((i * 16 * Math.PI) / 180)} cy={100 - 97 * Math.cos((i * 16 * Math.PI) / 180)} r="2.4" />
                        ))}
                    </g>
                )}
            </svg>
            <span className="name">J.A.R.V.I.S.</span>
            <span className="caption">{caption}</span>
            {look !== 'idle' && cad.line && <span className="cad-line" title={cad.line}>{cad.line}</span>}
        </div>
    );
}
