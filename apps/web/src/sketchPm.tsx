// A titled, collapsible block for PropertyManager bodies built by hand (the same look as the form sections).

import { useState, type ReactNode } from 'react';

export function PmSection({ title, children, open: initial = true }: { title: string; children: ReactNode; open?: boolean }) {
    const [open, setOpen] = useState(initial);
    return (
        <section className={`pm-section ${open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span>{title}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {open && <div className="pm-section-body">{children}</div>}
        </section>
    );
}
