import { useEffect, useRef } from 'react';
import { level } from './audio';
import { useStudio } from './state';

/** The assistant's presence: rings that idle, spin faster while thinking and pulse with the voice. */
export function Orb() {
    const status = useStudio((s) => s.status);
    const speaking = useStudio((s) => s.speaking);
    const connected = useStudio((s) => s.connected);
    const ref = useRef<HTMLDivElement>(null);

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
    const caption = { offline: 'Offline', idle: 'Online', thinking: 'Thinking', working: 'Working', speaking: 'Speaking' }[state];
    return (
        <div ref={ref} className={`orb ${state}`} aria-label={`Jarvis is ${caption.toLowerCase()}`}>
            <svg viewBox="0 0 200 200">
                <circle className="halo" cx="100" cy="100" r="92" />
                <circle className="ring ticks" cx="100" cy="100" r="78" />
                <circle className="ring arc-a" cx="100" cy="100" r="66" />
                <circle className="ring arc-b" cx="100" cy="100" r="56" />
                <circle className="core" cx="100" cy="100" r="24" />
            </svg>
            <span className="name">J.A.R.V.I.S.</span>
            <span className="caption">{caption}</span>
        </div>
    );
}
