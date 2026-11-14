// A selection box of the property manager (see pickField.ts): the list of picked edges and faces, and the hook
// that tells the view which box is active and where its clicks go.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from './menus';
import {
    clearPickSession, itemLabel, nextBox, pickItems, togglePickItem, usePickSession, type PickBox, type PickItem,
} from './pickField';
import type { P3 } from './picking';
import { valueText } from './numberText';
import type { Ctx, Field, ToolDef, Values } from './toolDefs';

const boxesOf = (fields: Field[]): PickBox[] => fields.filter((f) => f.kind === 'pick' || (f.kind === 'vec' && f.pickable)).map((f) => ({
    key: f.key,
    label: f.label,
    entities: f.entities ?? ['edge', 'face'],
    multi: !!f.multi,
    ...(f.flat ? { flat: true } : {}),
    ...(f.kind === 'vec' ? { position: true } : {}),
}));

/**
 * Publishes the form's selection boxes to the view while it is open: clicks on the part then go to the active box
 * (a click on an entry's entity removes it; a filled single box hands over to the next box).
 */
export function usePickBoxes(tool: ToolDef, ctx: Ctx, fields: Field[], values: Values, setValues: (v: Values) => void): void {
    const [owner] = useState(() => Symbol(tool.id));
    const latest = useRef({ values, ctx });
    latest.current = { values, ctx };
    const boxes = boxesOf(fields);
    const boxesKey = JSON.stringify(boxes);
    const partId = ctx.edit?.partId ?? ctx.part?.id ?? null;

    useEffect(() => {
        if (boxes.length === 0 || !partId) {
            clearPickSession(owner);
            return;
        }
        const current = usePickSession.getState();
        const keep = current.owner === owner && boxes.some((b) => b.key === current.active);
        // A position field becomes active only when focused; a selection box from the start.
        const first = boxes.find((b) => !b.position)?.key ?? null;
        const lists = boxes.filter((b) => !b.position);
        usePickSession.setState({
            owner,
            partId,
            boxes,
            active: keep ? current.active : first,
            items: Object.fromEntries(lists.map((b) => [b.key, pickItems(latest.current.values[b.key])])),
            hover: null,
            note: null,
            pick: (item: PickItem, same: (i: PickItem) => boolean) => {
                const session = usePickSession.getState();
                const box = session.boxes.find((b) => b.key === session.active);
                if (!box || !box.entities.includes(item.kind)) {
                    return;
                }
                const { values: v, ctx: c } = latest.current;
                const result = togglePickItem(pickItems(v[box.key]), item, same, box.multi);
                let next: Values = { ...v, [box.key]: result.items };
                next = { ...next, ...(tool.onChange?.(box.key, next, c) ?? {}) };
                latest.current = { ...latest.current, values: next };
                setValues(next);
                usePickSession.setState({ note: null, ...(result.advance ? { active: nextBox(lists, box.key) ?? box.key } : {}) });
            },
            place: (position: P3) => {
                const session = usePickSession.getState();
                const box = session.boxes.find((b) => b.key === session.active);
                if (!box?.position) {
                    return;
                }
                let next = latest.current.values;
                position.forEach((c, i) => {
                    const key = `${box.key}${i}`;
                    next = { ...next, [key]: valueText(c) };
                    next = { ...next, ...(tool.onChange?.(key, next, latest.current.ctx) ?? {}) };
                });
                latest.current = { ...latest.current, values: next };
                setValues(next);
                usePickSession.setState({ active: lists[0]?.key ?? null });
            },
        });
    }, [boxesKey, partId]);

    useEffect(() => {
        if (usePickSession.getState().owner === owner) {
            const lists = boxes.filter((b) => !b.position);
            usePickSession.setState({ items: Object.fromEntries(lists.map((b) => [b.key, pickItems(values[b.key])])) });
        }
    }, [values, boxesKey]);

    useEffect(() => () => clearPickSession(owner), []);
}

/** The selection box: one row per item, with a remove button; right-click for Delete and Clear selections. */
export function PickList(props: { field: Field; values: Values; change: (key: string, value: Values[string]) => void }) {
    const { field, values, change } = props;
    const items = pickItems(values[field.key]);
    const active = usePickSession((s) => s.active === field.key);
    const note = usePickSession((s) => (s.active === field.key ? s.note : null));
    const [menu, setMenu] = useState<{ x: number; y: number; row: number | null } | null>(null);
    const activate = () => usePickSession.setState({ active: field.key, note: null });
    const remove = (index: number) => {
        change(field.key, items.filter((_, i) => i !== index));
        usePickSession.setState({ hover: null });
    };
    const hover = (index: number | null) => usePickSession.setState({ hover: index === null ? null : { key: field.key, index } });
    const kinds = field.entities ?? ['edge', 'face'];
    const what = field.multi ? kinds.map((e) => `${e}s`).join(' or ') : `one ${field.flat ? 'flat ' : ''}${kinds.join(' or ')}`;
    return (
        <div className="tb-field pm-pick">
            <span>{field.label}</span>
            <ul
                className={`pm-contours pm-pick-list ${active ? 'active' : ''}`}
                aria-label={field.label}
                tabIndex={0}
                onClick={activate}
                onFocus={activate}
                onContextMenu={(event) => {
                    event.preventDefault();
                    activate();
                    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
                    setMenu({ x: event.clientX, y: event.clientY, row: row ? Number(row.dataset.row) : null });
                }}
            >
                {items.length === 0 && (
                    <li className="pm-contours-all">{active ? `Click ${what} in the view` : 'Click here, then in the view'}</li>
                )}
                {items.map((item, i) => {
                    const label = itemLabel(items, i);
                    return (
                        <li key={`${label}-${item.at.join(',')}`} data-row={i} onMouseEnter={() => hover(i)} onMouseLeave={() => hover(null)}>
                            <span>{label}</span>
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    remove(i);
                                }}
                                title="Remove from the selection"
                                aria-label={`Remove ${label}`}
                            >
                                ×
                            </button>
                        </li>
                    );
                })}
            </ul>
            {note && <p className="tb-note pm-pick-note">{note}</p>}
            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    onClose={() => setMenu(null)}
                    items={[
                        { label: 'Delete', disabled: menu.row === null, onSelect: () => menu.row !== null && remove(menu.row) },
                        { label: 'Clear selections', disabled: items.length === 0, onSelect: () => change(field.key, []) },
                    ]}
                />
            )}
        </div>
    );
}

/**
 * A position field that can be set from the view: focusing it makes it the target of the next click on the part
 * (pickRefs.positionFromPick: a circle's centre, a straight edge's midpoint or the clicked spot, a face's clicked
 * spot). Moving the focus to another field ends that; a click in the view does not.
 */
export function PositionTarget({ field, children }: { field: Field; children: ReactNode }) {
    const active = usePickSession((s) => s.active === field.key);
    return (
        <div
            className={`pm-position ${active ? 'active' : ''}`}
            onFocus={() => usePickSession.setState({ active: field.key, note: null })}
            onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && !event.currentTarget.contains(next) && usePickSession.getState().active === field.key) {
                    usePickSession.setState({ active: null });
                }
            }}
        >
            {children}
            {active && <p className="tb-note tb-hint">Click an edge or face in the view to set it.</p>}
        </div>
    );
}
