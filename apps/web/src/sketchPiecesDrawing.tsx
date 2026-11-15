// The selected pieces of curves and the one under the pointer while Alt is held (sketchPieces.ts), drawn over the
// curves they lie on; and the keys: Alt shows or hides the piece without a pointer move, Escape lets the pieces go.

import { useEffect, useMemo } from 'react';
import { LineBatch } from './sketchBatch';
import { entityLine, PICKED, SELECTED } from './sketchShapes';
import { clearPieces, pieceKey, usePieces } from './sketchPieces';
import { useSketcher } from './sketcher';

export function PieceDrawing() {
    const hover = usePieces((p) => p.hover);
    const picked = usePieces((p) => p.picked);
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if (e.key === 'Alt') {
                pieceKey(e.type === 'keydown');
                // Some browsers open their menu bar when Alt alone is let go.
                if (e.type === 'keyup' && useSketcher.getState().active) {
                    e.preventDefault();
                }
            } else if (e.key === 'Escape' && e.type === 'keydown') {
                clearPieces();
            }
        };
        const away = () => pieceKey(false);
        window.addEventListener('keydown', key);
        window.addEventListener('keyup', key);
        window.addEventListener('blur', away);
        return () => {
            window.removeEventListener('keydown', key);
            window.removeEventListener('keyup', key);
            window.removeEventListener('blur', away);
            clearPieces();
        };
    }, []);
    const lines = useMemo(() => [
        ...picked.map((p) => ({ ...entityLine(p.entity, SELECTED, 4.2), renderOrder: 21 })),
        ...(hover ? [{ ...entityLine(hover, PICKED, 3.8), renderOrder: 22 }] : []),
    ], [hover, picked]);
    return <LineBatch lines={lines} />;
}
